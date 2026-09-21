import type { ExecutionPhase } from "@/features/execution/types";

/**
 * The execution state machine. A finished execution never resumes: the only
 * way out of success, error or cancelled is a new request, which starts over
 * at preparing.
 */
const TRANSITIONS: Record<ExecutionPhase, readonly ExecutionPhase[]> = {
  idle: ["preparing"],
  preparing: ["running", "error", "cancelled"],
  running: ["success", "error", "cancelled"],
  success: ["preparing"],
  error: ["preparing"],
  cancelled: ["preparing"],
};

export const EXECUTION_PHASES = Object.keys(TRANSITIONS) as ExecutionPhase[];

export function canTransitionExecution(from: ExecutionPhase, to: ExecutionPhase): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidExecutionTransitionError extends Error {
  readonly from: ExecutionPhase;
  readonly to: ExecutionPhase;

  constructor(from: ExecutionPhase, to: ExecutionPhase) {
    super(`Invalid execution transition: ${from} → ${to}`);
    this.name = "InvalidExecutionTransitionError";
    this.from = from;
    this.to = to;
  }
}

/** Returns `to`, or throws when the state machine does not allow the transition. */
export function transitionExecution(from: ExecutionPhase, to: ExecutionPhase): ExecutionPhase {
  if (!canTransitionExecution(from, to)) throw new InvalidExecutionTransitionError(from, to);
  return to;
}

export function isExecutionBusy(phase: ExecutionPhase): boolean {
  return phase === "preparing" || phase === "running";
}
