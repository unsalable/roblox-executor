import type {
  ExecutionContext,
  ExecutionHistoryEntry,
  ExecutionResult,
  TerminalExecutionPhase,
} from "@/features/execution/types";

/** Executions kept per session. History lives in memory only and is not persisted. */
export const EXECUTION_HISTORY_LIMIT = 100;

function statusOfResult(result: ExecutionResult): TerminalExecutionPhase {
  if (result.success) return "success";
  return result.cancelled ? "cancelled" : "error";
}

/** Builds a history entry from metadata only; the request source is deliberately not an input. */
export function createHistoryEntry(context: ExecutionContext, result: ExecutionResult): ExecutionHistoryEntry {
  return Object.freeze({
    executionId: context.executionId,
    scriptId: context.scriptId,
    scriptName: context.scriptName,
    mode: context.mode,
    provider: context.provider,
    status: statusOfResult(result),
    durationMs: result.durationMs,
    startedAt: context.startedAt,
    error: result.error === null ? null : { code: result.error.code, message: result.error.message },
  });
}

/** Adds an entry at the front and drops the oldest entries beyond `limit`. */
export function appendHistory(
  history: readonly ExecutionHistoryEntry[],
  entry: ExecutionHistoryEntry,
  limit = EXECUTION_HISTORY_LIMIT,
): readonly ExecutionHistoryEntry[] {
  const next = [entry, ...history];
  return next.length > limit ? next.slice(0, Math.max(0, limit)) : next;
}
