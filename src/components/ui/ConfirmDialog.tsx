import { useRef, type ReactNode } from "react";
import { Dialog } from "@/components/ui/Dialog";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** Styles the confirm button as a destructive action. */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Optional third choice shown between Cancel and the confirm button, e.g. "Discard" next to "Save". */
  secondary?: { label: string; onSelect: () => void; destructive?: boolean };
}

const buttonBase = "h-7 rounded px-3 text-xs transition-colors duration-[var(--dur-fast)]";

/** Confirmation built on the shared dialog. Focus starts on Cancel so Enter never destroys by accident. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  destructive = false,
  onConfirm,
  onCancel,
  secondary,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog open={open} title={title} onClose={onCancel} widthClassName="max-w-md" initialFocusRef={cancelRef}>
      <div className="px-5 py-4 text-xs leading-relaxed text-muted">{children}</div>
      <footer className="flex justify-end gap-2 border-t border-border px-5 py-3">
        <button
          ref={cancelRef}
          type="button"
          onClick={onCancel}
          className={`${buttonBase} border border-border-strong text-foreground hover:bg-surface-raised`}
        >
          Cancel
        </button>
        {secondary ? (
          <button
            type="button"
            onClick={secondary.onSelect}
            className={`${buttonBase} border ${
              secondary.destructive
                ? "border-danger/60 text-danger hover:bg-danger-soft"
                : "border-border-strong text-foreground hover:bg-surface-raised"
            }`}
          >
            {secondary.label}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onConfirm}
          className={`${buttonBase} font-medium ${
            destructive
              ? "bg-danger text-white hover:opacity-90"
              : "bg-accent text-accent-foreground hover:bg-accent-hover"
          }`}
        >
          {confirmLabel}
        </button>
      </footer>
    </Dialog>
  );
}
