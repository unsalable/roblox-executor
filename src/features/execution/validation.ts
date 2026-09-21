import { isExecutionBusy } from "@/features/execution/executionState";
import {
  EXECUTION_MODES,
  type ExecutionError,
  type ExecutionMode,
  type ExecutionPhase,
} from "@/features/execution/types";

export interface ValidationEnvironment {
  phase: ExecutionPhase;
  timeoutMs: number;
  providerLabel: string;
  requiresTarget: boolean;
  /** The target reports it is injected, so the provider may be used. */
  targetReady: boolean;
}

const invalid = (message: string, details?: string): ExecutionError =>
  details === undefined ? { code: "INVALID_REQUEST", message } : { code: "INVALID_REQUEST", message, details };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * Checks a request before it may start. The execution core calls this itself
 * for every submission, whatever the UI already checked. Returns null when the
 * request is acceptable.
 */
export function validateExecutionInput(input: unknown, environment: ValidationEnvironment): ExecutionError | null {
  if (!isRecord(input)) return invalid("The execution request is malformed.");
  if (!EXECUTION_MODES.includes(input.mode as ExecutionMode)) {
    return invalid("The execution mode is not supported.", `Received mode: ${String(input.mode)}`);
  }

  const { timeoutMs } = environment;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return invalid("The execution timeout must be a positive number of milliseconds.");
  }

  if (isExecutionBusy(environment.phase)) {
    return { code: "EXECUTION_ALREADY_RUNNING", message: "Another execution is still running." };
  }

  const { script, source } = input;
  if (script === null || script === undefined) return { code: "NO_ACTIVE_SCRIPT", message: "No active script." };
  if (!isRecord(script) || typeof script.id !== "string" || script.id === "" || typeof script.name !== "string") {
    return invalid("The script to execute is not identified.");
  }
  if (typeof source !== "string") return invalid("The script source is not available.");

  if (input.mode === "selection" && source.trim() === "") {
    return { code: "EMPTY_SELECTION", message: "The selection is empty." };
  }

  if (environment.requiresTarget && !environment.targetReady) {
    return {
      code: "TARGET_NOT_READY",
      message: `Target not ready. Inject the ${environment.providerLabel} target first.`,
    };
  }

  return null;
}
