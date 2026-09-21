import { useRef } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import type { FolderDestination } from "@/features/scripts/tree";
import type { ScriptDocument } from "@/types/workspace";

interface MoveScriptDialogProps {
  script: ScriptDocument;
  destinations: readonly FolderDestination[];
  onMove: (folderId: string | null) => void;
  onClose: () => void;
}

/** "Move to…" picker: the workspace root and every folder in tree order. The current location is disabled. */
export function MoveScriptDialog({ script, destinations, onMove, onClose }: MoveScriptDialogProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const firstChoiceRef = useRef<HTMLButtonElement>(null);

  const options: { id: string | null; label: string; depth: number; title: string }[] = [
    { id: null, label: "Workspace root", depth: 0, title: "Workspace root" },
    ...destinations.map((entry) => ({
      id: entry.folder.id,
      label: entry.folder.name,
      depth: entry.depth + 1,
      title: entry.path,
    })),
  ];
  const initialId = options.find((option) => option.id !== script.folderId)?.id;

  return (
    <Dialog
      open
      title={`Move "${script.name}"`}
      description="Choose where the script should live."
      onClose={onClose}
      widthClassName="max-w-sm"
      initialFocusRef={firstChoiceRef}
    >
      <ul
        ref={listRef}
        aria-label="Destinations"
        className="max-h-72 overflow-y-auto p-2"
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }}
      >
        {options.map((option) => {
          const current = option.id === script.folderId;
          return (
            <li key={option.id ?? "root"}>
              <button
                ref={option.id === initialId ? firstChoiceRef : undefined}
                type="button"
                disabled={current}
                title={option.title}
                onClick={() => onMove(option.id)}
                style={{ paddingLeft: 10 + option.depth * 14 }}
                className="flex h-8 w-full items-center gap-2 rounded pr-2.5 text-left text-xs text-foreground transition-colors duration-[var(--dur-fast)] hover:bg-accent-soft focus-visible:bg-accent-soft disabled:text-subtle disabled:hover:bg-transparent"
              >
                <Icon
                  name={option.id === null ? "scripts" : "folder"}
                  size={14}
                  className={`shrink-0 ${current ? "text-subtle" : "text-muted"}`}
                />
                <span className="min-w-0 truncate">{option.label}</span>
                {current ? <span className="ml-auto shrink-0 text-[10px] text-subtle">Current</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      <footer className="flex justify-end border-t border-border px-5 py-3">
        <button
          type="button"
          onClick={onClose}
          className="h-7 rounded border border-border-strong px-3 text-xs text-foreground transition-colors duration-[var(--dur-fast)] hover:bg-surface-raised"
        >
          Cancel
        </button>
      </footer>
    </Dialog>
  );
}
