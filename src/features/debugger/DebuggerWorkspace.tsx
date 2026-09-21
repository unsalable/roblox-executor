import { useCallback, useMemo } from "react";
import { Icon } from "@/components/ui/Icon";
import { isBackendReady } from "@/features/backend/backendState";
import { useBackend } from "@/features/backend/useBackend";
import { DebuggerControls } from "@/features/debugger/DebuggerControls";
import {
  BreakpointsPane,
  CallStackPane,
  VariablesPane,
  WatchPane,
} from "@/features/debugger/DebuggerPanes";
import { debugContextFromExplorer } from "@/features/debugger/session";
import type { DebugState, DebugTarget } from "@/features/debugger/types";
import { toolAvailability, unavailableReason } from "@/features/backend/toolAvailability";
import { useDebugger } from "@/features/debugger/useDebugger";
import { ErrorCallout } from "@/features/errors/ErrorCallout";
import { describeDebugError } from "@/features/errors/errorPresentation";
import { useExplorer } from "@/features/explorer/useExplorer";

/**
 * The Debugger workspace: the transport, where execution stands, what it can
 * see, where it will stop next and what the user is watching.
 *
 * It reads three things Nova already owns and adds none of its own: the script
 * from the workspace, the **shared developer selection** from the Explorer, and
 * everything else from the debugger controller. Whether the provider under it
 * is a simulation is the provider's own answer, read from its `simulated` flag
 * and shown where the data is; a backend that supplies no debugger at all says
 * that instead, rather than blaming a missing target.
 */

export interface DebuggerWorkspaceProps {
  /** Reads the script a session would run, at the moment Start is chosen. */
  readTarget: () => DebugTarget | null;
  /** The workspace name of a script, or null when it is no longer there. */
  resolveScriptName: (scriptId: string) => string | null;
  /** Shows a script in the editor, at a line. */
  onOpenScript: (scriptId: string, line: number) => void;
}

const STATE_TEXT: Record<DebugState, { label: string; tone: string }> = {
  // Not "No target": a missing target is only one of the three reasons a tool
  // is unavailable, and with a backend that supplies no debugger it is the
  // wrong one. The specific reason is on the controls, from `unavailableReason`.
  unavailable: { label: "Unavailable", tone: "border-border text-subtle" },
  ready: { label: "Ready", tone: "border-border-strong text-muted" },
  running: { label: "Running", tone: "border-accent/50 bg-accent-soft text-accent" },
  paused: { label: "Paused", tone: "border-warning/50 bg-warning-soft text-warning" },
  stopped: { label: "Stopped", tone: "border-border-strong text-muted" },
  error: { label: "Error", tone: "border-danger/50 bg-danger-soft text-danger" },
};

const PAUSE_TEXT = {
  entry: "stopped at the first line",
  breakpoint: "stopped on a breakpoint",
  step: "stopped after a step",
  pause: "paused on request",
} as const;

export function DebuggerWorkspace({ readTarget, resolveScriptName, onOpenScript }: DebuggerWorkspaceProps) {
  const {
    state,
    session,
    stack,
    currentFrameId,
    locals,
    breakpoints,
    watches,
    pauseReason,
    busy,
    pausePending,
    error,
    controller,
  } = useDebugger();
  const backend = useBackend();
  const { model, selectedId } = useExplorer();

  const target = readTarget();
  const explorerContext = useMemo(() => debugContextFromExplorer(model, selectedId), [model, selectedId]);

  const start = useCallback(() => {
    const next = readTarget();
    if (next === null) return;
    // The context is the shared developer selection, read at the moment the
    // session starts; the debugger never keeps a selection of its own.
    controller.start({ target: next, context: debugContextFromExplorer(model, selectedId) });
  }, [controller, model, readTarget, selectedId]);

  const paused = state === "paused";
  const currentFrame = stack.find((frame) => frame.id === currentFrameId) ?? null;
  const sessionScriptName = session === null ? null : (resolveScriptName(session.target.scriptId) ?? session.target.scriptName);
  const badge = STATE_TEXT[state];
  // Why the tool has nothing to work against, named outermost cause first: a
  // backend that supplies no debugger, then one that is not running, then the
  // target. Undefined in every other state, so no tooltip is invented.
  const unavailableTitle =
    state === "unavailable"
      ? unavailableReason("debugger", toolAvailability("debugger", backend.state, backend.capabilities))
      : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2.5">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground">
          <Icon name="debugger" size={15} className="text-accent" />
          Debugger
        </h2>
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] tracking-wide uppercase ${badge.tone}`}
          title={unavailableTitle}
        >
          {badge.label}
        </span>
        {busy ? <span className="text-[11px] text-subtle">working…</span> : null}
        {pausePending ? <span className="text-[11px] text-warning">pausing…</span> : null}

        <span className="ml-auto flex items-center gap-2 text-[11px] text-subtle">
          {controller.provider.simulated ? (
            <span
              title={controller.provider.description}
              className="rounded-sm border border-warning/40 px-1 text-[9px] tracking-wide text-warning uppercase"
            >
              Simulated
            </span>
          ) : null}
          <span title={controller.provider.description}>{controller.provider.label}</span>
        </span>
      </header>

      <div className="flex shrink-0 flex-wrap items-baseline gap-x-4 gap-y-0.5 border-b border-border bg-surface px-4 py-1.5 text-[11px]">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="text-[10px] tracking-wide text-subtle uppercase">Script</span>
          <span className="truncate text-muted">
            {session === null ? (target?.scriptName ?? "None open") : sessionScriptName}
          </span>
        </span>
        <span className="flex min-w-0 items-baseline gap-1.5" title="The object selected in the Explorer">
          <span className="text-[10px] tracking-wide text-subtle uppercase">Context</span>
          <span className="truncate text-muted">
            {(session === null ? explorerContext : session.context)?.path ?? "No object selected"}
          </span>
        </span>
        {paused && pauseReason !== null ? (
          <span className="text-warning">
            {PAUSE_TEXT[pauseReason]}
            {currentFrame === null ? "" : ` · line ${currentFrame.line}`}
          </span>
        ) : null}
      </div>

      <DebuggerControls
        state={{
          state,
          busy,
          pausePending,
          // The same fact the backend already derived from the provider.
          supportsPause: backend.capabilities.debugger.canPause,
          hasScript: target !== null,
          supported: backend.capabilities.debugger.canDebug,
          backendReady: isBackendReady(backend.state),
        }}
        actions={{
          start,
          resume: () => void controller.resume("continue"),
          pause: () => controller.pause(),
          stepOver: () => void controller.resume("step-over"),
          stepInto: () => void controller.resume("step-into"),
          stepOut: () => void controller.resume("step-out"),
          stop: () => void controller.stop(),
        }}
      />

      {error === null ? null : (
        <div className="shrink-0 px-3 pt-3">
          <ErrorCallout
            presentation={describeDebugError(error)}
            tone={error.code === "DEBUGGER_CANCELLED" ? "warning" : "danger"}
          />
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-2 lg:grid-rows-2 lg:overflow-hidden">
        <CallStackPane
          unavailableReason={unavailableTitle ?? "There is no debug session."}
          stack={stack}
          currentFrameId={currentFrameId}
          state={state}
          scriptName={sessionScriptName}
          onSelect={controller.selectFrame}
          onReveal={(frameId) => {
            controller.selectFrame(frameId);
            const frame = stack.find((entry) => entry.id === frameId);
            if (frame) onOpenScript(frame.scriptId, frame.line);
          }}
        />
        <VariablesPane
          variables={locals}
          paused={paused}
          frameName={currentFrame?.functionName ?? null}
        />
        <BreakpointsPane
          breakpoints={breakpoints}
          resolveScriptName={resolveScriptName}
          onToggleEnabled={(id, enabled) => controller.setBreakpointEnabled(id, enabled)}
          onRemove={(id) => controller.removeBreakpoint(id)}
          onClear={() => controller.clearBreakpoints()}
          onOpen={onOpenScript}
        />
        <WatchPane
          watches={watches}
          paused={paused}
          onAdd={(expression) => controller.addWatch(expression)}
          onRemove={(id) => controller.removeWatch(id)}
          onRefresh={() => controller.refreshWatches()}
        />
      </div>

      <p className="shrink-0 border-t border-border bg-surface px-4 py-1.5 text-[10px] leading-relaxed text-subtle">
        {controller.provider.label}: {controller.provider.description}
      </p>
    </div>
  );
}
