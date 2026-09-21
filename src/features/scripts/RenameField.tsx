import { useEffect, useId, useRef, useState } from "react";
import { SCRIPT_EXTENSION, type NameValidation } from "@/features/scripts/workspace";

interface RenameFieldProps {
  initialValue: string;
  /** Accessible label, e.g. `Rename Main.lua`. */
  label: string;
  onSubmit: (name: string) => NameValidation;
  /** Called once when editing ends; `restoreFocus` is true for keyboard confirm/cancel. */
  onDone: (restoreFocus: boolean) => void;
}

/** Inline name editor for sidebar rows. Validation is the workspace's; this only shows its verdict. */
export function RenameField({ initialValue, label, onSubmit, onDone }: RenameFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const finished = useRef(false);
  const errorId = useId();

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // Select the base name so typing replaces it and keeps the extension.
    const extension = input.value.toLowerCase().lastIndexOf(SCRIPT_EXTENSION);
    input.setSelectionRange(0, extension > 0 ? extension : input.value.length);
  }, []);

  const finish = (restoreFocus: boolean) => {
    if (finished.current) return;
    finished.current = true;
    onDone(restoreFocus);
  };

  const submit = (): boolean => {
    const result = onSubmit(value);
    if (!result.ok) setError(result.reason);
    return result.ok;
  };

  return (
    <div className="min-w-0 flex-1 py-0.5">
      <input
        ref={inputRef}
        value={value}
        spellCheck={false}
        aria-label={label}
        aria-invalid={error !== null}
        {...(error ? { "aria-describedby": errorId } : {})}
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            if (submit()) finish(true);
          } else if (event.key === "Escape") {
            event.preventDefault();
            finish(true);
          }
        }}
        onBlur={() => {
          // Clicking away keeps a valid name and silently drops an invalid one.
          if (!finished.current) {
            onSubmit(value);
            finish(false);
          }
        }}
        className={`h-6 w-full rounded border bg-surface-secondary px-1.5 text-xs text-foreground outline-none ${
          error ? "border-danger" : "border-accent"
        }`}
      />
      {error ? (
        <p id={errorId} role="alert" className="mt-1 px-0.5 text-[10px] leading-snug whitespace-normal text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
