import type { BackendState } from "@/features/backend/types";

/**
 * The developer backend state machine. Every launch starts at `created`; no
 * backend runtime state is ever persisted, so a stale "ready" cannot survive a
 * restart.
 *
 * ```text
 * created → starting → ready → stopping → stopped → starting
 *              ↓ error | stopped (a cancelled start)
 * ```
 *
 * This is deliberately *not* the target's state machine. A backend being ready
 * says its providers may be used; whether a target is there is the target
 * controller's answer, and the two are never collapsed into one value.
 */
const TRANSITIONS: Record<BackendState, readonly BackendState[]> = {
  created: ["starting"],
  // A start that is cancelled lands at `stopped`, not at `error`: nothing failed.
  starting: ["ready", "error", "stopped"],
  ready: ["stopping", "error"],
  stopping: ["stopped", "error"],
  stopped: ["starting"],
  // Retry, stop what a failed start left behind, or settle at rest.
  error: ["starting", "stopping", "stopped"],
};

export const BACKEND_STATES = Object.keys(TRANSITIONS) as BackendState[];

/** States a start request may be issued from. */
export const STARTABLE_BACKEND_STATES: readonly BackendState[] = ["created", "stopped", "error"];

/** States a stop request has something to do in. */
export const STOPPABLE_BACKEND_STATES: readonly BackendState[] = ["starting", "ready", "error"];

export function canTransitionBackend(from: BackendState, to: BackendState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidBackendTransitionError extends Error {
  readonly from: BackendState;
  readonly to: BackendState;

  constructor(from: BackendState, to: BackendState) {
    super(`Invalid backend transition: ${from} → ${to}`);
    this.name = "InvalidBackendTransitionError";
    this.from = from;
    this.to = to;
  }
}

/** Returns `to`, or throws when the state machine does not allow the transition. */
export function transitionBackend(from: BackendState, to: BackendState): BackendState {
  if (!canTransitionBackend(from, to)) throw new InvalidBackendTransitionError(from, to);
  return to;
}

/** True when the backend's providers may be used. */
export function isBackendReady(state: BackendState): boolean {
  return state === "ready";
}

/** True while a lifecycle operation is in flight. */
export function isBackendBusy(state: BackendState): boolean {
  return state === "starting" || state === "stopping";
}
