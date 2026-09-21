import type { InjectResult, TargetHistoryEntry, TargetHistoryStatus } from "@/features/target/types";

/** Target operations kept per session. History lives in memory only and is not persisted. */
export const TARGET_HISTORY_LIMIT = 50;

function statusOfResult(result: InjectResult): TargetHistoryStatus {
  if (result.success) return "injected";
  if (result.cancelled) return "cancelled";
  return result.error?.code === "INJECTION_TIMEOUT" ? "timeout" : "failed";
}

/**
 * Builds a history entry from a finished request. Neither a process nor a
 * script is an input here, because neither is part of the model.
 */
export function createInjectHistoryEntry(
  request: { requestId: string; createdAt: number },
  provider: string,
  result: InjectResult,
): TargetHistoryEntry {
  return Object.freeze({
    requestId: result.requestId,
    startedAt: request.createdAt,
    provider,
    status: statusOfResult(result),
    durationMs: result.durationMs,
    error: result.error === null ? null : { code: result.error.code, message: result.error.message },
  });
}

/** The entry recorded when a session ends rather than a request finishing. */
export function createDisconnectHistoryEntry(
  requestId: string,
  provider: string,
  at: number,
  error: TargetHistoryEntry["error"] = null,
): TargetHistoryEntry {
  return Object.freeze({
    requestId,
    startedAt: at,
    provider,
    status: "disconnected",
    durationMs: null,
    error,
  });
}

/** Adds an entry at the front and drops the oldest entries beyond `limit`. */
export function appendTargetHistory(
  history: readonly TargetHistoryEntry[],
  entry: TargetHistoryEntry,
  limit = TARGET_HISTORY_LIMIT,
): readonly TargetHistoryEntry[] {
  const next = [entry, ...history];
  return next.length > limit ? next.slice(0, Math.max(0, limit)) : next;
}
