import type { DebugState } from "@/features/debugger/types";

/**
 * The debugger state machine. Every launch starts at `unavailable`; nothing
 * about a session is persisted, so a stale "paused" cannot survive a restart.
 *
 * ```text
 * unavailable → ready → running → paused → running → stopped → ready
 *                                    ↓ error | target lost
 * ```
 *
 * Losing the target is applied from every state, because pretending a session
 * is still paused on a target that went away would be a lie.
 */
const TRANSITIONS: Record<DebugState, readonly DebugState[]> = {
  unavailable: ["ready"],
  ready: ["running", "error", "unavailable"],
  running: ["paused", "stopped", "error", "unavailable"],
  paused: ["running", "stopped", "error", "unavailable"],
  // A finished session rests here until another one is started.
  stopped: ["ready", "running", "error", "unavailable"],
  error: ["ready", "running", "stopped", "unavailable"],
};

export const DEBUG_STATES = Object.keys(TRANSITIONS) as DebugState[];

/** States in which a session may be started. */
export const STARTABLE_DEBUG_STATES: readonly DebugState[] = ["ready", "stopped", "error"];

/** States in which a session exists and can still be stopped. */
export const ACTIVE_DEBUG_STATES: readonly DebugState[] = ["running", "paused"];

export function canTransitionDebug(from: DebugState, to: DebugState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidDebugTransitionError extends Error {
  readonly from: DebugState;
  readonly to: DebugState;

  constructor(from: DebugState, to: DebugState) {
    super(`Invalid debugger transition: ${from} → ${to}`);
    this.name = "InvalidDebugTransitionError";
    this.from = from;
    this.to = to;
  }
}

/** Returns `to`, or throws when the state machine does not allow the transition. */
export function transitionDebug(from: DebugState, to: DebugState): DebugState {
  if (!canTransitionDebug(from, to)) throw new InvalidDebugTransitionError(from, to);
  return to;
}

/** True while a session exists, whether it is executing or stopped at a line. */
export function isDebugSessionActive(state: DebugState): boolean {
  return ACTIVE_DEBUG_STATES.includes(state);
}

/** True while execution is stopped and the stack can be inspected. */
export function isDebugPaused(state: DebugState): boolean {
  return state === "paused";
}
