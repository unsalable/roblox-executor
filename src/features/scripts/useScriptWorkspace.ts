import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createDiagnosticLog } from "@/features/diagnostics/diagnostics";
import {
  backupWorkspace,
  decideUnbackedWrite,
  loadWorkspace,
  saveWorkspace,
  WORKSPACE_BACKUP_KEY,
  type WriteTrigger,
} from "@/features/scripts/persistence";
import {
  closeScript as closeScriptIn,
  createFolder as createFolderIn,
  createScript as createScriptIn,
  createWorkspaceId,
  deleteFolder as deleteFolderIn,
  deleteScript as deleteScriptIn,
  discardChanges as discardChangesIn,
  duplicateScript as duplicateScriptIn,
  emptyWorkspace,
  findFolder,
  findScript,
  moveScript as moveScriptIn,
  openScript as openScriptIn,
  renameFolder as renameFolderIn,
  renameScript as renameScriptIn,
  saveAllScripts,
  saveScript as saveScriptIn,
  setActiveScript as setActiveScriptIn,
  toggleFavorite as toggleFavoriteIn,
  updateScriptContent,
  type NameValidation,
  type TransitionResult,
} from "@/features/scripts/workspace";
import { WORKSPACE_SCHEMA_VERSION, type ScriptDocument, type ScriptFolder, type WorkspaceState } from "@/types/workspace";

/** Workspace messages go to the one log stream, tagged so they can be found among the rest. */
const log = createDiagnosticLog("Workspace", "scriptWorkspace");

/** Quiet period after the last change before the workspace is written. */
const AUTOSAVE_DELAY_MS = 750;

export type FolderCreation = { ok: true; id: string; name: string } | { ok: false; reason: string };

export interface ScriptWorkspace extends WorkspaceState {
  activeScript: ScriptDocument | null;
  /** Latest state, including changes not rendered yet. */
  getState: () => WorkspaceState;
  getScript: (id: string) => ScriptDocument | undefined;
  getFolder: (id: string) => ScriptFolder | undefined;
  /** Creates, opens and activates a new script in a folder (the root by default). Returns its id, or null on failure. */
  createScript: (folderId?: string | null) => string | null;
  /** Copies a script and opens the copy as the active tab. Returns the copy's id, or null on failure. */
  duplicateScript: (id: string) => string | null;
  openScript: (id: string) => void;
  closeScript: (id: string) => void;
  setActiveScript: (id: string) => void;
  updateContent: (id: string, content: string) => void;
  /** Saves one script and persists the workspace immediately. */
  saveScript: (id: string) => boolean;
  /** Saves every script with unsaved changes in one write. */
  saveAll: () => boolean;
  /** Restores a script's saved content and persists the workspace immediately. */
  discardChanges: (id: string) => boolean;
  renameScript: (id: string, name: string) => NameValidation;
  moveScript: (id: string, folderId: string | null) => boolean;
  toggleFavorite: (id: string) => void;
  deleteScript: (id: string) => void;
  createFolder: (name: string, parentId: string | null) => FolderCreation;
  renameFolder: (id: string, name: string) => NameValidation;
  /** Deletes a folder; its contents move to the folder's parent. */
  deleteFolder: (id: string) => void;
  /** Writes pending changes now instead of waiting for autosave. */
  flush: () => boolean;
}

type LoadReport =
  | { kind: "first-run" }
  | { kind: "loaded"; raw: string; issues: string[]; discardedData: boolean; migratedFrom: number | null }
  | { kind: "unreadable"; raw: string | null; error: unknown };

interface Boot {
  state: WorkspaceState;
  /** Stored text the state was read from; lets the first autosave skip an identical write. */
  raw: string | null;
  report: LoadReport;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Pure apart from reading storage, so StrictMode can run it twice safely. */
function bootWorkspace(): Boot {
  const now = Date.now();
  const load = loadWorkspace({ now, createId: createWorkspaceId });

  switch (load.status) {
    case "missing":
      return {
        state: createScriptIn(emptyWorkspace, { id: createWorkspaceId(), now, name: "Main.lua" }),
        raw: null,
        report: { kind: "first-run" },
      };
    case "unreadable":
      return { state: emptyWorkspace, raw: null, report: { kind: "unreadable", raw: load.raw, error: load.error } };
    case "loaded": {
      const { state, issues, discardedData, migratedFrom } = load.result;
      return {
        // Repaired or migrated data differs from what is stored, so the first autosave must write it.
        state,
        raw: issues.length === 0 && migratedFrom === null ? load.raw : null,
        report: { kind: "loaded", raw: load.raw, issues, discardedData, migratedFrom },
      };
    }
  }
}

/**
 * Logs what loading found, and copies data that is about to be replaced to the
 * backup key first.
 *
 * Returns the stored text whose backup *failed*, or null. That text is at that
 * moment the only copy of the user's scripts, and the caller has to keep the
 * autosave from writing over it.
 */
function reportLoad(boot: Boot): string | null {
  const { report, state } = boot;
  let unbacked: string | null = null;

  const backup = (raw: string | null) => {
    if (raw === null) return;
    const result = backupWorkspace(raw);
    if (result.ok) log.warn(`The previous workspace data was copied to "${WORKSPACE_BACKUP_KEY}"`);
    else {
      log.error("The previous workspace data could not be backed up", result.error);
      unbacked = raw;
    }
  };

  if (report.kind === "first-run") {
    log.info("New workspace created with Main.lua");
    return unbacked;
  }

  if (report.kind === "unreadable") {
    log.error("Stored workspace could not be read; starting with an empty workspace", report.error);
    backup(report.raw);
    return unbacked;
  }

  if (report.migratedFrom !== null) {
    log.info(`Workspace migrated from v${report.migratedFrom} to v${WORKSPACE_SCHEMA_VERSION}`);
  }

  if (report.issues.length > 0) {
    log.warn(`Stored workspace needed repairs: ${report.issues.join("; ")}`);
    if (report.discardedData) backup(report.raw);
  }

  const folders = state.folders.length === 0 ? "" : `, ${plural(state.folders.length, "folder")}`;
  log.info(
    `Workspace loaded: ${plural(state.scripts.length, "script")}${folders}, ${state.openScriptIds.length} open`,
  );
  return unbacked;
}

const locationLabel = (folder: ScriptFolder | undefined) => (folder ? `"${folder.name}"` : "the workspace root");

/**
 * The script workspace: every saved script, the folders, the open tabs and the
 * active tab, modelled together so a transition can never leave them
 * inconsistent. Components render from it; none of them keeps its own copy.
 *
 * `stateRef` always holds the latest state synchronously, which lets a manual
 * save write to storage first and commit only when the write succeeded.
 */
export function useScriptWorkspace(): ScriptWorkspace {
  const [boot] = useState(bootWorkspace);
  const [state, setState] = useState(boot.state);
  const stateRef = useRef(state);
  const persistedRaw = useRef(boot.raw);
  const autosaveFailing = useRef(false);
  const reported = useRef(false);
  /**
   * Stored data that had to be replaced but could not be copied to the backup
   * key first — the only copy of the user's scripts, until it is backed up or
   * deliberately replaced. See `guardUnbacked`.
   */
  const unbackedRaw = useRef<string | null>(null);

  const commit = useCallback((next: WorkspaceState) => {
    if (next === stateRef.current) return;
    stateRef.current = next;
    setState(next);
  }, []);

  /**
   * True when a write may go ahead. It tries the failed backup again first, so
   * the hold lifts by itself as soon as storage has room; only the unattended
   * autosave is ever held, and it is held to keep it from destroying data Nova
   * could not read and could not copy.
   */
  const guardUnbacked = useCallback((trigger: WriteTrigger): boolean => {
    const raw = unbackedRaw.current;
    if (raw === null) return true;

    switch (decideUnbackedWrite(trigger, backupWorkspace(raw).ok)) {
      case "proceed":
        unbackedRaw.current = null;
        log.warn(`The previous workspace data was copied to "${WORKSPACE_BACKUP_KEY}"`);
        return true;
      case "hold":
        return false;
      case "replace":
        unbackedRaw.current = null;
        log.error("Replacing stored workspace data that could not be backed up");
        return true;
    }
  }, []);

  const persist = useCallback((trigger: WriteTrigger): boolean => {
    if (!guardUnbacked(trigger)) return false;
    const result = saveWorkspace(stateRef.current, persistedRaw.current);

    if (result.status === "failed") {
      if (!autosaveFailing.current) log.error("Workspace could not be written to local storage", result.error);
      autosaveFailing.current = true;
      return false;
    }

    if (result.status === "saved") persistedRaw.current = result.raw;
    if (autosaveFailing.current && trigger === "autosave") log.info("Workspace storage is writable again");
    autosaveFailing.current = false;
    return true;
  }, [guardUnbacked]);

  /** Writes `next` first and commits it only when the write succeeded, so "saved" always means persisted. */
  const commitPersisted = useCallback(
    (next: WorkspaceState): { ok: true } | { ok: false; error: unknown } => {
      // An explicit save is never held: the user asked for this one.
      guardUnbacked("flush");
      const result = saveWorkspace(next, persistedRaw.current);
      if (result.status === "failed") return { ok: false, error: result.error };
      if (result.status === "saved") persistedRaw.current = result.raw;
      autosaveFailing.current = false;
      commit(next);
      return { ok: true };
    },
    [commit, guardUnbacked],
  );

  useEffect(() => {
    if (reported.current) return;
    reported.current = true;
    // Declared before the autosave effect, so this runs first on mount and the
    // guard is in place well before the first 750 ms timer can fire.
    unbackedRaw.current = reportLoad(boot);
  }, [boot]);

  useEffect(() => {
    const timer = window.setTimeout(() => persist("autosave"), AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [state, persist]);

  useEffect(() => {
    const flush = () => persist("flush");
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flush();
    };

    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [persist]);

  const getState = useCallback(() => stateRef.current, []);
  const getScript = useCallback((id: string) => findScript(stateRef.current, id), []);
  const getFolder = useCallback((id: string) => findFolder(stateRef.current, id), []);
  const flush = useCallback(() => persist("flush"), [persist]);

  const createScript = useCallback(
    (folderId: string | null = null) => {
      try {
        const id = createWorkspaceId();
        const next = createScriptIn(stateRef.current, { id, now: Date.now(), folderId });
        commit(next);
        const name = findScript(next, id)?.name ?? "script";
        const folder = folderId === null ? undefined : findFolder(next, folderId);
        log.info(folder ? `Created script "${name}" in "${folder.name}"` : `Created script "${name}"`);
        return id;
      } catch (error) {
        log.error("Script could not be created", error);
        return null;
      }
    },
    [commit],
  );

  const duplicateScript = useCallback(
    (id: string) => {
      const current = stateRef.current;
      const source = findScript(current, id);
      if (!source) {
        log.warn("Duplicate requested for a script that no longer exists");
        return null;
      }

      try {
        const copyId = createWorkspaceId();
        const next = duplicateScriptIn(current, id, { id: copyId, now: Date.now() });
        commit(next);
        log.info(`Duplicated "${source.name}" as "${findScript(next, copyId)?.name}"`);
        return copyId;
      } catch (error) {
        log.error(`"${source.name}" could not be duplicated`, error);
        return null;
      }
    },
    [commit],
  );

  const openScript = useCallback((id: string) => commit(openScriptIn(stateRef.current, id)), [commit]);

  const closeScript = useCallback((id: string) => commit(closeScriptIn(stateRef.current, id)), [commit]);

  const setActiveScript = useCallback(
    (id: string) => commit(setActiveScriptIn(stateRef.current, id)),
    [commit],
  );

  const updateContent = useCallback(
    (id: string, content: string) => commit(updateScriptContent(stateRef.current, id, content)),
    [commit],
  );

  const saveScript = useCallback(
    (id: string) => {
      const current = stateRef.current;
      const script = findScript(current, id);
      if (!script) {
        log.warn("Save requested for a script that no longer exists");
        return false;
      }

      const result = commitPersisted(saveScriptIn(current, id, Date.now()));
      if (!result.ok) {
        log.error(`"${script.name}" could not be saved; changes are still in the editor`, result.error);
        return false;
      }
      if (script.isDirty) log.info(`Saved "${script.name}"`);
      return true;
    },
    [commitPersisted],
  );

  const saveAll = useCallback(() => {
    const current = stateRef.current;
    const dirty = current.scripts.filter((script) => script.isDirty);
    if (dirty.length === 0) return true;

    const result = commitPersisted(saveAllScripts(current, Date.now()));
    if (!result.ok) {
      log.error("Unsaved scripts could not be saved; changes are still in the editor", result.error);
      return false;
    }
    log.info(dirty.length === 1 ? `Saved "${dirty[0]!.name}"` : `Saved ${dirty.length} scripts`);
    return true;
  }, [commitPersisted]);

  const discardChanges = useCallback(
    (id: string) => {
      const script = findScript(stateRef.current, id);
      if (!script) return false;
      if (!script.isDirty) return true;

      commit(discardChangesIn(stateRef.current, id));
      persist("flush");
      log.info(`Discarded changes in "${script.name}"`);
      return true;
    },
    [commit, persist],
  );

  const renameScript = useCallback(
    (id: string, name: string): NameValidation => {
      const current = stateRef.current;
      const previous = findScript(current, id)?.name;
      const result = renameScriptIn(current, id, name, Date.now());
      if (!result.ok) return result;

      const renamed = findScript(result.state, id)!.name;
      if (result.state !== current) {
        commit(result.state);
        log.info(`Renamed "${previous}" to "${renamed}"`);
      }
      return { ok: true, name: renamed };
    },
    [commit],
  );

  const moveScript = useCallback(
    (id: string, folderId: string | null) => {
      const current = stateRef.current;
      const result = moveScriptIn(current, id, folderId, Date.now());
      if (!result.ok) {
        log.warn(`Script could not be moved: ${result.reason}`);
        return false;
      }
      if (result.state !== current) {
        commit(result.state);
        const name = findScript(current, id)?.name;
        const folder = folderId === null ? undefined : findFolder(current, folderId);
        log.info(`Moved "${name}" to ${locationLabel(folder)}`);
      }
      return true;
    },
    [commit],
  );

  const toggleFavorite = useCallback((id: string) => commit(toggleFavoriteIn(stateRef.current, id)), [commit]);

  const deleteScript = useCallback(
    (id: string) => {
      const script = findScript(stateRef.current, id);
      if (!script) return;
      commit(deleteScriptIn(stateRef.current, id));
      log.info(`Deleted "${script.name}"${script.isDirty ? " (including unsaved changes)" : ""}`);
    },
    [commit],
  );

  const createFolder = useCallback(
    (name: string, parentId: string | null): FolderCreation => {
      const id = createWorkspaceId();
      let result: TransitionResult;
      try {
        result = createFolderIn(stateRef.current, { id, now: Date.now(), name, parentId });
      } catch (error) {
        log.error("Folder could not be created", error);
        return { ok: false, reason: "The folder could not be created." };
      }
      if (!result.ok) return result;

      commit(result.state);
      const folder = findFolder(result.state, id)!;
      log.info(`Created folder "${folder.name}"`);
      return { ok: true, id, name: folder.name };
    },
    [commit],
  );

  const renameFolder = useCallback(
    (id: string, name: string): NameValidation => {
      const current = stateRef.current;
      const previous = findFolder(current, id)?.name;
      const result = renameFolderIn(current, id, name, Date.now());
      if (!result.ok) return result;

      const renamed = findFolder(result.state, id)!.name;
      if (result.state !== current) {
        commit(result.state);
        log.info(`Renamed folder "${previous}" to "${renamed}"`);
      }
      return { ok: true, name: renamed };
    },
    [commit],
  );

  const deleteFolder = useCallback(
    (id: string) => {
      const current = stateRef.current;
      const folder = findFolder(current, id);
      if (!folder) return;

      const next = deleteFolderIn(current, id);
      commit(next);

      const moved =
        current.scripts.filter((script) => script.folderId === id).length +
        current.folders.filter((child) => child.parentId === id).length;
      const destination = locationLabel(folder.parentId === null ? undefined : findFolder(current, folder.parentId));
      log.info(
        moved === 0
          ? `Deleted folder "${folder.name}"`
          : `Deleted folder "${folder.name}" and moved ${plural(moved, "item")} to ${destination}`,
      );

      for (const child of next.folders) {
        const before = findFolder(current, child.id);
        if (before && before.name !== child.name) {
          log.info(`Renamed folder "${before.name}" to "${child.name}" to avoid a name clash`);
        }
      }
    },
    [commit],
  );

  return useMemo(
    () => ({
      ...state,
      activeScript: state.activeScriptId === null ? null : (findScript(state, state.activeScriptId) ?? null),
      getState,
      getScript,
      getFolder,
      createScript,
      duplicateScript,
      openScript,
      closeScript,
      setActiveScript,
      updateContent,
      saveScript,
      saveAll,
      discardChanges,
      renameScript,
      moveScript,
      toggleFavorite,
      deleteScript,
      createFolder,
      renameFolder,
      deleteFolder,
      flush,
    }),
    [
      state,
      getState,
      getScript,
      getFolder,
      createScript,
      duplicateScript,
      openScript,
      closeScript,
      setActiveScript,
      updateContent,
      saveScript,
      saveAll,
      discardChanges,
      renameScript,
      moveScript,
      toggleFavorite,
      deleteScript,
      createFolder,
      renameFolder,
      deleteFolder,
      flush,
    ],
  );
}
