import { memo } from "react";
import { sessionDescriptor, StatusIndicator, targetDescriptor } from "@/features/status/StatusIndicator";
import { useTarget } from "@/features/target/useTarget";

/**
 * The one contextual target action, shared by the target control and by the
 * execute bar's "target not ready" hint, so both places offer exactly the same
 * next step.
 */
export interface TargetAction {
  label: string;
  run: () => void;
  busy: boolean;
  /** The action that moves the workflow forward, rather than undoing it. */
  primary: boolean;
}

export function useTargetAction(): TargetAction {
  const { status, detecting, cancelling, inject, cancelInject, disconnect, detect } = useTarget();

  switch (status) {
    case "injected":
      return { label: "Disconnect", run: disconnect, busy: false, primary: false };
    case "injecting":
      return { label: "Cancel", run: cancelInject, busy: cancelling, primary: false };
    case "disconnecting":
      return { label: "Disconnect", run: disconnect, busy: true, primary: false };
    case "error":
      return { label: "Retry", run: inject, busy: false, primary: true };
    case "detected":
      return { label: "Inject", run: inject, busy: true, primary: true };
    case "unavailable":
      return { label: detecting ? "Checking…" : "Detect", run: detect, busy: detecting, primary: false };
    default:
      return { label: "Inject", run: inject, busy: detecting, primary: true };
  }
}

/**
 * The execute bar's target surface: the two facts that are not the same fact —
 * what the target reports and whether a session exists — the provider they
 * refer to, and the single action that moves the workflow on.
 */
export const TargetControl = memo(function TargetControl({ onShowDiagnostics }: { onShowDiagnostics: () => void }) {
  const { status, session, error, provider, detecting } = useTarget();
  const action = useTargetAction();

  const target =
    detecting && status === "unavailable"
      ? { ...targetDescriptor.unavailable, label: "Checking…", shape: "pulse" as const }
      : targetDescriptor[status];
  const sessionStatus = sessionDescriptor[session];

  return (
    <div className="flex min-w-0 items-center gap-2">
      <button
        type="button"
        onClick={onShowDiagnostics}
        aria-label={`Target diagnostics. Target ${target.label}, session ${sessionStatus.label}, ${provider.label}`}
        title={
          error
            ? `${error.message}${error.details ? ` (${error.details})` : ""}`
            : `${provider.label}${provider.simulated ? " — simulated inside Nova" : ""} · Target ${target.label} · Session ${sessionStatus.label}`
        }
        className="flex min-w-0 flex-col items-start gap-px rounded px-1.5 py-1 text-left transition-colors duration-[var(--dur-fast)] hover:bg-surface-raised"
      >
        <span className="flex min-w-0 max-w-full items-center gap-1.5">
          <span className="shrink-0 text-[10px] font-semibold tracking-[0.12em] text-subtle uppercase">Target</span>
          <span className="flex min-w-0 items-center gap-1 rounded-sm border border-border px-1 text-[10px] tracking-wide text-subtle">
            <span className="truncate">{provider.label}</span>
            {provider.simulated ? <span className="shrink-0 text-warning">SIM</span> : null}
          </span>
        </span>

        <span className="flex min-w-0 max-w-full items-center gap-1.5 text-xs">
          <StatusIndicator key={target.label} descriptor={target} name="Target" className="animate-fade-in" />
          <span aria-hidden="true" className="h-2.5 w-px shrink-0 bg-border" />
          <span className="shrink-0 text-[10px] tracking-wide text-subtle uppercase">Session</span>
          <StatusIndicator
            key={sessionStatus.label}
            descriptor={sessionStatus}
            name="Session"
            className="animate-fade-in text-[11px]"
          />
        </span>
      </button>

      <button
        type="button"
        onClick={action.run}
        disabled={action.busy}
        aria-label={`${action.label} (${provider.label})`}
        className={`h-7 shrink-0 rounded border px-2.5 text-[11px] font-medium tracking-wide text-foreground transition-colors duration-[var(--dur-fast)] disabled:pointer-events-none disabled:opacity-45 ${
          action.primary
            ? "border-accent/60 bg-accent-soft hover:border-accent hover:bg-surface-raised"
            : "border-border-strong hover:border-accent hover:bg-surface-raised"
        }`}
      >
        {action.label}
      </button>

      <span role="status" aria-live="polite" className="sr-only">
        {`Target ${target.label}. Session ${sessionStatus.label}.`}
      </span>
    </div>
  );
});
