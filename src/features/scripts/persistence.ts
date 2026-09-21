import { emptyWorkspace, normalizeWorkspace } from "@/features/scripts/workspace";
import { readStored, writeStored, type StoredWrite } from "@/lib/storage";
import {
  WORKSPACE_SCHEMA_VERSION,
  type PersistedFolderV2,
  type PersistedScriptV2,
  type PersistedWorkspaceV2,
  type ScriptDocument,
  type ScriptFolder,
  type WorkspaceState,
} from "@/types/workspace";

export const WORKSPACE_STORAGE_KEY = "nova.workspace";

/**
 * When stored data has to be dropped or cannot be read at all, the original
 * text is copied here first so the problem stays diagnosable and recoverable
 * instead of being overwritten by the next autosave.
 */
export const WORKSPACE_BACKUP_KEY = "nova.workspace.backup";

export function serializeWorkspace(state: WorkspaceState): PersistedWorkspaceV2 {
  return {
    version: WORKSPACE_SCHEMA_VERSION,
    scripts: state.scripts.map((script) => {
      const persisted: PersistedScriptV2 = {
        id: script.id,
        name: script.name,
        language: script.language,
        content: script.savedContent,
        folderId: script.folderId,
        isFavorite: script.isFavorite,
        createdAt: script.createdAt,
        updatedAt: script.updatedAt,
      };
      if (script.isDirty) persisted.draft = script.content;
      return persisted;
    }),
    folders: state.folders.map(
      (folder): PersistedFolderV2 => ({
        id: folder.id,
        name: folder.name,
        parentId: folder.parentId,
        createdAt: folder.createdAt,
        updatedAt: folder.updatedAt,
      }),
    ),
    openScriptIds: [...state.openScriptIds],
    activeScriptId: state.activeScriptId,
  };
}

export interface WorkspaceParseResult {
  state: WorkspaceState;
  /** Everything that was repaired or dropped, phrased for the log. */
  issues: string[];
  /** True when stored content was dropped rather than only repaired. */
  discardedData: boolean;
  /** Schema version the stored data was migrated from, or null when it was already current. */
  migratedFrom: number | null;
}

interface ParseContext {
  now: number;
  createId: () => string;
}

type StoredRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is StoredRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * One step per schema version, each producing the next version's shape. Steps
 * only add or rename fields; validation happens afterwards on the result.
 */
const MIGRATIONS: Readonly<Record<number, (stored: StoredRecord) => StoredRecord>> = {
  // v1 had no folders or favorites: every script lives at the root and is not a favorite.
  1: (stored) => ({
    ...stored,
    version: 2,
    scripts: Array.isArray(stored.scripts)
      ? stored.scripts.map((script: unknown) =>
          isRecord(script) ? { ...script, folderId: null, isFavorite: false } : script,
        )
      : stored.scripts,
    folders: [],
  }),
};

/** Upgrades older stored data to the current schema. Deterministic; returns null for versions it cannot read. */
export function migrateStoredWorkspace(stored: StoredRecord): { value: StoredRecord; from: number | null } | null {
  const from = stored.version;
  if (from === WORKSPACE_SCHEMA_VERSION) return { value: stored, from: null };
  if (typeof from !== "number" || !Number.isInteger(from) || from > WORKSPACE_SCHEMA_VERSION) return null;

  let value = stored;
  for (let version = from; version < WORKSPACE_SCHEMA_VERSION; version += 1) {
    const step = MIGRATIONS[version];
    if (!step) return null;
    value = step(value);
  }
  return { value, from };
}

function parseScript(
  value: unknown,
  position: number,
  context: ParseContext,
  issues: string[],
): ScriptDocument | null {
  if (!isRecord(value)) {
    issues.push(`dropped script #${position}: not an object`);
    return null;
  }

  const { id, name, language, content, draft, folderId, isFavorite, createdAt, updatedAt } = value;
  const hasName = typeof name === "string" && name.trim() !== "";
  const label = hasName ? `"${name.trim()}"` : `script #${position}`;

  if (typeof content !== "string") {
    issues.push(`dropped ${label}: content is missing`);
    return null;
  }

  let scriptId = typeof id === "string" && id !== "" ? id : null;
  if (scriptId === null) {
    scriptId = context.createId();
    issues.push(`${label} had no id and was given a new one`);
  }

  if (language !== undefined && language !== "lua") {
    issues.push(`${label} had unsupported language ${JSON.stringify(language)} and was opened as Lua`);
  }

  let buffer = content;
  if (typeof draft === "string") buffer = draft;
  else if (draft !== undefined) issues.push(`${label}: unreadable unsaved changes were ignored`);

  let location: string | null = null;
  if (typeof folderId === "string" && folderId !== "") location = folderId;
  else if (folderId !== null && folderId !== undefined) {
    issues.push(`${label} had an unreadable folder and was moved to the root`);
  }

  if (isFavorite !== undefined && typeof isFavorite !== "boolean") {
    issues.push(`${label}: unreadable favorite flag was reset`);
  }

  const created = isTimestamp(createdAt) ? createdAt : context.now;

  return {
    id: scriptId,
    name: hasName ? name.trim() : `Recovered ${position}.lua`,
    language: "lua",
    content: buffer,
    savedContent: content,
    isDirty: buffer !== content,
    folderId: location,
    isFavorite: isFavorite === true,
    createdAt: created,
    updatedAt: isTimestamp(updatedAt) ? updatedAt : created,
  };
}

function parseFolder(
  value: unknown,
  position: number,
  context: ParseContext,
  issues: string[],
): ScriptFolder | null {
  if (!isRecord(value)) {
    issues.push(`dropped folder #${position}: not an object`);
    return null;
  }

  const { id, name, parentId, createdAt, updatedAt } = value;
  let folderName = typeof name === "string" ? name.trim() : "";
  const label = folderName === "" ? `folder #${position}` : `folder "${folderName}"`;

  let folderId = typeof id === "string" && id !== "" ? id : null;
  if (folderId === null) {
    folderId = context.createId();
    issues.push(`${label} had no id and was given a new one`);
  }

  if (folderName === "") {
    folderName = `Recovered Folder ${position}`;
    issues.push(`folder #${position} had no name and was named "${folderName}"`);
  }

  let parent: string | null = null;
  if (typeof parentId === "string" && parentId !== "") parent = parentId;
  else if (parentId !== null && parentId !== undefined) {
    issues.push(`${label} had an unreadable parent and was moved to the root`);
  }

  const created = isTimestamp(createdAt) ? createdAt : context.now;

  return {
    id: folderId,
    name: folderName,
    parentId: parent,
    createdAt: created,
    updatedAt: isTimestamp(updatedAt) ? updatedAt : created,
  };
}

/** Parses a stored list, giving entries whose id is already taken a new one. */
function parseEntries<T extends { id: string; name: string }>(
  entries: readonly unknown[],
  kind: "script" | "folder",
  parse: (value: unknown, position: number) => T | null,
  context: ParseContext,
  issues: string[],
): { items: T[]; dropped: boolean } {
  const items: T[] = [];
  const ids = new Set<string>();
  let dropped = false;

  entries.forEach((entry, index) => {
    const item = parse(entry, index + 1);
    if (!item) {
      dropped = true;
      return;
    }
    if (ids.has(item.id)) {
      const previous = item.id;
      item.id = context.createId();
      issues.push(`${kind} "${item.name}" shared id ${previous} with another ${kind} and was given a new one`);
    }
    ids.add(item.id);
    items.push(item);
  });

  return { items, dropped };
}

/**
 * Validates stored workspace data, migrating older schema versions first.
 * Malformed pieces are repaired where the user's content can be kept
 * (missing ids, duplicate ids, dangling tab or folder references, folder
 * cycles) and dropped only when there is nothing usable left.
 */
export function parseWorkspace(value: unknown, context: ParseContext): WorkspaceParseResult {
  const failed = (issue: string): WorkspaceParseResult => ({
    state: emptyWorkspace,
    issues: [issue],
    discardedData: true,
    migratedFrom: null,
  });

  if (!isRecord(value)) return failed("stored workspace is not an object");

  const migration = migrateStoredWorkspace(value);
  if (!migration) return failed(`unsupported workspace version ${JSON.stringify(value.version)}`);

  const stored = migration.value;
  if (!Array.isArray(stored.scripts)) return failed("stored workspace has no script list");

  const issues: string[] = [];
  let discardedData = false;

  const scripts = parseEntries(
    stored.scripts,
    "script",
    (entry, position) => parseScript(entry, position, context, issues),
    context,
    issues,
  );

  let storedFolders: readonly unknown[] = [];
  if (Array.isArray(stored.folders)) storedFolders = stored.folders;
  else if (stored.folders !== undefined) {
    issues.push("folder list was unreadable; its scripts were moved to the root");
    discardedData = true;
  }

  const folders = parseEntries(
    storedFolders,
    "folder",
    (entry, position) => parseFolder(entry, position, context, issues),
    context,
    issues,
  );
  discardedData ||= scripts.dropped || folders.dropped;

  const storedOpen: unknown[] = Array.isArray(stored.openScriptIds) ? stored.openScriptIds : [];
  if (!Array.isArray(stored.openScriptIds)) issues.push("open tab list was missing and has been reset");
  const openScriptIds: string[] = [];
  for (const id of storedOpen) {
    if (typeof id === "string") openScriptIds.push(id);
    else issues.push(`removed invalid open tab reference ${JSON.stringify(id)}`);
  }

  let activeScriptId: string | null = null;
  if (typeof stored.activeScriptId === "string") activeScriptId = stored.activeScriptId;
  else if (stored.activeScriptId !== null && stored.activeScriptId !== undefined) {
    issues.push(`active script ${JSON.stringify(stored.activeScriptId)} is not valid; selected another tab`);
  }

  const normalized = normalizeWorkspace({
    scripts: scripts.items,
    folders: folders.items,
    openScriptIds,
    activeScriptId,
  });

  return {
    state: normalized.state,
    issues: [...issues, ...normalized.issues],
    discardedData,
    migratedFrom: migration.from,
  };
}

export type WorkspaceLoadResult =
  | { status: "missing" }
  | { status: "loaded"; raw: string; result: WorkspaceParseResult }
  | { status: "unreadable"; raw: string | null; error: unknown };

/** Reads the stored workspace. Has no side effects; callers decide what to log or back up. */
export function loadWorkspace(context: ParseContext): WorkspaceLoadResult {
  const read = readStored(WORKSPACE_STORAGE_KEY);
  if (read.status !== "found") return read;
  return { status: "loaded", raw: read.raw, result: parseWorkspace(read.value, context) };
}

export type WorkspaceSaveResult =
  | { status: "saved"; raw: string }
  | { status: "unchanged" }
  | { status: "failed"; error: unknown };

/**
 * Persists the workspace. When `previousRaw` matches the serialized state the
 * write is skipped, so debounced autosaves after UI-only changes cost nothing.
 */
export function saveWorkspace(state: WorkspaceState, previousRaw: string | null = null): WorkspaceSaveResult {
  let raw: string;
  try {
    raw = JSON.stringify(serializeWorkspace(state));
  } catch (error) {
    return { status: "failed", error };
  }

  if (raw === previousRaw) return { status: "unchanged" };

  const write = writeStored(WORKSPACE_STORAGE_KEY, raw);
  return write.ok ? { status: "saved", raw } : { status: "failed", error: write.error };
}

export function backupWorkspace(raw: string): StoredWrite {
  return writeStored(WORKSPACE_BACKUP_KEY, raw);
}

export type WriteTrigger = "autosave" | "flush";

/**
 * What to do about a write when the stored data it would replace had to be
 * discarded and could not be copied to {@link WORKSPACE_BACKUP_KEY} first.
 *
 * The stored text is at that moment the only copy of the user's scripts, and
 * the unattended 750 ms autosave is the thing that would destroy it — so the
 * autosave holds off. An explicit save and the flush as the window closes do
 * not: by then the choice is between data Nova could not read and the work the
 * user has done since, and silently refusing to save that work would be the
 * worse loss of the two.
 */
export function decideUnbackedWrite(trigger: WriteTrigger, backedUpNow: boolean): "proceed" | "hold" | "replace" {
  if (backedUpNow) return "proceed";
  return trigger === "autosave" ? "hold" : "replace";
}
