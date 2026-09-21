import { Icon } from "@/components/ui/Icon";
import type { ErrorActionId, ErrorPresentation } from "@/features/errors/errorPresentation";

/**
 * A structured error, read as a developer would want it: what went wrong, why,
 * the code to search for, and the one action that is worth taking next.
 *
 * The callout renders a presentation and reports which action was chosen. It
 * runs nothing itself, so no error surface can change target or execution
 * state on its own.
 */
export function ErrorCallout({
  presentation,
  onAction,
  tone = "danger",
}: {
  presentation: ErrorPresentation;
  onAction?: (action: ErrorActionId) => void;
  /** "warning" for a refusal that is expected, e.g. a cancelled request. */
  tone?: "danger" | "warning";
}) {
  const { title, explanation, code, action, details, reported } = presentation;
  const accent = tone === "danger" ? "border-danger/40 bg-danger-soft" : "border-warning/40 bg-warning-soft";
  const iconTone = tone === "danger" ? "text-danger" : "text-warning";

  return (
    <div className={`rounded border ${accent} px-3 py-2.5`}>
      <div className="flex items-start gap-2">
        <Icon name={tone === "danger" ? "error" : "warning"} size={14} className={`mt-px shrink-0 ${iconTone}`} />
        <div className="min-w-0 flex-1">
          <h4 className="text-xs font-semibold text-foreground">{title}</h4>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">{explanation}</p>
          {reported ? <p className="mt-1 text-[11px] leading-relaxed text-subtle">{reported}</p> : null}

          <p className="mt-2 font-mono text-[10px] text-subtle">
            Code: <span className="text-muted">{code}</span>
          </p>
          {details ? (
            <p className="mt-0.5 font-mono text-[10px] break-words text-subtle" title={details}>
              {details}
            </p>
          ) : null}

          {action && onAction ? (
            <button
              type="button"
              onClick={() => onAction(action.id)}
              className="mt-2.5 h-7 rounded border border-border-strong bg-surface px-2.5 text-[11px] text-foreground transition-colors duration-[var(--dur-fast)] hover:border-accent hover:bg-surface-raised"
            >
              {action.label}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
