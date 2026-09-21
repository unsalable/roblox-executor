import {
  deriveCapabilities,
  describeProviders,
  normalizeHealth,
  restingHealth,
} from "@/features/backend/capabilities";
import {
  isBackendBusy,
  isBackendReady,
  STARTABLE_BACKEND_STATES,
  STOPPABLE_BACKEND_STATES,
  transitionBackend,
} from "@/features/backend/backendState";
import { DEVELOPER_TOOLS } from "@/features/backend/types";
import type {
  BackendDiagnostic,
  BackendError,
  BackendSnapshot,
  BackendState,
  DeveloperBackend,
  ProviderHealthReport,
} from "@/features/backend/types";
import { systemClock, type Clock, type TimerId } from "@/lib/clock";
import { logger } from "@/lib/logger";

export type BackendLog = Pick<typeof logger, "debug" | "info" | "warn" | "error">;

export const BACKEND_START_TIMEOUT_MS = 5000;
export const BACKEND_STOP_TIMEOUT_MS = 5000;

/** The Settings › Developer behaviours, read when they are needed so changes apply at once. */
export interface BackendPolicy {
  autoStartBackend: boolean;
  /**
   * How long a start may take before it is abandoned. Optional so a caller that
   * has no opinion keeps {@link BACKEND_START_TIMEOUT_MS}; an explicit
   * `startTimeoutMs` option still wins over both.
   */
  backendStartupTimeoutMs?: number;
}

const DEFAULT_POLICY: BackendPolicy = { autoStartBackend: true };

export interface BackendControllerOptions {
  backend: DeveloperBackend;
  /** Read on every decision, so Settings changes need no restart. */
  policy?: () => BackendPolicy;
  clock?: Clock;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  log?: BackendLog;
}

export type BackendOperationResult =
  | { status: "started" }
  | { status: "stopped" }
  | { status: "failed"; error: BackendError }
  | { status: "cancelled" };

export type BackendSubmission =
  | { accepted: false; error: BackendError }
  | { accepted: true; settled: Promise<BackendOperationResult> };

/** What the UI may know about the backend without reaching for the implementation. */
export interface BackendInfo {
  readonly id: string;
  readonly label: string;
  readonly simulated: boolean;
  readonly description: string;
}

export interface BackendController {
  readonly backend: BackendInfo;
  getSnapshot: () => BackendSnapshot;
  subscribe: (listener: () => void) => () => void;
  /**
   * Starts the backend. Idempotent: a second call while it is starting joins the
   * first request instead of starting anything again, and a call while it is
   * already ready succeeds without touching the backend.
   */
  start: () => BackendSubmission;
  /** Stops the backend. Idempotent, never throws, and safe to call when stopped. */
  stop: () => Promise<void>;
  /** Stops the backend and starts it again. Never throws. */
  restart: () => Promise<BackendOperationResult>;
  /**
   * Asks the backend about its providers again. Capabilities are a property of
   * the provider set and do not move on their own; health does, so this is how a
   * developer confirms what the backend reports right now.
   */
  refreshCapabilities: () => void;
  /** The launch pass for Settings › Developer › Auto start; only the first call has any effect. */
  startup: () => Promise<void>;
  /** Abandons an operation in flight and releases the backend. */
  dispose: () => void;
}

interface Operation {
  kind: "start" | "stop";
  seq: number;
  abort: AbortController;
  timer: TimerId | null;
  settled: boolean;
  resolve: (result: BackendOperationResult) => void;
  settledPromise: Promise<BackendOperationResult>;
}

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

const EMPTY_DIAGNOSTICS: readonly BackendDiagnostic[] = Object.freeze([]);

const errorData = (error: BackendError) =>
  error.details === undefined ? error.code : `${error.code}: ${error.details}`;

/** Why nothing is usable while the backend is not running. */
function restingReason(state: BackendState): string {
  switch (state) {
    case "created":
      return "The backend has not been started.";
    case "starting":
      return "The backend is starting.";
    case "stopping":
      return "The backend is stopping.";
    case "stopped":
      return "The backend is stopped.";
    default:
      return "The backend is not running.";
  }
}

/**
 * The backend pipeline, and the single source of truth for backend lifecycle
 * state.
 *
 * It owns the state machine, the start and stop timeouts, cancellation,
 * capabilities, provider health and what reaches the console. A backend only
 * starts, stops and describes itself, so replacing the backend replaces the
 * implementation and nothing else.
 *
 * Two things this controller deliberately does **not** do. It does not own
 * target state: whether a target is there is the target controller's answer, and
 * a ready backend with no target is an ordinary situation. And it does not
 * create or replace the tool controllers: the backend hands its providers over
 * once, so stopping and starting it again leaves the editor, the open scripts and
 * the breakpoints exactly where they were.
 *
 * Nothing here is persisted: Nova always starts at `created`, so a stale "ready"
 * cannot survive a restart.
 */
export function createBackendController(options: BackendControllerOptions): BackendController {
  const { backend } = options;
  const clock = options.clock ?? systemClock;
  const log = options.log ?? logger;
  const policy = options.policy ?? (() => DEFAULT_POLICY);
  const stopTimeoutMs = options.stopTimeoutMs ?? BACKEND_STOP_TIMEOUT_MS;
  const label = backend.descriptor.label;

  /**
   * Read when a start begins rather than fixed at construction, so changing
   * Settings › Developer › Startup timeout applies to the next start without a
   * restart. An explicit option still wins, which is how the tests pin it.
   */
  const resolveStartTimeout = (): number => {
    if (options.startTimeoutMs !== undefined) return options.startTimeoutMs;
    const configured = policy().backendStartupTimeoutMs;
    return typeof configured === "number" && Number.isFinite(configured) && configured > 0
      ? configured
      : BACKEND_START_TIMEOUT_MS;
  };

  /** Fixed for the life of the controller: a backend never swaps its providers. */
  const capabilities = deriveCapabilities(backend.providers);
  const providers = describeProviders(backend.providers);

  /** The backend's own diagnostics, or none when it reports on nothing. */
  const readDiagnostics = (): readonly BackendDiagnostic[] => {
    if (backend.getDiagnostics === undefined) return EMPTY_DIAGNOSTICS;
    try {
      return Object.freeze([...backend.getDiagnostics()]);
    } catch (error) {
      log.error(`The ${label} backend could not report its diagnostics`, describeError(error));
      return EMPTY_DIAGNOSTICS;
    }
  };

  const listeners = new Set<() => void>();
  let snapshot: BackendSnapshot = {
    state: "created",
    busy: false,
    readySince: null,
    capabilities,
    health: restingHealth(restingReason("created")),
    providers,
    error: null,
    errorAt: null,
    diagnostics: readDiagnostics(),
  };

  let operation: Operation | null = null;
  let operationSeq = 0;
  let startupHandled = false;
  let disposed = false;

  const publish = () => {
    for (const listener of [...listeners]) listener();
  };

  const setSnapshot = (patch: Partial<BackendSnapshot>) => {
    const next = { ...snapshot, ...patch, diagnostics: readDiagnostics() };
    // The timestamp belongs to the failure, so it is stamped where the failure
    // is recorded rather than at each of the call sites that record one.
    if (patch.error !== undefined) next.errorAt = patch.error === null ? null : clock.now();
    snapshot = next;
    publish();
  };

  /** The backend's own health report, or the resting one while it is not running. */
  const readHealth = (state: BackendState): readonly ProviderHealthReport[] => {
    if (!isBackendReady(state)) return restingHealth(restingReason(state));
    try {
      return normalizeHealth(backend.getHealth(), capabilities);
    } catch (error) {
      log.error(`The ${label} backend could not report its provider health`, describeError(error));
      return Object.freeze(
        DEVELOPER_TOOLS.map((tool) =>
          Object.freeze({
            tool,
            health: "error" as const,
            reason: "The backend could not be asked about this provider.",
          }),
        ),
      );
    }
  };

  const moveTo = (state: BackendState, patch: Partial<Omit<BackendSnapshot, "state">> = {}) => {
    const next = transitionBackend(snapshot.state, state);
    setSnapshot({
      ...patch,
      state: next,
      busy: isBackendBusy(next),
      health: patch.health ?? readHealth(next),
    });
  };

  /**
   * Releases the backend without waiting for it. Used where the controller has
   * already decided what state it is in — a timeout, an abandoned start, dispose —
   * so a cleanup that hangs or throws can neither hold the caller up nor change
   * that decision.
   */
  const releaseBackend = (when: string) => {
    try {
      void Promise.resolve(backend.stop()).catch((error: unknown) =>
        log.debug(`Backend cleanup ${when} failed`, describeError(error)),
      );
    } catch (error) {
      log.debug(`Backend cleanup ${when} threw`, describeError(error));
    }
  };

  /** Ends the operation in flight, if any, without deciding what its result is. */
  const abandonOperation = () => {
    const current = operation;
    operation = null;
    if (!current) return current;
    clock.clearTimeout(current.timer);
    current.timer = null;
    current.abort.abort();
    return current;
  };

  const refuse = (error: BackendError): BackendSubmission => {
    log.warn(`Backend request refused: ${error.message}`, errorData(error));
    return { accepted: false, error };
  };

  /**
   * Runs one lifecycle operation: arms the timeout, invokes the backend, and
   * applies the answer only while it is still the operation the controller is
   * waiting for.
   */
  const run = (
    kind: Operation["kind"],
    timeoutMs: number,
    timeoutError: () => BackendError,
    /**
     * Publishes the state the operation starts in. It runs *after* the operation
     * is registered and its timeout armed, so a subscriber that reacts by calling
     * `stop()` finds an operation to abandon rather than a state machine that has
     * moved without one.
     */
    announce: () => void,
    body: (signal: AbortSignal, isLive: () => boolean) => Promise<BackendOperationResult>,
  ): Promise<BackendOperationResult> => {
    operationSeq += 1;
    let resolve!: (result: BackendOperationResult) => void;
    const settledPromise = new Promise<BackendOperationResult>((done) => {
      resolve = done;
    });
    const current: Operation = {
      kind,
      seq: operationSeq,
      abort: new AbortController(),
      timer: null,
      settled: false,
      resolve,
      settledPromise,
    };
    operation = current;

    const isLive = () => operation === current && !current.settled && !disposed;

    const finish = (result: BackendOperationResult) => {
      current.settled = true;
      clock.clearTimeout(current.timer);
      current.timer = null;
      if (operation === current) operation = null;
      current.resolve(result);
    };

    current.timer = clock.setTimeout(() => {
      if (current.settled) return;
      current.timer = null;
      // Stop the backend first, so a late answer cannot promote a timed-out
      // operation into "ready" — and release whatever it managed to start, the
      // way the target controller releases a timed-out injection.
      current.abort.abort();
      releaseBackend("after the timeout");
      const error = timeoutError();
      moveTo("error", { error, readySince: null });
      log.error(error.message, errorData(error));
      finish({ status: "failed", error });
    }, timeoutMs);

    announce();
    // A subscriber may have ended this operation while `announce` published.
    if (!isLive()) return settledPromise;

    let pending: Promise<BackendOperationResult>;
    try {
      pending = body(current.abort.signal, isLive);
    } catch (error) {
      pending = Promise.reject(error);
    }

    void Promise.resolve(pending).then(
      (result) => {
        if (current.settled || disposed) {
          log.debug(`Ignored a late backend answer for ${kind} operation ${current.seq}`);
          return;
        }
        if (operation !== current) {
          current.settled = true;
          current.resolve({ status: "cancelled" });
          log.debug(`Ignored a stale backend answer for ${kind} operation ${current.seq}`);
          return;
        }
        finish(result);
      },
      (error: unknown) => {
        if (current.settled || disposed || operation !== current) {
          log.debug(`Ignored a late backend failure for ${kind} operation ${current.seq}`);
          if (!current.settled) {
            current.settled = true;
            current.resolve({ status: "cancelled" });
          }
          return;
        }
        const failure: BackendError = {
          code: kind === "start" ? "PROVIDER_START_FAILED" : "PROVIDER_STOP_FAILED",
          message: `The ${label} backend failed to ${kind}.`,
          details: describeError(error),
        };
        moveTo("error", { error: failure, readySince: null });
        log.error(failure.message, errorData(failure));
        finish({ status: "failed", error: failure });
      },
    );

    return settledPromise;
  };

  const startBackend = (): Promise<BackendOperationResult> => {
    const timeoutMs = resolveStartTimeout();
    return run(
      "start",
      timeoutMs,
      () => ({
        code: "PROVIDER_TIMEOUT",
        message: `The ${label} backend did not start within ${timeoutMs} ms.`,
        details: "The request was abandoned; a late answer is ignored.",
      }),
      () => {
        moveTo("starting", { error: null });
        log.info("Starting the developer backend", `Backend: ${label}`);
      },
      async (signal, isLive) => {
        const outcome = await backend.start({ signal });
        if (!isLive()) return { status: "cancelled" };

        if (outcome.status === "started") {
          moveTo("ready", { error: null, readySince: clock.now() });
          log.info("Developer backend ready", `Backend: ${label}`);
          return { status: "started" };
        }
        if (outcome.status === "cancelled") {
          moveTo("stopped", { error: null, readySince: null });
          log.warn("Starting the developer backend was cancelled", `Backend: ${label}`);
          return { status: "cancelled" };
        }
        moveTo("error", { error: outcome.error, readySince: null });
        log.error(`The developer backend failed to start: ${outcome.error.message}`, errorData(outcome.error));
        return { status: "failed", error: outcome.error };
      },
    );
  };

  const start = (): BackendSubmission => {
    if (disposed) {
      return refuse({
        code: "PROVIDER_INVALID_STATE",
        message: "Nova is shutting down.",
        details: "The backend controller has been released.",
      });
    }

    const { state } = snapshot;

    // Already running: succeeding without touching the backend is the whole
    // point of an idempotent start.
    if (state === "ready") return { accepted: true, settled: Promise.resolve({ status: "started" }) };

    // A start already in flight: join it rather than starting a second one.
    if (state === "starting" && operation?.kind === "start" && !operation.settled) {
      log.debug("A backend start is already in progress; joining it");
      return { accepted: true, settled: operation.settledPromise };
    }

    if (!STARTABLE_BACKEND_STATES.includes(state)) {
      return refuse({
        code: "PROVIDER_INVALID_STATE",
        message: `The ${label} backend is ${state}.`,
        details: "Wait for the operation in progress to finish before starting it again.",
      });
    }

    return { accepted: true, settled: startBackend() };
  };

  const stopBackend = (): Promise<BackendOperationResult> =>
    run(
      "stop",
      stopTimeoutMs,
      () => ({
        code: "PROVIDER_TIMEOUT",
        message: `The ${label} backend did not stop within ${stopTimeoutMs} ms.`,
        details: "The request was abandoned; a late answer is ignored.",
      }),
      () => {
        moveTo("stopping");
        log.info("Stopping the developer backend", `Backend: ${label}`);
      },
      async (_signal, isLive) => {
        try {
          await backend.stop();
        } catch (error) {
          if (!isLive()) return { status: "cancelled" };
          const failure: BackendError = {
            code: "PROVIDER_STOP_FAILED",
            message: `The ${label} backend reported an error while stopping.`,
            details: describeError(error),
          };
          // The backend is not usable either way, so it is recorded and the
          // state settles rather than being left as "stopping".
          moveTo("error", { error: failure, readySince: null });
          log.error(failure.message, errorData(failure));
          return { status: "failed", error: failure };
        }
        if (!isLive()) return { status: "cancelled" };

        moveTo("stopped", { error: null, readySince: null });
        log.info("Developer backend stopped", `Backend: ${label}`);
        return { status: "stopped" };
      },
    );

  const stop = async (): Promise<void> => {
    if (disposed) return;
    const { state } = snapshot;

    // A stop already in flight: join it rather than starting a second one.
    if (state === "stopping") {
      if (operation?.kind === "stop" && !operation.settled) await operation.settledPromise;
      return;
    }
    // Nothing is running, so there is nothing to stop.
    if (!STOPPABLE_BACKEND_STATES.includes(state)) return;

    if (state === "starting") {
      // A start in flight is abandoned rather than awaited: the caller asked for
      // the backend to be down, and a late "started" must not undo that.
      const abandoned = abandonOperation();
      if (abandoned && !abandoned.settled) {
        abandoned.settled = true;
        abandoned.resolve({ status: "cancelled" });
      }
      moveTo("stopped", { error: null, readySince: null });
      log.info("Starting the developer backend was abandoned", `Backend: ${label}`);
      // Not awaited: the controller has already declared itself stopped, and a
      // backend that never finishes cleaning up must not hang stop() — or the
      // restart that awaits it.
      releaseBackend("after an abandoned start");
      return;
    }

    await stopBackend();
  };

  /**
   * A backend that watches something can find out on its own that it is no
   * longer healthy — a session lost, a service that stopped answering. Without
   * this the panel would keep showing the last answer until something unrelated
   * happened to ask again, so the controller re-reads and republishes when the
   * backend says there is something new. It changes no state: health is read,
   * never decided, here.
   */
  const unsubscribeHealth =
    backend.subscribeHealth?.(() => {
      if (disposed) return;
      setSnapshot({ health: readHealth(snapshot.state) });
    }) ?? (() => undefined);

  return {
    backend: Object.freeze({
      id: backend.descriptor.id,
      label,
      simulated: backend.descriptor.simulated,
      description: backend.descriptor.description,
    }),
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    stop,
    restart: async () => {
      if (disposed) {
        return {
          status: "failed",
          error: {
            code: "PROVIDER_INVALID_STATE",
            message: "Nova is shutting down.",
            details: "The backend controller has been released.",
          },
        };
      }
      log.info("Restarting the developer backend", `Backend: ${label}`);
      await stop();
      if (disposed) return { status: "cancelled" };
      const submission = start();
      if (!submission.accepted) return { status: "failed", error: submission.error };
      return submission.settled;
    },
    refreshCapabilities: () => {
      if (disposed) return;
      const health = readHealth(snapshot.state);
      setSnapshot({ capabilities, providers, health });
      log.debug(`Re-read the backend's capabilities and provider health (${label})`);
    },
    startup: async () => {
      if (startupHandled || disposed) return;
      startupHandled = true;
      if (!policy().autoStartBackend) {
        log.info("Auto start is off; the developer backend is not started", `Backend: ${label}`);
        return;
      }
      const submission = start();
      if (submission.accepted) await submission.settled;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribeHealth();
      listeners.clear();
      const abandoned = abandonOperation();
      if (abandoned && !abandoned.settled) {
        abandoned.settled = true;
        abandoned.resolve({ status: "cancelled" });
      }
      releaseBackend("on dispose");
    },
  };
}
