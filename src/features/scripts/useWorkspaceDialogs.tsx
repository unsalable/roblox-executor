import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { MoveScriptDialog } from "@/features/scripts/MoveScriptDialog";
import { NewFolderDialog } from "@/features/scripts/NewFolderDialog";
import { buildWorkspaceTree, countFolderContents, listFolderDestinations } from "@/features/scripts/tree";
import type { ScriptWorkspace } from "@/features/scripts/useScriptWorkspace";
import { nextFolderName } from "@/features/scripts/workspace";

type PendingDialog =
  | { kind: "close-script"; scriptId: string }
  | { kind: "close-window" }
  | { kind: "delete-script"; scriptId: string }
  | { kind: "delete-folder"; folderId: string }
  | { kind: "discard-changes"; scriptId: string }
  | { kind: "new-folder"; parentId: string | null }
  | { kind: "move-script"; scriptId: string };

interface WorkspaceDialogOptions {
  workspace: ScriptWorkspace;
  /** Settings › General › Confirm before closing; see `Settings["general"]["confirmOnExit"]`. */
  confirmBeforeClosing: boolean;
  /** Called after a script's buffer was reset outside the editor, so an open editor model can follow. */
  onContentReset: (scriptId: string) => void;
  /** Actually closes the application window. */
  onCloseWindow: () => void;
}

/**
 * Every workspace operation that needs a confirmation or a prompt goes through
 * here — from the sidebar, the tab bar, keyboard shortcuts and the title bar —
 * so the rules (when to ask, what each choice does) live in one place and
 * only one dialog can be open at a time.
 */
export interface WorkspaceDialogs {
  /** Closes a tab, asking first when it has unsaved changes and the setting is on. */
  requestCloseScript: (id: string) => void;
  /** Closes the window, asking first when scripts have unsaved changes and the setting is on. */
  requestCloseWindow: () => void;
  requestDeleteScript: (id: string) => void;
  requestDeleteFolder: (id: string) => void;
  requestDiscardChanges: (id: string) => void;
  requestNewFolder: (parentId: string | null) => void;
  requestMoveScript: (id: string) => void;
  isOpen: boolean;
  /** Render once, anywhere outside hidden containers. */
  dialog: ReactNode;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function useWorkspaceDialogs({
  workspace,
  confirmBeforeClosing,
  onContentReset,
  onCloseWindow,
}: WorkspaceDialogOptions): WorkspaceDialogs {
  const [pending, setPending] = useState<PendingDialog | null>(null);
  const {
    getState,
    getScript,
    getFolder,
    closeScript,
    saveScript,
    saveAll,
    discardChanges,
    deleteScript,
    deleteFolder,
    createFolder,
    moveScript,
    flush,
  } = workspace;

  const dismiss = useCallback(() => setPending(null), []);

  const requestCloseScript = useCallback(
    (id: string) => {
      const script = getScript(id);
      if (!script) return;
      // With the setting off, a dirty tab still closes without losing anything: its buffer stays in the workspace as a draft.
      if (script.isDirty && confirmBeforeClosing) setPending({ kind: "close-script", scriptId: id });
      else closeScript(id);
    },
    [getScript, closeScript, confirmBeforeClosing],
  );

  const requestCloseWindow = useCallback(() => {
    const hasUnsaved = getState().scripts.some((script) => script.isDirty);
    if (hasUnsaved && confirmBeforeClosing) {
      setPending({ kind: "close-window" });
      return;
    }
    flush();
    onCloseWindow();
  }, [getState, flush, onCloseWindow, confirmBeforeClosing]);

  const requestDeleteScript = useCallback(
    (id: string) => {
      if (getScript(id)) setPending({ kind: "delete-script", scriptId: id });
    },
    [getScript],
  );

  const requestDeleteFolder = useCallback(
    (id: string) => {
      if (getFolder(id)) setPending({ kind: "delete-folder", folderId: id });
    },
    [getFolder],
  );

  const requestDiscardChanges = useCallback(
    (id: string) => {
      if (getScript(id)?.isDirty) setPending({ kind: "discard-changes", scriptId: id });
    },
    [getScript],
  );

  const requestNewFolder = useCallback((parentId: string | null) => setPending({ kind: "new-folder", parentId }), []);

  const requestMoveScript = useCallback(
    (id: string) => {
      if (getScript(id)) setPending({ kind: "move-script", scriptId: id });
    },
    [getScript],
  );

  const { scripts, folders } = workspace;

  const dialog = useMemo((): ReactNode => {
    if (!pending) return null;

    switch (pending.kind) {
      case "close-script": {
        const script = scripts.find((candidate) => candidate.id === pending.scriptId);
        if (!script) return null;
        const id = script.id;
        return (
          <ConfirmDialog
            open
            title="Unsaved changes"
            confirmLabel="Save"
            onCancel={dismiss}
            onConfirm={() => {
              setPending(null);
              if (saveScript(id)) closeScript(id);
            }}
            secondary={{
              label: "Discard",
              destructive: true,
              onSelect: () => {
                setPending(null);
                discardChanges(id);
                closeScript(id);
              },
            }}
          >
            <p>
              <strong className="font-medium text-foreground">"{script.name}"</strong> has unsaved changes. Save them
              before closing the tab, or discard them.
            </p>
          </ConfirmDialog>
        );
      }

      case "close-window": {
        const dirty = scripts.filter((script) => script.isDirty);
        const names = dirty.slice(0, 3).map((script) => `"${script.name}"`);
        const more = dirty.length > 3 ? ` and ${dirty.length - 3} more` : "";
        return (
          <ConfirmDialog
            open
            title="Unsaved changes"
            confirmLabel="Save All & Close"
            onCancel={dismiss}
            onConfirm={() => {
              setPending(null);
              if (saveAll()) onCloseWindow();
            }}
            secondary={{
              label: "Close Without Saving",
              onSelect: () => {
                setPending(null);
                flush();
                onCloseWindow();
              },
            }}
          >
            <p>
              {plural(dirty.length, "script")} {dirty.length === 1 ? "has" : "have"} unsaved changes: {names.join(", ")}
              {more}.
            </p>
            <p className="mt-2">
              Scripts you do not save keep their changes as drafts and are restored the next time Nova opens.
            </p>
          </ConfirmDialog>
        );
      }

      case "delete-script": {
        const script = scripts.find((candidate) => candidate.id === pending.scriptId);
        if (!script) return null;
        return (
          <ConfirmDialog
            open
            title={`Delete "${script.name}"?`}
            confirmLabel="Delete"
            destructive
            onCancel={dismiss}
            onConfirm={() => {
              setPending(null);
              deleteScript(script.id);
            }}
          >
            {script.isDirty ? (
              <p>
                <strong className="font-medium text-warning">This script has unsaved changes.</strong> Deleting it will
                remove the unsaved work. This cannot be undone.
              </p>
            ) : (
              <p>The script is removed from this workspace. This cannot be undone.</p>
            )}
          </ConfirmDialog>
        );
      }

      case "delete-folder": {
        const folder = folders.find((candidate) => candidate.id === pending.folderId);
        if (!folder) return null;
        const contents = countFolderContents(scripts, folders, folder.id);
        const isEmpty = contents.scripts === 0 && contents.folders === 0;
        const parent = folder.parentId === null ? undefined : folders.find((item) => item.id === folder.parentId);
        const destination = parent ? `into "${parent.name}"` : "to the workspace root";
        const parts = [
          contents.scripts > 0 ? plural(contents.scripts, "script") : null,
          contents.folders > 0 ? plural(contents.folders, "folder") : null,
        ].filter(Boolean);
        return (
          <ConfirmDialog
            open
            title={`Delete folder "${folder.name}"?`}
            confirmLabel={isEmpty ? "Delete" : "Move & Delete"}
            destructive={isEmpty}
            onCancel={dismiss}
            onConfirm={() => {
              setPending(null);
              deleteFolder(folder.id);
            }}
          >
            {isEmpty ? (
              <p>The folder is empty. Deleting it does not affect any scripts.</p>
            ) : (
              <p>
                <strong className="font-medium text-foreground">This folder isn't empty.</strong> Its {parts.join(" and ")}{" "}
                will be moved {destination}, then the folder is deleted. No scripts are deleted.
              </p>
            )}
          </ConfirmDialog>
        );
      }

      case "discard-changes": {
        const script = scripts.find((candidate) => candidate.id === pending.scriptId);
        if (!script) return null;
        return (
          <ConfirmDialog
            open
            title="Discard changes?"
            confirmLabel="Discard"
            destructive
            onCancel={dismiss}
            onConfirm={() => {
              setPending(null);
              if (discardChanges(script.id)) onContentReset(script.id);
            }}
          >
            <p>Unsaved changes in "{script.name}" will be lost. The script returns to its last saved version.</p>
          </ConfirmDialog>
        );
      }

      case "new-folder": {
        const { parentId } = pending;
        const parent = parentId === null ? undefined : folders.find((folder) => folder.id === parentId);
        if (parentId !== null && !parent) return null;
        return (
          <NewFolderDialog
            suggestedName={nextFolderName(folders, parentId)}
            parentName={parent?.name ?? null}
            onCreate={(name) => createFolder(name, parentId)}
            onClose={dismiss}
          />
        );
      }

      case "move-script": {
        const script = scripts.find((candidate) => candidate.id === pending.scriptId);
        if (!script) return null;
        return (
          <MoveScriptDialog
            script={script}
            destinations={listFolderDestinations(buildWorkspaceTree([], folders))}
            onClose={dismiss}
            onMove={(folderId) => {
              setPending(null);
              moveScript(script.id, folderId);
            }}
          />
        );
      }
    }
  }, [
    pending,
    scripts,
    folders,
    dismiss,
    saveScript,
    saveAll,
    closeScript,
    discardChanges,
    deleteScript,
    deleteFolder,
    createFolder,
    moveScript,
    flush,
    onCloseWindow,
    onContentReset,
  ]);

  return {
    requestCloseScript,
    requestCloseWindow,
    requestDeleteScript,
    requestDeleteFolder,
    requestDiscardChanges,
    requestNewFolder,
    requestMoveScript,
    isOpen: dialog !== null,
    dialog,
  };
}
