import { memo, useId, useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import type { ExecuteCommand } from "@/features/execution/executionInput";
import { isExecutionBusy } from "@/features/execution/executionState";
import { useExecution, useExecutionHistory, type ExecutionView } from "@/features/execution/useExecution";
import { executionDescriptor, StatusIndicator, type StatusDescriptor } from "@/features/status/StatusIndicator";
import { TargetControl, useTargetAction } from "@/features/target/TargetControl";
import { isTargetInjected } from "@/features/target/targetState";
import { useTarget } from "@/features/target/useTarget";

interface ExecuteBarProps {
  hasScript: boolean;
  /** The editor has a non-empty selection, so Ctrl+Enter and Execute run only the selection. */
  hasSelection: boolean;
  onExecute: (command: ExecuteCommand, options?: { clearConsole: boolean }) => void;
  onCancel: () => void;
  onShowHistory: () => void;
  onShowDiagnostics: () => void;
}

const CANCEL_SHORTCUTS = "Ctrl+Shift+Esc or Shift+F5";

const accentButton =
  "flex h-9 items-center bg-accent text-accent-foreground transition-[background-color,transform,opacity] duration-[var(--dur-fast)] hover:bg-accent-hover active:translate-y-px active:bg-accent-pressed disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-70";

/**
 * The next step offered when a request is refused for want of a target. It is
 * the same action the target control shows, so there is one answer to "what do
 * I do now?" wherever the user is looking.
 */
function InjectAction() {
  const action = useTargetAction();
  if (!action.primary) return null;

  return (
    <button
      type="button"
      onClick={action.run}
      disabled={action.busy}
      className="h-6 shrink-0 rounded border border-accent/60 bg-accent-soft px-2 text-[11px] text-foreground transition-colors duration-[var(--dur-fast)] hover:bg-surface-raised disabled:pointer-events-none disabled:opacity-45"
    >
      {action.label}
    </button>
  );
}

function Spinner() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="animate-spin">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" />
      <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

interface StatusLine {
  descriptor: StatusDescriptor;
  detail: string;
  /** Sentence announced to assistive technology. */
  announcement: string;
}

function describeStatus({ phase, context, result, rejection, cancelling }: ExecutionView): StatusLine {
  const name = context?.scriptName ?? "";
  const scope = context?.mode === "selection" ? `${name} · selection` : name;

  if (isExecutionBusy(phase)) {
    return {
      descriptor: cancelling ? { ...executionDescriptor[phase], label: "Cancelling…" } : executionDescriptor[phase],
      detail: scope,
      announcement: phase === "preparing" ? `Execution started: ${scope}` : `Running ${scope}`,
    };
  }

  if (rejection) {
    return {
      descriptor: executionDescriptor.error,
      detail: rejection.message,
      announcement: `Execution failed. ${rejection.message}`,
    };
  }

  if (!result) return { descriptor: executionDescriptor.idle, detail: "", announcement: "" };

  const duration = `${result.durationMs} ms`;
  switch (phase) {
    case "success":
      return {
        descriptor: executionDescriptor.success,
        detail: duration,
        announcement: `Execution completed: ${name} in ${duration}`,
      };
    case "cancelled":
      return {
        descriptor: executionDescriptor.cancelled,
        detail: duration,
        announcement: `Execution cancelled: ${name}`,
      };
    default: {
      const message = result.error?.message ?? "Unknown error.";
      return { descriptor: executionDescriptor.error, detail: message, announcement: `Execution failed. ${message}` };
    }
  }
}

/**
 * The target control with its Inject action, the Execute split button with its
 * Cancel control, and the execution status. Inject and Execute stay two
 * separate actions: one attaches to the target, the other runs a script on it.
 * All state comes from the controllers; this component only renders it.
 */
export const ExecuteBar = memo(function ExecuteBar({
  hasScript,
  hasSelection,
  onExecute,
  onCancel,
  onShowHistory,
  onShowDiagnostics,
}: ExecuteBarProps) {
  const execution = useExecution();
  const history = useExecutionHistory();
  const { status: targetStatus, provider: targetProvider } = useTarget();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonId = useId();
  const reasonId = useId();

  const { phase, context, rejection, cancelling, provider } = execution;
  const busy = isExecutionBusy(phase);
  const status = describeStatus(execution);
  const injected = isTargetInjected(targetStatus);

  const menuItems = useMemo<readonly MenuItem[]>(
    () => [
      { id: "full-script", label: "Execute Full Script", ...(hasSelection ? {} : { hint: "Ctrl+Enter" }) },
      {
        id: "selection",
        label: "Execute Selected",
        disabled: !hasSelection,
        ...(hasSelection ? { hint: "Ctrl+Enter" } : {}),
      },
      { id: "separator", separator: true },
      { id: "clear-and-execute", label: "Clear Console & Execute" },
    ],
    [hasSelection],
  );

  const blockedReason = !hasScript
    ? "Open a script to execute it."
    : busy
      ? "An execution is in progress. Cancel it or wait for it to finish."
      : provider.requiresTarget && !injected
        ? `Target not ready. Inject the ${targetProvider.label} first.`
        : null;

  const run = (command: string) => {
    setMenuOpen(false);
    if (busy) return;
    if (command === "clear-and-execute") onExecute("auto", { clearConsole: true });
    else onExecute(command as ExecuteCommand);
  };

  const executeLabel = hasSelection ? "Execute selection" : "Execute script";

  return (
    <div className="grid h-14 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-t border-border bg-surface px-3">
      <TargetControl onShowDiagnostics={onShowDiagnostics} />

      <div className="flex items-center gap-2">
        {/* Mirrors the Cancel button's width so Execute stays centred and never shifts. */}
        <span aria-hidden="true" className="w-[76px]" />

        <div className="relative flex">
          <button
            type="button"
            disabled={!hasScript}
            aria-disabled={busy || undefined}
            aria-busy={busy}
            aria-label={executeLabel}
            {...(blockedReason ? { "aria-describedby": reasonId } : {})}
            onClick={() => run("auto")}
            title={blockedReason ?? `${executeLabel} (Ctrl+Enter) on the ${provider.label}`}
            className={`${accentButton} gap-2 rounded-l-md pr-4 pl-5 text-[13px] font-semibold tracking-wide`}
          >
            {busy ? <Spinner /> : <Icon name="play" size={14} filled />}
            EXECUTE
          </button>

          <span aria-hidden="true" className="w-px bg-accent-foreground/25" />

          <button
            id={menuButtonId}
            type="button"
            disabled={!hasScript}
            aria-disabled={busy || undefined}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Execute options"
            onClick={() => {
              if (!busy) setMenuOpen((open) => !open);
            }}
            className={`${accentButton} w-8 justify-center rounded-r-md`}
          >
            <Icon
              name="chevronDown"
              size={14}
              className={`transition-transform duration-[var(--dur-fast)] ${menuOpen ? "rotate-180" : ""}`}
            />
          </button>

          <Menu
            open={menuOpen}
            items={menuItems}
            onSelect={run}
            onClose={() => setMenuOpen(false)}
            labelledBy={menuButtonId}
            className="right-0 bottom-11"
          />
        </div>

        <button
          type="button"
          onClick={onCancel}
          disabled={!busy || cancelling || !provider.supportsCancel}
          aria-label="Cancel execution"
          title={`Cancel execution (${CANCEL_SHORTCUTS})`}
          className={`flex h-8 w-[76px] items-center justify-center gap-1.5 rounded-md border border-border-strong text-xs text-foreground transition-colors duration-[var(--dur-fast)] hover:border-danger/60 hover:bg-danger-soft hover:text-danger disabled:opacity-50 ${
            busy ? "animate-fade-in" : "invisible"
          }`}
        >
          <Icon name="stop" size={11} filled />
          Cancel
        </button>

        {blockedReason ? (
          <span id={reasonId} className="sr-only">
            {blockedReason}
          </span>
        ) : null}
      </div>

      <div className="flex min-w-0 items-center justify-end gap-2">
        {hasSelection && !busy ? (
          <span
            title="Ctrl+Enter and Execute run only the selected text"
            className="shrink-0 rounded-sm border border-accent/40 bg-accent-soft px-1.5 text-[10px] tracking-wide text-foreground uppercase"
          >
            Selection
          </span>
        ) : null}

        <p
          key={`${context?.executionId ?? "none"}:${phase}:${rejection?.code ?? ""}:${cancelling}`}
          title={status.detail || undefined}
          className="animate-fade-in flex min-w-0 items-center gap-1.5 text-xs"
        >
          <StatusIndicator descriptor={status.descriptor} name="Execution" className="shrink-0" />
          {status.detail ? <span className="truncate text-subtle">{status.detail}</span> : null}
        </p>

        {rejection?.code === "TARGET_NOT_READY" ? <InjectAction /> : null}

        <span role="status" aria-live="polite" className="sr-only">
          {status.announcement}
        </span>

        <button
          type="button"
          onClick={onShowHistory}
          aria-label={`Execution history, ${history.length} ${history.length === 1 ? "entry" : "entries"}`}
          title="Execution history"
          className="flex h-7 shrink-0 items-center gap-1 rounded px-1.5 text-subtle transition-colors duration-[var(--dur-fast)] hover:bg-surface-raised hover:text-foreground"
        >
          <Icon name="history" size={14} />
          {history.length > 0 ? <span className="font-mono text-[10px] tabular-nums">{history.length}</span> : null}
        </button>
      </div>
    </div>
  );
});
