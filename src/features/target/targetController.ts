import {
  appendTargetHistory,
  createDisconnectHistoryEntry,
  createInjectHistoryEntry,
  TARGET_HISTORY_LIMIT,
} from "@/features/target/history";
import { INJECTABLE_STATUSES, transitionTarget } from "@/features/target/targetState";
import type {
  InjectOutcome,
  InjectRequest,
  InjectResult,
  TargetDetection,
  TargetError,
  TargetProvider,
  TargetSnapshot,
  TargetStatus,
} from "@/features/target/types";
import { systemClock, type Clock, type TimerId } from "@/lib/clock";
import { createId } from "@/lib/id";
import { logger } from "@/lib/logger";

export type TargetLog = Pick<typeof logger, "debug" | "info" | "warn" | "error">;

const DEFAULT_INJECT_TIMEOUT_MS = 5000;

/** The Settings › Target behaviours, read when they are needed so changes apply at once. */
export interface TargetPolicy {
  autoDetect: boolean;
  autoInject: boolean;
  autoReconnect: boolean;
  injectTimeoutMs: number;
}

const DEFAULT_POLICY: TargetPolicy = {
  autoDetect: false,
  autoInject: false,
  autoReconnect: false,
  injectTimeoutMs: DEFAULT_INJECT_TIMEOUT_MS,
};

export interface TargetControllerOptions {
  provider: TargetProvider;
  /** Read on every decision, so Settings changes need no restart. */
  policy?: () => TargetPolicy;
  clock?: Clock;
  createId?: () => string;
  historyLimit?: number;
  log?: TargetLog;
}

export interface InjectOptions {
  /** Overrides the policy's inject timeout. */
  timeoutMs?: number;
}

export type InjectSubmission =
  | { accepted: false; error: TargetError }
  | { accepted: true; requestId: string; result: Promise<InjectResult> };

export type CancelInjectResult = "requested" | "already-requested" | "not-injecting" | "unsupported";

/** What the UI may know about the provider without reaching for the implementation. */
export interface TargetProviderInfo {
  label: string;
  providerType: string;
  simulated: boolean;
  supportsCancel: boolean;
}

export interface TargetController {
  readonly provider: TargetProviderInfo;
  getSnapshot: () => TargetSnapshot;
  subscribe: (listener: () => void) => () => void;
  /** Runs one detection pass and applies what it found. */
  detect: () => Promise<TargetStatus>;
  /** Validates and starts an injection. Never throws; the result promise never rejects. */
  inject: (options?: InjectOptions) => InjectSubmission;
  /** Asks for the injection in progress to be cancelled. */
  cancelInject: () => CancelInjectResult;
  /** Ends the session, or dismisses a finished failure. */
  disconnect: () => Promise<void>;
  /** The startup pass for Auto detect / Auto inject; only the first call has any effect. */
  start: () => Promise<void>;
  /** Stops timers, abandons a request in flight and releases the provider. */
  dispose: () => void;
}

interface Attempt {
  request: InjectRequest;
  abort: AbortController;
  timer: TimerId | null;
  cancelRequested: boolean;
  settled: boolean;
  resolve: (result: InjectResult) => void;
}

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

const errorData = (error: TargetError) =>
  error.details === undefined ? error.code : `${error.code}: ${error.details}`;

/**
 * The target pipeline, and the single source of truth for target state.
 *
 * It owns the state machine, the inject request and its timeout, cancellation,
 * the session, detection (including Auto detect, Auto inject and Auto
 * reconnect), session history and what reaches the console. A provider only
 * detects, injects, disconnects and describes itself, so replacing the provider
 * replaces the mechanism and nothing else.
 *
 * Nothing here is persisted: Nova always starts with no target, so a stale
 * "injected" can never survive a restart.
 */
export function createTargetController(options: TargetControllerOptions): TargetController {
  const { provider } = options;
  const clock = options.clock ?? systemClock;
  const log = options.log ?? logger;
  const newId = options.createId ?? createId;
  const policy = options.policy ?? (() => DEFAULT_POLICY);
  const historyLimit = options.historyLimit ?? TARGET_HISTORY_LIMIT;
  const label = provider.label;

  const listeners = new Set<() => void>();
  let snapshot: TargetSnapshot = {
    status: "unavailable",
    detecting: false,
    session: "inactive",
    request: null,
    result: null,
    cancelling: false,
    error: null,
    diagnostics: provider.getDiagnostics(),
    history: [],
  };

  let attempt: Attempt | null = null;
  let disconnecting: Promise<void> | null = null;
  let detectPass = 0;
  let startHandled = false;
  let disposed = false;
  /** An unexpected disconnect happened and Auto reconnect was on when it did. */
  let reconnectPending = false;
  /** The last thing detection established about the target. */
  let known: TargetDetection = { available: false, ready: false, targetVersion: null };

  const setSnapshot = (patch: Partial<TargetSnapshot>) => {
    snapshot = { ...snapshot, ...patch, diagnostics: patch.diagnostics ?? provider.getDiagnostics() };
    for (const listener of [...listeners]) listener();
  };

  const moveTo = (status: TargetStatus, patch: Partial<Omit<TargetSnapshot, "status">> = {}) =>
    setSnapshot({ ...patch, status: transitionTarget(snapshot.status, status) });

  const record = (entry: Parameters<typeof appendTargetHistory>[1]) =>
    appendTargetHistory(snapshot.history, entry, historyLimit);

  /** Where the target rests once nothing is in flight. */
  const restingStatus = (): TargetStatus => (known.available && known.ready ? "ready" : "unavailable");

  /** Ends the attempt in flight, if any, without touching state. */
  const abandonAttempt = () => {
    const current = attempt;
    attempt = null;
    if (!current) return current;
    clock.clearTimeout(current.timer);
    current.timer = null;
    current.abort.abort();
    return current;
  };

  const finish = (run: Attempt, outcome: InjectOutcome) => {
    run.settled = true;
    clock.clearTimeout(run.timer);
    run.timer = null;
    if (attempt === run) attempt = null;

    const diagnostics = provider.getDiagnostics();
    const durationMs = Math.max(0, clock.now() - run.request.createdAt);
    const error = outcome.status === "failed" ? outcome.error : null;
    const result: InjectResult = Object.freeze({
      requestId: run.request.requestId,
      success: outcome.status === "injected",
      cancelled: outcome.status === "cancelled",
      durationMs,
      error,
      diagnostics,
    });

    const status = outcome.status === "injected" ? "injected" : outcome.status === "cancelled" ? "cancelled" : "error";
    moveTo(status, {
      result,
      error,
      cancelling: false,
      session: diagnostics.session,
      diagnostics,
      history: record(createInjectHistoryEntry(run.request, label, result)),
    });

    if (outcome.status === "injected") {
      log.info(`Injection completed (${durationMs} ms)`, `Provider: ${label}`);
    } else if (outcome.status === "cancelled") {
      log.warn(`Injection cancelled (${durationMs} ms)`, `Provider: ${label}`);
    } else {
      log.error(`Injection failed: ${outcome.error.message}`, errorData(outcome.error));
    }

    run.resolve(result);
  };

  const settle = (run: Attempt, outcome: InjectOutcome) => {
    if (run.settled) {
      log.debug(`Ignored a late provider result for inject request ${run.request.requestId}`);
      return;
    }
    finish(run, outcome);
  };

  const onTimeout = (run: Attempt, timeoutMs: number) => {
    if (run.settled) return;
    run.timer = null;
    // Stop the provider first, so a result arriving afterwards is ignored
    // rather than promoting a timed-out request to "injected".
    run.abort.abort();
    provider
      .disconnect()
      .catch((error: unknown) => log.debug("Provider cleanup after the timeout failed", describeError(error)));
    finish(run, {
      status: "failed",
      error: {
        code: "INJECTION_TIMEOUT",
        message: `The ${label} did not answer within ${timeoutMs} ms.`,
        details: run.cancelRequested
          ? "Cancellation had been requested, but the provider did not stop in time."
          : "The request was abandoned; a late answer is ignored.",
      },
    });
  };

  const refuse = (error: TargetError): InjectSubmission => {
    log.warn(`Injection not started: ${error.message}`, errorData(error));
    return { accepted: false, error };
  };

  const inject = (injectOptions: InjectOptions = {}): InjectSubmission => {
    const { status } = snapshot;

    if (status === "injected" || status === "disconnecting") {
      return refuse({
        code: "ALREADY_INJECTED",
        message: `The ${label} is already injected.`,
        details: "Disconnect before injecting again.",
      });
    }
    if (status === "injecting") {
      return refuse({ code: "TARGET_NOT_READY", message: "An injection is already in progress." });
    }
    if (status === "unavailable") {
      return refuse({ code: "TARGET_UNAVAILABLE", message: `No ${label} is available.` });
    }
    if (!INJECTABLE_STATUSES.includes(status)) {
      return refuse({ code: "TARGET_NOT_READY", message: `The ${label} is not ready yet.` });
    }

    const configured = injectOptions.timeoutMs ?? policy().injectTimeoutMs;
    const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_INJECT_TIMEOUT_MS;

    const request: InjectRequest = Object.freeze({
      requestId: newId(),
      createdAt: clock.now(),
      providerType: provider.providerType,
    });

    let resolve!: (result: InjectResult) => void;
    const result = new Promise<InjectResult>((done) => {
      resolve = done;
    });
    const run: Attempt = {
      request,
      abort: new AbortController(),
      timer: null,
      cancelRequested: false,
      settled: false,
      resolve,
    };
    attempt = run;

    moveTo("injecting", { request, result: null, error: null, cancelling: false });
    log.info("Injection started", `Provider: ${label}`);

    run.timer = clock.setTimeout(() => onTimeout(run, timeoutMs), timeoutMs);

    let pending: Promise<InjectOutcome>;
    try {
      pending = provider.inject(request, { signal: run.abort.signal });
    } catch (error) {
      pending = Promise.reject(error);
    }
    Promise.resolve(pending).then(
      (outcome) => settle(run, outcome),
      (error: unknown) =>
        settle(run, {
          status: "failed",
          error: {
            code: "INJECTION_FAILED",
            message: `The ${label} provider failed.`,
            details: describeError(error),
          },
        }),
    );

    return { accepted: true, requestId: request.requestId, result };
  };

  const cancelInject = (): CancelInjectResult => {
    const run = attempt;
    if (!run || run.settled || snapshot.status !== "injecting") return "not-injecting";
    // A provider that cannot stop safely must never be reported as cancelled.
    if (!provider.supportsCancel) return "unsupported";
    if (run.cancelRequested) return "already-requested";

    run.cancelRequested = true;
    setSnapshot({ cancelling: true });
    log.info("Cancelling the injection", `Provider: ${label}`);
    run.abort.abort();
    return "requested";
  };

  const settleToRest = (patch: Partial<Omit<TargetSnapshot, "status">> = {}) => {
    const next = restingStatus();
    if (snapshot.status === next) {
      setSnapshot(patch);
      return;
    }
    moveTo(next, patch);
  };

  const disconnect = (): Promise<void> => {
    const { status } = snapshot;

    if (status === "injecting") {
      cancelInject();
      return Promise.resolve();
    }
    if (status === "disconnecting") return disconnecting ?? Promise.resolve();
    if (status === "error" || status === "cancelled") {
      // Nothing is attached; this only dismisses the finished request.
      settleToRest({ error: null, cancelling: false });
      return Promise.resolve();
    }
    if (status !== "injected") return Promise.resolve();

    moveTo("disconnecting", { cancelling: false });
    log.info("Disconnecting the target", `Provider: ${label}`);

    const done = (async () => {
      try {
        await provider.disconnect();
      } catch (error) {
        log.warn(`The ${label} reported an error while disconnecting`, describeError(error));
      }
      disconnecting = null;
      if (snapshot.status !== "disconnecting") return;

      const diagnostics = provider.getDiagnostics();
      moveTo(restingStatus(), {
        session: diagnostics.session,
        diagnostics,
        result: null,
        error: null,
        history: record(
          createDisconnectHistoryEntry(snapshot.request?.requestId ?? newId(), label, clock.now()),
        ),
      });
      log.info("Target disconnected", `Provider: ${label}`);
    })();
    disconnecting = done;
    return done;
  };

  /** The target went away while something depended on it. */
  const reportLost = (details: string) => {
    const error: TargetError = {
      code: "TARGET_DISCONNECTED",
      message: `The ${label} went away.`,
      details,
    };
    reconnectPending = policy().autoReconnect;

    const run = abandonAttempt();
    if (run && !run.settled) {
      finish(run, { status: "failed", error });
      return;
    }

    moveTo("error", {
      error,
      result: null,
      cancelling: false,
      session: "inactive",
      history: record(
        createDisconnectHistoryEntry(snapshot.request?.requestId ?? newId(), label, clock.now(), {
          code: error.code,
          message: error.message,
        }),
      ),
    });
    log.warn("Target disconnected unexpectedly", errorData(error));
  };

  const maybeAutoInject = (reason: "auto-inject" | "auto-reconnect") => {
    if (snapshot.status !== "ready") return;
    log.info(reason === "auto-reconnect" ? "Auto reconnect: injecting" : "Auto inject: injecting", `Provider: ${label}`);
    inject();
  };

  /**
   * Applies what a detection pass (or a provider announcement) found.
   *
   * Losing the target is always applied — pretending to still be injected would
   * be a lie — while finding one is only followed automatically when Auto
   * detect is on; otherwise the user asks for a detection pass.
   */
  const applyDetection = (detection: TargetDetection, source: "pass" | "announcement") => {
    if (disposed) return;
    const { status } = snapshot;
    known = detection;

    if (!detection.available) {
      if (status === "injecting" || status === "injected") {
        reportLost(
          status === "injecting"
            ? "The target stopped being available while the injection was in flight."
            : "The target stopped being available while the session was active.",
        );
      }
      if (snapshot.status === "unavailable" || snapshot.status === "disconnecting") {
        setSnapshot({ session: "inactive" });
        return;
      }
      moveTo("unavailable", { session: "inactive", error: snapshot.status === "error" ? snapshot.error : null });
      log.info("Target is no longer available", `Provider: ${label}`);
      return;
    }

    if (source === "announcement" && status === "unavailable" && !policy().autoDetect) {
      log.debug("A target appeared; Auto detect is off, so it is left alone");
      return;
    }

    if (status === "unavailable") {
      moveTo("detected", { error: null });
      log.info("Target detected", `Provider: ${label}`);
    }
    if (!detection.ready) return;

    if (snapshot.status === "detected") {
      moveTo("ready");
      log.info("Target ready", `Provider: ${label}`);

      const { autoInject } = policy();
      if (reconnectPending) {
        reconnectPending = false;
        maybeAutoInject("auto-reconnect");
      } else if (autoInject) {
        maybeAutoInject("auto-inject");
      }
    }
  };

  const detect = async (): Promise<TargetStatus> => {
    const pass = ++detectPass;
    setSnapshot({ detecting: true });
    log.debug(`Checking for a target (${label})`);

    let detection: TargetDetection;
    try {
      detection = await provider.detect();
    } catch (error) {
      if (pass === detectPass && !disposed) setSnapshot({ detecting: false });
      log.error(`The ${label} provider could not be queried`, describeError(error));
      return snapshot.status;
    }

    if (pass !== detectPass || disposed) return snapshot.status;
    setSnapshot({ detecting: false });
    applyDetection(detection, "pass");
    return snapshot.status;
  };

  const unsubscribeProvider = provider.subscribe((detection) => applyDetection(detection, "announcement"));

  return {
    provider: Object.freeze({
      label,
      providerType: provider.providerType,
      simulated: provider.simulated,
      supportsCancel: provider.supportsCancel,
    }),
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    detect,
    inject,
    cancelInject,
    disconnect,
    start: async () => {
      if (startHandled) return;
      startHandled = true;
      if (!policy().autoDetect) {
        log.info("Auto detect is off; no target is being looked for", `Provider: ${label}`);
        return;
      }
      await detect();
    },
    dispose: () => {
      disposed = true;
      listeners.clear();
      unsubscribeProvider();
      const run = abandonAttempt();
      if (run && !run.settled) {
        run.settled = true;
        run.resolve(
          Object.freeze({
            requestId: run.request.requestId,
            success: false,
            cancelled: true,
            durationMs: Math.max(0, clock.now() - run.request.createdAt),
            error: null,
            diagnostics: provider.getDiagnostics(),
          }),
        );
      }
      if (snapshot.status === "injected" || snapshot.status === "injecting") {
        provider
          .disconnect()
          .catch((error: unknown) => log.debug("Provider cleanup on dispose failed", describeError(error)));
      }
    },
  };
}
