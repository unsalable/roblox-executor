import { Icon, type IconName } from "@/components/ui/Icon";
import { unavailableReason } from "@/features/backend/toolAvailability";
import type { DebugState } from "@/features/debugger/types";

/**
 * The debugger's transport: start, continue, pause, the three steps and stop.
 *
 * Every button is a real control with a real reason when it cannot be used —
 * disabled states carry the explanation in their tooltip rather than going
 * quiet — and all of them are reachable from the keyboard, because a debugger
 * that only works with a mouse is half a debugger.
 */

export interface DebuggerControlActions {
  start: () => void;
  resume: () => void;
  pause: () => void;
  stepOver: () => void;
  stepInto: () => void;
  stepOut: () => void;
  stop: () => void;
}

export interface DebuggerControlState {
  state: DebugState;
  busy: boolean;
  pausePending: boolean;
  supportsPause: boolean;
  hasScript: boolean;
  /** The active backend supplies a debugger at all. */
  supported: boolean;
  /** The active backend is running, so its debugger may be used. */
  backendReady: boolean;
}

function ControlButton({
  icon,
  label,
  onClick,
  disabledReason,
  primary = false,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabledReason?: string | undefined;
  primary?: boolean;
}) {
  const disabled = disabledReason !== undefined;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabledReason ?? label}
      aria-label={label}
      className={`flex h-7 items-center gap-1.5 rounded border px-2.5 text-[11px] transition-colors duration-[var(--dur-fast)] disabled:pointer-events-none disabled:opacity-40 ${
        primary
          ? "border-accent bg-accent text-accent-foreground hover:bg-accent-hover"
          : "border-border-strong bg-surface text-foreground hover:border-accent hover:bg-surface-raised"
      }`}
    >
      <Icon name={icon} size={13} className="shrink-0" />
      <span>{label}</span>
    </button>
  );
}

export function DebuggerControls({
  state,
  actions,
}: {
  state: DebuggerControlState;
  actions: DebuggerControlActions;
}) {
  const active = state.state === "running" || state.state === "paused";
  const paused = state.state === "paused";

  const startReason =
    state.state === "unavailable"
      ? unavailableReason("debugger", state)
      : active
        ? "A debug session is already running."
        : state.busy
          ? "A debug operation is already in progress."
          : state.hasScript
            ? undefined
            : "No script is open.";

  const resumeReason = paused
    ? state.busy
      ? "A debug operation is already in progress."
      : undefined
    : state.state === "running"
      ? "The session is already running."
      : "No debug session is paused.";

  const pauseReason =
    state.state !== "running"
      ? "No debug session is running."
      : !state.supportsPause
        ? "This provider cannot pause a run once it has started."
        : state.pausePending
          ? "A pause has already been requested."
          : undefined;

  const stopReason = active ? undefined : "There is no debug session to stop.";

  return (
    <div
      role="toolbar"
      aria-label="Debugger controls"
      className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-surface px-3 py-2"
    >
      <ControlButton icon="play" label="Start" onClick={actions.start} disabledReason={startReason} primary />
      <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
      <ControlButton icon="play" label="Continue" onClick={actions.resume} disabledReason={resumeReason} />
      <ControlButton icon="pause" label="Pause" onClick={actions.pause} disabledReason={pauseReason} />
      <ControlButton icon="stepOver" label="Step Over" onClick={actions.stepOver} disabledReason={resumeReason} />
      <ControlButton icon="stepInto" label="Step Into" onClick={actions.stepInto} disabledReason={resumeReason} />
      <ControlButton icon="stepOut" label="Step Out" onClick={actions.stepOut} disabledReason={resumeReason} />
      <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
      <ControlButton icon="stop" label="Stop" onClick={actions.stop} disabledReason={stopReason} />
    </div>
  );
}
