import type { TargetStatus } from "@/features/target/types";

/**
 * The target state machine. Every launch starts at `unavailable`; the state is
 * never persisted, so a stale "injected" cannot survive a restart.
 *
 * ```text
 * unavailable → detected → ready → injecting → injected → disconnecting → ready
 *                                       ↓ error | cancelled
 * ```
 *
 * A target that goes away is reported where it happens: from `ready` it simply
 * becomes `unavailable`, while from `injecting` or `injected` it is a failure
 * (`TARGET_DISCONNECTED`) first, because something was in flight.
 */
const TRANSITIONS: Record<TargetStatus, readonly TargetStatus[]> = {
  unavailable: ["detected"],
  detected: ["ready", "unavailable"],
  ready: ["injecting", "unavailable"],
  injecting: ["injected", "error", "cancelled"],
  injected: ["disconnecting", "error"],
  disconnecting: ["ready", "unavailable"],
  // Retry the injection, settle back to a resting state, or lose the target.
  error: ["injecting", "ready", "unavailable", "detected"],
  cancelled: ["injecting", "ready", "unavailable", "detected"],
};

export const TARGET_STATUSES = Object.keys(TRANSITIONS) as TargetStatus[];

/** Statuses in which an inject request may be started. */
export const INJECTABLE_STATUSES: readonly TargetStatus[] = ["ready", "error", "cancelled"];

export function canTransitionTarget(from: TargetStatus, to: TargetStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTargetTransitionError extends Error {
  readonly from: TargetStatus;
  readonly to: TargetStatus;

  constructor(from: TargetStatus, to: TargetStatus) {
    super(`Invalid target transition: ${from} → ${to}`);
    this.name = "InvalidTargetTransitionError";
    this.from = from;
    this.to = to;
  }
}

/** Returns `to`, or throws when the state machine does not allow the transition. */
export function transitionTarget(from: TargetStatus, to: TargetStatus): TargetStatus {
  if (!canTransitionTarget(from, to)) throw new InvalidTargetTransitionError(from, to);
  return to;
}

/**
 * Statuses in which a target exists for the developer tools to work against.
 *
 * The debugger and the profiler need a target to be there, not to be injected:
 * `detected` already means the provider can see one, while `unavailable`,
 * `error` and `cancelled` are resting states in which there may be nothing.
 */
export const TOOLING_STATUSES: readonly TargetStatus[] = [
  "detected",
  "ready",
  "injecting",
  "injected",
  "disconnecting",
];

/** True when the developer tools have a target to work against. */
export function isTargetPresent(status: TargetStatus): boolean {
  return TOOLING_STATUSES.includes(status);
}

/** True while an inject request is in flight. */
export function isTargetBusy(status: TargetStatus): boolean {
  return status === "injecting" || status === "disconnecting";
}

/** True when the target is attached and execution may be offered. */
export function isTargetInjected(status: TargetStatus): boolean {
  return status === "injected";
}
