import type { ProfilerState } from "@/features/profiler/types";

/**
 * The profiler state machine. Every launch starts at `unavailable`; a recording
 * is session state and is never persisted, so a stale "recording" cannot
 * survive a restart.
 *
 * ```text
 * unavailable → ready → recording → ready
 *                          ↓ error | target lost
 * ```
 */
const TRANSITIONS: Record<ProfilerState, readonly ProfilerState[]> = {
  unavailable: ["ready"],
  ready: ["recording", "error", "unavailable"],
  recording: ["ready", "error", "unavailable"],
  error: ["ready", "recording", "unavailable"],
};

export const PROFILER_STATES = Object.keys(TRANSITIONS) as ProfilerState[];

/** States in which a recording may be started. */
export const STARTABLE_PROFILER_STATES: readonly ProfilerState[] = ["ready", "error"];

export function canTransitionProfiler(from: ProfilerState, to: ProfilerState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidProfilerTransitionError extends Error {
  readonly from: ProfilerState;
  readonly to: ProfilerState;

  constructor(from: ProfilerState, to: ProfilerState) {
    super(`Invalid profiler transition: ${from} → ${to}`);
    this.name = "InvalidProfilerTransitionError";
    this.from = from;
    this.to = to;
  }
}

/** Returns `to`, or throws when the state machine does not allow the transition. */
export function transitionProfiler(from: ProfilerState, to: ProfilerState): ProfilerState {
  if (!canTransitionProfiler(from, to)) throw new InvalidProfilerTransitionError(from, to);
  return to;
}

export function isProfilerRecording(state: ProfilerState): boolean {
  return state === "recording";
}
