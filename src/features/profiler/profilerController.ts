import { aggregateFrames, summarize } from "@/features/profiler/profilerModel";
import { STARTABLE_PROFILER_STATES, transitionProfiler } from "@/features/profiler/profilerState";
import type {
  ProfileHistoryEntry,
  ProfileSample,
  ProfileSession,
  ProfilerError,
  ProfilerProvider,
  ProfilerProviderInfo,
  ProfilerSnapshot,
  ProfilerState,
} from "@/features/profiler/types";
import { systemClock, type Clock, type TimerId } from "@/lib/clock";
import { createId } from "@/lib/id";
import { logger } from "@/lib/logger";

export type ProfilerLog = Pick<typeof logger, "debug" | "info" | "warn" | "error">;

/** How long a provider has to answer one operation. */
export const PROFILER_OPERATION_TIMEOUT_MS = 5000;

/** Finished recordings kept for this session. */
export const PROFILER_HISTORY_LIMIT = 10;

export type ProfilerOperationResult =
  | { status: "started" }
  | { status: "stopped"; session: ProfileSession }
  | { status: "failed"; error: ProfilerError }
  | { status: "cancelled" };

export type ProfilerSubmission =
  | { accepted: false; error: ProfilerError }
  | { accepted: true; sessionId: string; settled: Promise<ProfilerOperationResult> };

export interface ProfilerControllerOptions {
  provider: ProfilerProvider;
  clock?: Clock;
  createId?: () => string;
  historyLimit?: number;
  operationTimeoutMs?: number;
  log?: ProfilerLog;
}

export interface ProfilerController {
  readonly provider: ProfilerProviderInfo;
  getSnapshot: () => ProfilerSnapshot;
  subscribe: (listener: () => void) => () => void;
  /** Whether a target exists for the profiler to work against. */
  setTargetPresent: (present: boolean) => void;
  /** Begins a recording. Never throws; the settled promise never rejects. */
  start: () => ProfilerSubmission;
  /** Ends the recording and aggregates what it collected. */
  stop: () => ProfilerSubmission;
  /** Forgets the shown session and the history. */
  clear: () => void;
  /** Reads the last session from the provider again and aggregates it afresh. */
  refresh: () => boolean;
  dispose: () => void;
}

interface Operation {
  seq: number;
  abort: AbortController;
  timer: TimerId | null;
  settled: boolean;
  resolve: (result: ProfilerOperationResult) => void;
}

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

const errorData = (error: ProfilerError) =>
  error.details === undefined ? error.code : `${error.code}: ${error.details}`;

/**
 * The profiler pipeline, and the single source of truth for profiler state.
 *
 * It owns the state machine, the recording window, operation timeouts,
 * cancellation, aggregation, session history and what reaches the console. A
 * provider only records and hands back samples, so replacing the provider
 * replaces where the numbers come from and nothing else.
 *
 * Nothing here is persisted: a recording describes a moment, not a setting.
 */
export function createProfilerController(options: ProfilerControllerOptions): ProfilerController {
  const { provider } = options;
  const clock = options.clock ?? systemClock;
  const log = options.log ?? logger;
  const newId = options.createId ?? createId;
  const historyLimit = options.historyLimit ?? PROFILER_HISTORY_LIMIT;
  const timeoutMs = options.operationTimeoutMs ?? PROFILER_OPERATION_TIMEOUT_MS;
  const label = provider.label;

  const listeners = new Set<() => void>();
  let snapshot: ProfilerSnapshot = {
    state: "unavailable",
    session: null,
    recordingSince: null,
    busy: false,
    error: null,
    history: [],
  };

  let operation: Operation | null = null;
  let operationSeq = 0;
  let recordingId: string | null = null;
  let targetPresent = false;
  let disposed = false;

  const setSnapshot = (patch: Partial<ProfilerSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of [...listeners]) listener();
  };

  const moveTo = (state: ProfilerState, patch: Partial<Omit<ProfilerSnapshot, "state">> = {}) =>
    setSnapshot({ ...patch, state: transitionProfiler(snapshot.state, state) });

  /** Where the profiler rests once nothing is in flight. */
  const restingState = (): ProfilerState => (targetPresent ? "ready" : "unavailable");

  const buildSession = (
    id: string,
    startedAt: number,
    endedAt: number,
    samples: readonly ProfileSample[],
  ): ProfileSession => {
    const frames = aggregateFrames(samples);
    return Object.freeze({
      id,
      provider: label,
      startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      samples,
      frames,
      summary: summarize(samples, frames),
      simulated: provider.simulated,
    });
  };

  const historyEntry = (session: ProfileSession): ProfileHistoryEntry => ({
    id: session.id,
    startedAt: session.startedAt,
    durationMs: session.durationMs,
    sampleCount: session.summary.sampleCount,
    busiestFrame: session.summary.busiestFrame,
  });

  /** Stops the operation in flight, if any, without touching state. */
  const abandonOperation = () => {
    const current = operation;
    operation = null;
    if (!current) return null;
    clock.clearTimeout(current.timer);
    current.timer = null;
    current.abort.abort();
    return current;
  };

  const refuse = (error: ProfilerError): ProfilerSubmission => {
    log.warn(`Profiler operation not started: ${error.message}`, errorData(error));
    return { accepted: false, error };
  };

  const fail = (error: ProfilerError): ProfilerOperationResult => {
    recordingId = null;
    moveTo("error", { busy: false, recordingSince: null, error });
    log.error(`Profiler failed: ${error.message}`, errorData(error));
    return { status: "failed", error };
  };

  /**
   * Runs one provider operation with its timeout, cancellation and staleness
   * handling. The operation is handed an `isLive` check and must consult it
   * before applying anything: a result that arrived after something else took
   * over describes a run nobody is waiting for.
   */
  const run = (
    sessionId: string,
    onTimeoutError: ProfilerError,
    start: (signal: AbortSignal, isLive: () => boolean) => Promise<ProfilerOperationResult>,
  ): ProfilerSubmission => {
    let resolve!: (result: ProfilerOperationResult) => void;
    const settled = new Promise<ProfilerOperationResult>((done) => {
      resolve = done;
    });

    operationSeq += 1;
    const current: Operation = {
      seq: operationSeq,
      abort: new AbortController(),
      timer: null,
      settled: false,
      resolve,
    };
    operation = current;

    const finish = (result: ProfilerOperationResult) => {
      current.settled = true;
      clock.clearTimeout(current.timer);
      current.timer = null;
      if (operation === current) operation = null;
      current.resolve(result);
    };

    current.timer = clock.setTimeout(() => {
      if (current.settled) return;
      current.timer = null;
      // Stop the provider first, so a late answer cannot revive the operation.
      current.abort.abort();
      finish(fail(onTimeoutError));
    }, timeoutMs);

    const isLive = () => operation === current && !current.settled && !disposed;

    let pending: Promise<ProfilerOperationResult>;
    try {
      pending = start(current.abort.signal, isLive);
    } catch (error) {
      pending = Promise.reject(error);
    }

    Promise.resolve(pending).then(
      (result) => {
        if (current.settled || disposed) {
          log.debug(`Ignored a late provider result for profiler operation ${current.seq}`);
          return;
        }
        if (operation !== current) {
          current.settled = true;
          current.resolve({ status: "cancelled" });
          log.debug(`Ignored a stale provider result for profiler operation ${current.seq}`);
          return;
        }
        finish(result);
      },
      (error: unknown) => {
        if (current.settled || disposed || operation !== current) return;
        finish(
          fail({
            code: "PROFILER_SESSION_FAILED",
            message: `The ${label} failed.`,
            details: describeError(error),
          }),
        );
      },
    );

    return { accepted: true, sessionId, settled };
  };

  const start = (): ProfilerSubmission => {
    if (!targetPresent || snapshot.state === "unavailable") {
      return refuse({
        code: "PROFILER_UNAVAILABLE",
        message: "There is no target to record against.",
        details: "Detect a target before starting a recording.",
      });
    }
    if (snapshot.busy) {
      return refuse({ code: "PROFILER_BUSY", message: "A profiler operation is already in progress." });
    }
    if (!STARTABLE_PROFILER_STATES.includes(snapshot.state)) {
      return refuse({
        code: "PROFILER_NOT_READY",
        message: "A recording is already running.",
        details: "Stop the current recording before starting another one.",
      });
    }

    const sessionId = newId();
    const startedAt = clock.now();
    recordingId = sessionId;

    moveTo("recording", { busy: true, recordingSince: startedAt, session: null, error: null });
    log.info("Profiler recording started", `Provider: ${label}`);

    return run(
      sessionId,
      {
        code: "PROFILER_TIMEOUT",
        message: `The ${label} did not start within ${timeoutMs} ms.`,
        details: "The request was abandoned; a late answer is ignored.",
      },
      async (signal, isLive) => {
        const outcome = await provider.start({ sessionId, startedAt }, { signal });
        if (!isLive()) return { status: "cancelled" };
        if (outcome.status === "failed") return fail(outcome.error);
        if (outcome.status === "cancelled") {
          recordingId = null;
          moveTo(restingState(), { busy: false, recordingSince: null });
          log.warn("Profiler recording was cancelled before it started", `Provider: ${label}`);
          return { status: "cancelled" };
        }
        setSnapshot({ busy: false });
        return { status: "started" };
      },
    );
  };

  const stop = (): ProfilerSubmission => {
    const sessionId = recordingId;
    if (sessionId === null || snapshot.state !== "recording") {
      return refuse({ code: "PROFILER_NO_SESSION", message: "There is no recording to stop." });
    }
    if (snapshot.busy) {
      return refuse({ code: "PROFILER_BUSY", message: "A profiler operation is already in progress." });
    }

    const startedAt = snapshot.recordingSince ?? clock.now();
    setSnapshot({ busy: true });
    log.debug("Profiler recording stopping", `Provider: ${label}`);

    return run(
      sessionId,
      {
        code: "PROFILER_TIMEOUT",
        message: `The ${label} did not answer within ${timeoutMs} ms.`,
        details: "The recording was abandoned; a late answer is ignored.",
      },
      async (signal, isLive) => {
        const endedAt = clock.now();
        const outcome = await provider.stop(
          sessionId,
          { endedAt, durationMs: Math.max(0, endedAt - startedAt) },
          { signal },
        );

        if (!isLive()) return { status: "cancelled" };
        if (outcome.status === "failed") return fail(outcome.error);
        if (outcome.status === "cancelled") {
          recordingId = null;
          moveTo(restingState(), { busy: false, recordingSince: null });
          log.warn("Profiler recording was cancelled", `Provider: ${label}`);
          return { status: "cancelled" };
        }

        recordingId = null;
        const session = buildSession(sessionId, startedAt, endedAt, outcome.samples);
        moveTo(restingState(), {
          busy: false,
          recordingSince: null,
          session,
          error: null,
          history: [historyEntry(session), ...snapshot.history].slice(0, historyLimit),
        });
        log.info(
          `Profiler recording stopped: ${session.summary.sampleCount} samples over ${session.durationMs} ms`,
          // Derived, never asserted: the two sibling log lines read the same
          // flag, and a real provider's numbers must not be called generated.
          `Provider: ${label}${provider.simulated ? " (simulated data)" : ""}`,
        );
        return { status: "stopped", session };
      },
    );
  };

  return {
    provider: Object.freeze({
      label,
      providerType: provider.providerType,
      simulated: provider.simulated,
      description: provider.description,
    }),
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setTargetPresent: (present) => {
      if (disposed || present === targetPresent) return;
      targetPresent = present;

      if (present) {
        if (snapshot.state === "unavailable") moveTo("ready", { error: null });
        return;
      }

      if (snapshot.state === "recording") {
        const error: ProfilerError = {
          code: "TARGET_DISCONNECTED",
          message: "The target went away, so the recording was stopped.",
          details: `Provider: ${label}`,
        };
        abandonOperation()?.resolve({ status: "failed", error });
        recordingId = null;
        moveTo("unavailable", { busy: false, recordingSince: null, error });
        log.warn("Profiler recording stopped: the target went away", errorData(error));
        return;
      }

      abandonOperation()?.resolve({ status: "cancelled" });
      moveTo("unavailable", { busy: false, recordingSince: null });
    },

    start,
    stop,

    clear: () => {
      if (snapshot.state === "recording") {
        log.debug("Clear was ignored while a recording is running");
        return;
      }
      provider.clear();
      const resting = restingState();
      const patch = { session: null, history: [], error: null, busy: false, recordingSince: null };
      if (snapshot.state === resting) setSnapshot(patch);
      else moveTo(resting, patch);
      log.info("Profiler sessions cleared");
    },

    refresh: () => {
      const session = snapshot.session;
      if (session === null) {
        log.debug("Refresh was ignored: there is no session to read again");
        return false;
      }

      const samples = provider.read(session.id);
      if (samples === null) {
        log.warn("The profiler provider no longer holds this session, so it was left as it is");
        return false;
      }

      setSnapshot({ session: buildSession(session.id, session.startedAt, session.endedAt ?? session.startedAt, samples) });
      log.debug("Profiler session read again from the provider");
      return true;
    },

    dispose: () => {
      disposed = true;
      abandonOperation()?.resolve({ status: "cancelled" });
      listeners.clear();
      recordingId = null;
    },
  };
}
