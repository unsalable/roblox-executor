import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import type { FolderCreation } from "@/features/scripts/useScriptWorkspace";

interface NewFolderDialogProps {
  /** Name the input starts with, e.g. `New Folder 2`. */
  suggestedName: string;
  /** Where the folder goes, for the description. Null for the workspace root. */
  parentName: string | null;
  onCreate: (name: string) => FolderCreation;
  onClose: () => void;
}

export function NewFolderDialog({ suggestedName, parentName, onCreate, onClose }: NewFolderDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(suggestedName);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const errorId = useId();

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  return (
    <Dialog
      open
      title="New Folder"
      description={parentName === null ? "At the workspace root" : `Inside "${parentName}"`}
      onClose={onClose}
      widthClassName="max-w-sm"
      initialFocusRef={inputRef}
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const result = onCreate(name);
          if (result.ok) onClose();
          else setError(result.reason);
        }}
      >
        <div className="px-5 py-4">
          <label htmlFor={inputId} className="text-xs font-medium text-foreground">
            Folder name
          </label>
          <input
            ref={inputRef}
            id={inputId}
            value={name}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={error !== null}
            {...(error ? { "aria-describedby": errorId } : {})}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
            className={`mt-1.5 h-8 w-full rounded border bg-surface-secondary px-2.5 text-xs text-foreground outline-none transition-colors duration-[var(--dur-fast)] ${
              error ? "border-danger" : "border-border-strong focus:border-accent"
            }`}
          />
          {error ? (
            <p id={errorId} role="alert" className="mt-1.5 text-[11px] leading-snug text-danger">
              {error}
            </p>
          ) : null}
        </div>
        <footer className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="h-7 rounded border border-border-strong px-3 text-xs text-foreground transition-colors duration-[var(--dur-fast)] hover:bg-surface-raised"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="h-7 rounded bg-accent px-3 text-xs font-medium text-accent-foreground transition-colors duration-[var(--dur-fast)] hover:bg-accent-hover"
          >
            Create
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
