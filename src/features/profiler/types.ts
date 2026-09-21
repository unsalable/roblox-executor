/**
 * The developer Profiler model.
 *
 * Nova owns the recording workflow — the session, the state machine, the
 * timeout, cancellation, aggregation and history — while a
 * {@link ProfilerProvider} owns where samples come from. The provider shipped
 * today makes them up inside Nova, deterministically, and the UI says so
 * wherever the numbers are shown: **these are test values, not measurements of
 * anything outside Nova.**
 */

/** The work a sample is attributed to. */
export const PROFILE_CATEGORIES = ["Render", "Update", "Physics", "Script", "Network", "Idle"] as const;

export type ProfileCategory = (typeof PROFILE_CATEGORIES)[number];

/**
 * Where the profiler stands.
 *
 * - `unavailable` — there is no target to record against.
 * - `ready` — a recording can be started.
 * - `recording` — a session is being recorded.
 * - `error` — the last operation failed.
 */
export type ProfilerState = "unavailable" | "ready" | "recording" | "error";

export type ProfilerErrorCode =
  /** There is no target for the profiler to work against. */
  | "PROFILER_UNAVAILABLE"
  /** The profiler is not in a state that allows the operation. */
  | "PROFILER_NOT_READY"
  /** Another profiler operation is already in flight. */
  | "PROFILER_BUSY"
  /** The provider attempted the operation and reported a failure. */
  | "PROFILER_SESSION_FAILED"
  /** The provider did not answer within the operation timeout. */
  | "PROFILER_TIMEOUT"
  /** The operation was cancelled before it completed. */
  | "PROFILER_CANCELLED"
  /** The operation needs a session and there is none. */
  | "PROFILER_NO_SESSION"
  /** The target went away while a recording was running. */
  | "TARGET_DISCONNECTED";

export interface ProfilerError {
  code: ProfilerErrorCode;
  /** Short sentence suitable for the UI. */
  message: string;
  /** Technical context, shown in the console and the panel. */
  details?: string;
}

export interface ProfileSample {
  /** Epoch milliseconds. */
  readonly timestamp: number;
  /** The function the sample was attributed to, e.g. "render()". */
  readonly frame: string;
  readonly category: ProfileCategory;
  readonly durationMs: number;
}

/** One function, with every sample that landed in it added up. */
export interface ProfileFrame {
  readonly name: string;
  readonly category: ProfileCategory;
  readonly totalDurationMs: number;
  readonly sampleCount: number;
  /** Share of the recorded work, 0–100. */
  readonly percentage: number;
}

export interface ProfileSummary {
  readonly sampleCount: number;
  readonly frameCount: number;
  /** Sum of every sample's duration. Not the same as the session's wall clock. */
  readonly sampledDurationMs: number;
  readonly busiestFrame: string | null;
}

export interface ProfileSession {
  readonly id: string;
  readonly provider: string;
  /** Epoch milliseconds. */
  readonly startedAt: number;
  /** Epoch milliseconds, set once the recording stopped. */
  readonly endedAt: number | null;
  /** Wall-clock length of the recording. */
  readonly durationMs: number;
  readonly samples: readonly ProfileSample[];
  /** Aggregated from `samples`, busiest first. */
  readonly frames: readonly ProfileFrame[];
  readonly summary: ProfileSummary;
  /** True while the data is generated rather than measured. The UI must say so. */
  readonly simulated: boolean;
}

/** A finished session as kept in the session history. */
export interface ProfileHistoryEntry {
  readonly id: string;
  /** Epoch milliseconds. */
  readonly startedAt: number;
  readonly durationMs: number;
  readonly sampleCount: number;
  readonly busiestFrame: string | null;
}

export interface ProfileStartRequest {
  readonly sessionId: string;
  /** Epoch milliseconds. */
  readonly startedAt: number;
}

export type ProfileStartOutcome =
  | { status: "started" }
  | { status: "failed"; error: ProfilerError }
  | { status: "cancelled" };

export type ProfileStopOutcome =
  | { status: "stopped"; samples: readonly ProfileSample[] }
  | { status: "failed"; error: ProfilerError }
  | { status: "cancelled" };

/**
 * Where profile samples come from. The controller owns the state machine,
 * timeouts, cancellation, aggregation, history and reporting; a provider only
 * records and hands back samples.
 */
export interface ProfilerProvider {
  /** Display name, e.g. "Mock Profiler". */
  readonly label: string;
  /** Machine-readable family, e.g. "local-mock". */
  readonly providerType: string;
  /** True while the provider generates its samples rather than measuring them. */
  readonly simulated: boolean;
  /** One sentence the UI shows wherever the data is presented. */
  readonly description: string;
  start: (request: ProfileStartRequest, options: { signal: AbortSignal }) => Promise<ProfileStartOutcome>;
  /** Ends the recording and reports what it collected. */
  stop: (
    sessionId: string,
    context: { endedAt: number; durationMs: number },
    options: { signal: AbortSignal },
  ) => Promise<ProfileStopOutcome>;
  /** The samples of a finished session, for re-reading them. Null when it holds none. */
  read: (sessionId: string) => readonly ProfileSample[] | null;
  /** Forgets every session it holds. */
  clear: () => void;
}

/** What the UI may know about the provider without reaching for the implementation. */
export interface ProfilerProviderInfo {
  readonly label: string;
  readonly providerType: string;
  readonly simulated: boolean;
  readonly description: string;
}

export interface ProfilerSnapshot {
  readonly state: ProfilerState;
  /** The recording in progress, or the last one to finish; null before the first. */
  readonly session: ProfileSession | null;
  /** Epoch milliseconds the current recording started at, or null. */
  readonly recordingSince: number | null;
  /** An operation is in flight. */
  readonly busy: boolean;
  /** The latest failure, set while `state` is "error". */
  readonly error: ProfilerError | null;
  /** Newest first. */
  readonly history: readonly ProfileHistoryEntry[];
}
