import {
  addBreakpoint as addToList,
  clearBreakpoints as clearList,
  findBreakpoint,
  findBreakpointById,
  isValidBreakpointLine,
  removeBreakpoint as removeFromList,
  resetHitCounts,
  updateBreakpoint,
} from "@/features/debugger/breakpoints";
import { STARTABLE_DEBUG_STATES, transitionDebug } from "@/features/debugger/debuggerState";
import type {
  Breakpoint,
  DebugContext,
  DebugError,
  DebugPauseReason,
  DebugResumeMode,
  DebugRunOutcome,
  DebugSession,
  DebugState,
  DebugStopReason,
  DebugTarget,
  DebuggerProvider,
  DebuggerProviderInfo,
  DebuggerSnapshot,
  StackFrame,
  WatchEntry,
} from "@/features/debugger/types";
import { systemClock, type Clock, type TimerId } from "@/lib/clock";
import { createId } from "@/lib/id";
import { logger } from "@/lib/logger";

export type DebuggerLog = Pick<typeof logger, "debug" | "info" | "warn" | "error">;

/** How long a provider has to answer one operation. */
export const DEBUG_OPERATION_TIMEOUT_MS = 5000;

/** At most this many watch expressions are kept. */
export const WATCH_LIMIT = 20;

export type DebugOperationResult =
  | { status: "paused"; reason: DebugPauseReason }
  | { status: "completed" }
  | { status: "failed"; error: DebugError }
  | { status: "cancelled" };

export type DebugSubmission =
  | { accepted: false; error: DebugError }
  | { accepted: true; sessionId: string; settled: Promise<DebugOperationResult> };

export type DebugPauseRequestResult = "requested" | "already-requested" | "not-running" | "unsupported";

export type BreakpointResult =
  | { status: "added"; breakpoint: Breakpoint }
  | { status: "removed"; breakpoint: Breakpoint }
  | { status: "exists"; breakpoint: Breakpoint }
  | { status: "missing" }
  | { status: "invalid"; error: DebugError };

export interface DebuggerControllerOptions {
  provider: DebuggerProvider;
  clock?: Clock;
  createId?: () => string;
  /** Breakpoints restored from local configuration. */
  breakpoints?: readonly Breakpoint[];
  /** Called whenever the breakpoint list changes, so it can be persisted. */
  onBreakpointsChanged?: (breakpoints: readonly Breakpoint[]) => void;
  operationTimeoutMs?: number;
  log?: DebuggerLog;
}

export interface DebuggerController {
  readonly provider: DebuggerProviderInfo;
  getSnapshot: () => DebuggerSnapshot;
  subscribe: (listener: () => void) => () => void;
  /** Whether a target exists for the debugger to work against. */
  setTargetPresent: (present: boolean) => void;
  /** Starts a session for one script. Never throws; the settled promise never rejects. */
  start: (request: { target: DebugTarget; context?: DebugContext | null }) => DebugSubmission;
  /** Leaves a stop: continue, or one of the three steps. */
  resume: (mode: DebugResumeMode) => DebugSubmission;
  /** Asks the run in progress to stop at the next execution point. */
  pause: () => DebugPauseRequestResult;
  /** Ends the session, or dismisses a finished one. */
  stop: () => Promise<void>;
  /** Shows the variables and watches of another frame of the current stop. */
  selectFrame: (frameId: string) => void;
  addBreakpoint: (scriptId: string, line: number, condition?: string) => BreakpointResult;
  removeBreakpointAt: (scriptId: string, line: number) => BreakpointResult;
  removeBreakpoint: (id: string) => BreakpointResult;
  toggleBreakpoint: (scriptId: string, line: number) => BreakpointResult;
  setBreakpointEnabled: (id: string, enabled: boolean) => BreakpointResult;
  clearBreakpoints: (scriptId?: string) => number;
  addWatch: (expression: string) => WatchEntry | null;
  removeWatch: (id: string) => void;
  clearWatches: () => void;
  /** Evaluates every watch against the current frame again. */
  refreshWatches: () => void;
  dispose: () => void;
}

interface Operation {
  seq: number;
  kind: "start" | "resume";
  abort: AbortController;
  timer: TimerId | null;
  settled: boolean;
  resolve: (result: DebugOperationResult) => void;
}

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

const errorData = (error: DebugError) => (error.details === undefined ? error.code : `${error.code}: ${error.details}`);

const PAUSE_TEXT: Record<DebugPauseReason, string> = {
  entry: "at the first line",
  breakpoint: "on a breakpoint",
  step: "after a step",
  pause: "where it was paused",
};

/**
 * The debugger pipeline, and the single source of truth for debugger state.
 *
 * It owns the state machine, the session, breakpoints, the selected frame,
 * watches, operation timeouts, cancellation and what reaches the console. A
 * provider only runs, stops and answers questions about the stop it is at, so
 * replacing the provider replaces the execution model and nothing else.
 *
 * Only breakpoints leave this controller: they are configuration and are
 * persisted. Session state never is — Nova always starts with no session.
 */
export function createDebuggerController(options: DebuggerControllerOptions): DebuggerController {
  const { provider } = options;
  const clock = options.clock ?? systemClock;
  const log = options.log ?? logger;
  const newId = options.createId ?? createId;
  const timeoutMs = options.operationTimeoutMs ?? DEBUG_OPERATION_TIMEOUT_MS;
  const persist = options.onBreakpointsChanged;
  const label = provider.label;

  const listeners = new Set<() => void>();
  let snapshot: DebuggerSnapshot = {
    state: "unavailable",
    session: null,
    stack: [],
    currentFrameId: null,
    locals: [],
    breakpoints: options.breakpoints ?? [],
    watches: [],
    pauseReason: null,
    busy: false,
    pausePending: false,
    error: null,
  };

  let operation: Operation | null = null;
  let operationSeq = 0;
  let targetPresent = false;
  let disposed = false;

  const publish = () => {
    for (const listener of [...listeners]) listener();
  };

  const setSnapshot = (patch: Partial<DebuggerSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    publish();
  };

  const moveTo = (state: DebugState, patch: Partial<Omit<DebuggerSnapshot, "state">> = {}) =>
    setSnapshot({ ...patch, state: transitionDebug(snapshot.state, state) });

  const setBreakpoints = (breakpoints: readonly Breakpoint[], patch: Partial<DebuggerSnapshot> = {}) => {
    if (breakpoints === snapshot.breakpoints) {
      if (Object.keys(patch).length > 0) setSnapshot(patch);
      return;
    }
    setSnapshot({ ...patch, breakpoints });
    persist?.(breakpoints);
  };

  /** Reads the variables of a frame, never letting a provider failure reach the UI. */
  const readVariables = (sessionId: string, frameId: string) => {
    try {
      return provider.getVariables(sessionId, frameId);
    } catch (error) {
      log.error("The debugger provider could not report the variables of this frame", describeError(error));
      return [];
    }
  };

  const evaluateWatch = (sessionId: string | null, frameId: string | null, entry: WatchEntry): WatchEntry => {
    if (sessionId === null || frameId === null) {
      return { ...entry, value: null, type: null, error: null };
    }
    try {
      const evaluation = provider.evaluate(sessionId, frameId, entry.expression);
      if (evaluation.status === "ok") {
        return { ...entry, value: evaluation.value, type: evaluation.type, error: null };
      }
      return {
        ...entry,
        value: null,
        type: null,
        error: { code: evaluation.error.code, message: evaluation.error.message },
      };
    } catch (error) {
      log.error(`Watch "${entry.expression}" could not be evaluated`, describeError(error));
      return {
        ...entry,
        value: null,
        type: null,
        error: { code: "WATCH_EVALUATION_FAILED", message: "The provider could not evaluate this watch." },
      };
    }
  };

  const evaluateAll = (
    watches: readonly WatchEntry[],
    sessionId: string | null,
    frameId: string | null,
  ): readonly WatchEntry[] => watches.map((entry) => evaluateWatch(sessionId, frameId, entry));

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

  const endSession = (reason: DebugStopReason, error: DebugError | null) => {
    const session = snapshot.session;
    if (session === null) return;
    setSnapshot({
      session: { ...session, endedAt: clock.now(), stopReason: reason },
      stack: [],
      currentFrameId: null,
      locals: [],
      pauseReason: null,
      pausePending: false,
      watches: evaluateAll(snapshot.watches, null, null),
      error,
    });
  };

  /** Applies what a provider reported for a run or a step. */
  const applyOutcome = (outcome: DebugRunOutcome): DebugOperationResult => {
    if (outcome.status === "paused") {
      const session = snapshot.session;
      const stack: readonly StackFrame[] = outcome.stop.stack;
      const frame = stack[0] ?? null;
      const sessionId = session?.id ?? null;
      const locals = sessionId !== null && frame !== null ? readVariables(sessionId, frame.id) : [];

      let breakpoints = snapshot.breakpoints;
      if (outcome.stop.reason === "breakpoint" && session !== null) {
        const hit = findBreakpoint(breakpoints, session.target.scriptId, outcome.stop.line);
        if (hit !== null) breakpoints = updateBreakpoint(breakpoints, hit.id, { hitCount: hit.hitCount + 1 });
      }

      const patch = {
        stack,
        currentFrameId: frame?.id ?? null,
        locals,
        pauseReason: outcome.stop.reason,
        pausePending: false,
        busy: false,
        error: null,
        watches: evaluateAll(snapshot.watches, sessionId, frame?.id ?? null),
      };

      // One publish, with the breakpoint hit count included when there was one.
      if (breakpoints !== snapshot.breakpoints) {
        setBreakpoints(breakpoints, { ...patch, state: transitionDebug(snapshot.state, "paused") });
      } else {
        moveTo("paused", patch);
      }

      log.info(
        `Execution stopped ${PAUSE_TEXT[outcome.stop.reason]} (line ${outcome.stop.line})`,
        `Provider: ${label}`,
      );
      return { status: "paused", reason: outcome.stop.reason };
    }

    if (outcome.status === "completed") {
      moveTo("stopped", { busy: false });
      endSession("completed", null);
      log.info("The debug session ran to completion", `Provider: ${label}`);
      return { status: "completed" };
    }

    if (outcome.status === "cancelled") {
      moveTo("stopped", { busy: false });
      endSession("stopped", null);
      log.warn("The debug operation was cancelled", `Provider: ${label}`);
      return { status: "cancelled" };
    }

    moveTo("error", { busy: false, pausePending: false, error: outcome.error });
    endSession("failed", outcome.error);
    log.error(`Debug session failed: ${outcome.error.message}`, errorData(outcome.error));
    return { status: "failed", error: outcome.error };
  };

  const finish = (run: Operation, outcome: DebugRunOutcome) => {
    run.settled = true;
    clock.clearTimeout(run.timer);
    run.timer = null;
    if (operation === run) operation = null;
    run.resolve(applyOutcome(outcome));
  };

  const settle = (run: Operation, outcome: DebugRunOutcome) => {
    if (run.settled || disposed) {
      log.debug(`Ignored a late provider result for debug operation ${run.seq}`);
      return;
    }
    if (operation !== run) {
      // Something else already took over: the result describes a run nobody is
      // waiting for any more, so it is dropped rather than applied.
      run.settled = true;
      run.resolve({ status: "cancelled" });
      log.debug(`Ignored a stale provider result for debug operation ${run.seq}`);
      return;
    }
    finish(run, outcome);
  };

  const onTimeout = (run: Operation) => {
    if (run.settled) return;
    run.timer = null;
    // Stop the provider first, so a late answer cannot promote a timed-out
    // operation into a stop.
    run.abort.abort();
    finish(run, {
      status: "failed",
      error: {
        code: "DEBUGGER_TIMEOUT",
        message: `The ${label} did not answer within ${timeoutMs} ms.`,
        details: "The operation was abandoned; a late answer is ignored.",
      },
    });
  };

  const refuse = (error: DebugError): DebugSubmission => {
    log.warn(`Debug operation not started: ${error.message}`, errorData(error));
    return { accepted: false, error };
  };

  /** Runs one provider operation with its timeout, cancellation and staleness handling. */
  const run = (
    kind: Operation["kind"],
    sessionId: string,
    start: (signal: AbortSignal) => Promise<DebugRunOutcome>,
  ): DebugSubmission => {
    let resolve!: (result: DebugOperationResult) => void;
    const settled = new Promise<DebugOperationResult>((done) => {
      resolve = done;
    });

    operationSeq += 1;
    const current: Operation = {
      seq: operationSeq,
      kind,
      abort: new AbortController(),
      timer: null,
      settled: false,
      resolve,
    };
    operation = current;
    current.timer = clock.setTimeout(() => onTimeout(current), timeoutMs);

    let pending: Promise<DebugRunOutcome>;
    try {
      pending = start(current.abort.signal);
    } catch (error) {
      pending = Promise.reject(error);
    }
    Promise.resolve(pending).then(
      (outcome) => settle(current, outcome),
      (error: unknown) =>
        settle(current, {
          status: "failed",
          error: {
            code: "DEBUGGER_SESSION_FAILED",
            message: `The ${label} failed.`,
            details: describeError(error),
          },
        }),
    );

    return { accepted: true, sessionId, settled };
  };

  const start: DebuggerController["start"] = ({ target, context = null }) => {
    if (!targetPresent || snapshot.state === "unavailable") {
      return refuse({
        code: "DEBUGGER_UNAVAILABLE",
        message: "There is no target to debug against.",
        details: "Detect a target before starting a debug session.",
      });
    }
    if (snapshot.busy) {
      return refuse({ code: "DEBUGGER_BUSY", message: "A debug operation is already in progress." });
    }
    if (!STARTABLE_DEBUG_STATES.includes(snapshot.state)) {
      return refuse({
        code: "DEBUGGER_NOT_READY",
        message: "A debug session is already running.",
        details: "Stop the current session before starting another one.",
      });
    }
    if (target.lineCount < 1) {
      return refuse({
        code: "DEBUGGER_NOT_READY",
        message: "This script has nothing to step through.",
        details: `Script: ${target.scriptName}`,
      });
    }

    const session: DebugSession = Object.freeze({
      id: newId(),
      provider: label,
      target: Object.freeze({ ...target }),
      context,
      startedAt: clock.now(),
      endedAt: null,
      stopReason: null,
    });

    moveTo("running", {
      session,
      stack: [],
      currentFrameId: null,
      locals: [],
      pauseReason: null,
      pausePending: false,
      busy: true,
      error: null,
    });
    setBreakpoints(resetHitCounts(snapshot.breakpoints));
    log.info(`Debug session started for ${target.scriptName}`, `Provider: ${label}`);

    const breakpoints = snapshot.breakpoints;
    return run("start", session.id, (signal) =>
      provider.start(
        { sessionId: session.id, target: session.target, context, createdAt: session.startedAt },
        breakpoints,
        { signal },
      ),
    );
  };

  const resume: DebuggerController["resume"] = (mode) => {
    const session = snapshot.session;
    if (session === null || session.endedAt !== null) {
      return refuse({ code: "DEBUGGER_NO_SESSION", message: "There is no debug session to continue." });
    }
    if (snapshot.busy || snapshot.state === "running") {
      return refuse({ code: "DEBUGGER_BUSY", message: "The session is already running." });
    }
    if (snapshot.state !== "paused") {
      return refuse({
        code: "DEBUGGER_NOT_READY",
        message: "Execution is not paused, so there is nothing to continue.",
      });
    }

    moveTo("running", { busy: true, pausePending: false, error: null });
    log.debug(`Debug ${mode}`, `Provider: ${label}`);

    const breakpoints = snapshot.breakpoints;
    return run("resume", session.id, (signal) => provider.resume(session.id, mode, breakpoints, { signal }));
  };

  const pause = (): DebugPauseRequestResult => {
    const session = snapshot.session;
    if (session === null || snapshot.state !== "running") return "not-running";
    if (!provider.supportsCancel) return "unsupported";
    if (snapshot.pausePending) return "already-requested";

    setSnapshot({ pausePending: true });
    provider.requestPause(session.id);
    log.info("Pause requested", `Provider: ${label}`);
    return "requested";
  };

  const stop = async (): Promise<void> => {
    const session = snapshot.session;
    if (session === null) return;

    if (session.endedAt !== null) {
      // Nothing is running; this only clears the finished session.
      const resting: DebugState = targetPresent ? "ready" : "unavailable";
      if (snapshot.state !== resting) moveTo(resting, { error: null });
      return;
    }

    abandonOperation()?.resolve({ status: "cancelled" });
    moveTo("stopped", { busy: false, pausePending: false });
    endSession("stopped", null);
    log.info("Debug session stopped", `Provider: ${label}`);

    try {
      await provider.stop(session.id);
    } catch (error) {
      log.warn(`The ${label} reported an error while stopping`, describeError(error));
    }
  };

  const selectFrame = (frameId: string) => {
    const session = snapshot.session;
    if (session === null || snapshot.state !== "paused") return;
    if (!snapshot.stack.some((frame) => frame.id === frameId)) {
      log.debug("A frame that is not in the current stack was selected", frameId);
      return;
    }
    if (snapshot.currentFrameId === frameId) return;

    setSnapshot({
      currentFrameId: frameId,
      locals: readVariables(session.id, frameId),
      watches: evaluateAll(snapshot.watches, session.id, frameId),
    });
  };

  const invalidLine = (line: number): Extract<BreakpointResult, { status: "invalid" }> => ({
    status: "invalid",
    error: {
      code: "BREAKPOINT_INVALID",
      message: "A breakpoint needs a line number of 1 or more.",
      details: `Requested line: ${String(line)}`,
    },
  });

  const addBreakpoint = (scriptId: string, line: number, condition?: string): BreakpointResult => {
    if (scriptId === "" || !isValidBreakpointLine(line)) {
      const result = invalidLine(line);
      log.warn(`Breakpoint not added: ${result.error.message}`, errorData(result.error));
      return result;
    }

    const existing = findBreakpoint(snapshot.breakpoints, scriptId, line);
    if (existing !== null) return { status: "exists", breakpoint: existing };

    const next = addToList(
      snapshot.breakpoints,
      { scriptId, line, ...(condition === undefined ? {} : { condition }) },
      newId,
    );
    setBreakpoints(next);
    const added = findBreakpoint(next, scriptId, line);
    log.debug(`Breakpoint added on line ${line}`);
    return added === null ? { status: "missing" } : { status: "added", breakpoint: added };
  };

  const removeBreakpoint = (id: string): BreakpointResult => {
    const existing = findBreakpointById(snapshot.breakpoints, id);
    if (existing === null) return { status: "missing" };
    setBreakpoints(removeFromList(snapshot.breakpoints, id));
    log.debug(`Breakpoint removed from line ${existing.line}`);
    return { status: "removed", breakpoint: existing };
  };

  const removeBreakpointAt = (scriptId: string, line: number): BreakpointResult => {
    const existing = findBreakpoint(snapshot.breakpoints, scriptId, line);
    return existing === null ? { status: "missing" } : removeBreakpoint(existing.id);
  };

  return {
    provider: Object.freeze({
      label,
      providerType: provider.providerType,
      simulated: provider.simulated,
      supportsCancel: provider.supportsCancel,
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

      const session = snapshot.session;
      if (session !== null && session.endedAt === null) {
        const error: DebugError = {
          code: "TARGET_DISCONNECTED",
          message: "The target went away, so the debug session was stopped.",
          details: `Provider: ${label}`,
        };
        abandonOperation()?.resolve({ status: "failed", error });
        moveTo("stopped", { busy: false, pausePending: false });
        endSession("target-lost", error);
        log.warn("Debug session stopped: the target went away", errorData(error));
        void Promise.resolve(provider.stop(session.id)).catch((stopError: unknown) =>
          log.debug("Provider cleanup after losing the target failed", describeError(stopError)),
        );
      }

      moveTo("unavailable", { busy: false, pausePending: false });
    },

    start,
    resume,
    pause,
    stop,
    selectFrame,
    addBreakpoint,
    removeBreakpoint,
    removeBreakpointAt,

    toggleBreakpoint: (scriptId, line) => {
      const existing = findBreakpoint(snapshot.breakpoints, scriptId, line);
      return existing === null ? addBreakpoint(scriptId, line) : removeBreakpoint(existing.id);
    },

    setBreakpointEnabled: (id, enabled) => {
      const existing = findBreakpointById(snapshot.breakpoints, id);
      if (existing === null) return { status: "missing" };
      setBreakpoints(updateBreakpoint(snapshot.breakpoints, id, { enabled }));
      const updated = findBreakpointById(snapshot.breakpoints, id);
      return updated === null ? { status: "missing" } : { status: "exists", breakpoint: updated };
    },

    clearBreakpoints: (scriptId) => {
      const before = snapshot.breakpoints.length;
      setBreakpoints(scriptId === undefined ? clearList(snapshot.breakpoints) : clearList(snapshot.breakpoints, scriptId));
      const removed = before - snapshot.breakpoints.length;
      if (removed > 0) log.info(`${removed} breakpoint${removed === 1 ? "" : "s"} cleared`);
      return removed;
    },

    addWatch: (expression) => {
      const trimmed = expression.trim();
      if (trimmed === "") return null;
      if (snapshot.watches.some((entry) => entry.expression === trimmed)) return null;
      if (snapshot.watches.length >= WATCH_LIMIT) {
        log.warn(`At most ${WATCH_LIMIT} watches are kept; remove one before adding another.`);
        return null;
      }

      const entry = evaluateWatch(
        snapshot.state === "paused" ? (snapshot.session?.id ?? null) : null,
        snapshot.state === "paused" ? snapshot.currentFrameId : null,
        { id: newId(), expression: trimmed, value: null, type: null, error: null },
      );
      setSnapshot({ watches: [...snapshot.watches, entry] });
      return entry;
    },

    removeWatch: (id) => {
      const watches = snapshot.watches.filter((entry) => entry.id !== id);
      if (watches.length !== snapshot.watches.length) setSnapshot({ watches });
    },

    clearWatches: () => {
      if (snapshot.watches.length > 0) setSnapshot({ watches: [] });
    },

    refreshWatches: () => {
      if (snapshot.watches.length === 0) return;
      const paused = snapshot.state === "paused";
      setSnapshot({
        watches: evaluateAll(
          snapshot.watches,
          paused ? (snapshot.session?.id ?? null) : null,
          paused ? snapshot.currentFrameId : null,
        ),
      });
    },

    dispose: () => {
      disposed = true;
      const session = snapshot.session;
      abandonOperation()?.resolve({ status: "cancelled" });
      listeners.clear();
      if (session !== null && session.endedAt === null) {
        void Promise.resolve(provider.stop(session.id)).catch((error: unknown) =>
          log.debug("Provider cleanup on dispose failed", describeError(error)),
        );
      }
    },
  };
}
