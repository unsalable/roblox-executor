import {
  isSessionLost,
  type LocalServiceError,
  type LocalServiceSessionInfo,
} from "@/features/backend/backends/localService/protocol";
import {
  createLocalServiceSession,
  type LocalServiceSession,
} from "@/features/backend/backends/localService/session";
import {
  createLocalServiceTargetProvider,
  type LocalServiceTargetProvider,
} from "@/features/backend/backends/localService/targetProvider";
import {
  createTauriLocalServiceTransport,
  type LocalServiceTransport,
} from "@/features/backend/backends/localService/transport";
import type {
  BackendDescriptor,
  BackendDiagnostic,
  BackendError,
  BackendStartOutcome,
  DeveloperBackend,
  ProviderHealth,
  ProviderHealthReport,
} from "@/features/backend/types";
import { systemClock, type Clock, type TimerId } from "@/lib/clock";

/**
 * The Local Service backend: the real one.
 *
 * ```text
 * Local Service
 *  ├── Local Service Session   detection, attach and the session — real, over IPC
 *  ├── (no debugger)           reported unsupported, with a reason
 *  └── (no profiler)           reported unsupported, with a reason
 * ```
 *
 * Everything it reports came back from the service running beside this window
 * in Nova's own process, over Tauri's application IPC. It opens no socket,
 * binds no address and listens on no port, so there is nothing to connect to
 * from outside Nova — not even on loopback. It enumerates no process, opens no
 * process handle, reads or writes no memory outside this application, loads no
 * library into anything, invokes no shell, launches no executable, installs no
 * persistence and contacts no network endpoint.
 *
 * **It reports `simulated: false`, and that claim is narrow on purpose.** The
 * session is real, the attachment is real state the service holds, the health
 * numbers are measured round trips, and the capabilities are the service's own
 * answer rather than this module's. What it is *not* is a backend that reaches
 * anything outside Nova: the target it supplies is the backend's own service
 * session, and the description says exactly that wherever the backend is named.
 *
 * Two of the three developer tools are simply absent. That is the case the
 * capability system exists for: `debugger` and `profiler` are `null`,
 * their capabilities derive to false, the composition root wires the refusing
 * stand-ins, and every surface says the backend supplies none — rather than a
 * simulation being passed off as this backend's work.
 */

export const LOCAL_SERVICE_BACKEND_ID = "local-service";
export const LOCAL_SERVICE_BACKEND_LABEL = "Local Service";
export const LOCAL_SERVICE_BACKEND_DESCRIPTION =
  "A real local service in Nova's own process, reached over the application's IPC. Its target is that service's session, not another application: nothing outside Nova is read, attached to or contacted. It supplies no debugger and no profiler.";

/** How often the backend asks the service how it is doing, by default. */
export const LOCAL_SERVICE_HEALTH_INTERVAL_MS = 5000;

export const LOCAL_SERVICE_BACKEND_DESCRIPTOR: BackendDescriptor = Object.freeze({
  id: LOCAL_SERVICE_BACKEND_ID,
  label: LOCAL_SERVICE_BACKEND_LABEL,
  simulated: false,
  description: LOCAL_SERVICE_BACKEND_DESCRIPTION,
});

/** The Settings › Developer behaviours this backend reads, when it needs them. */
export interface LocalServicePolicy {
  healthCheckIntervalMs: number;
}

export interface LocalServiceDeveloperBackendOptions {
  /** Defaults to the application IPC bridge. Tests pass a fake. */
  transport?: LocalServiceTransport;
  clock?: Clock;
  createId?: () => string;
  /** Read on every tick, so changing it in Settings needs no restart. */
  policy?: () => LocalServicePolicy;
  requestTimeoutMs?: number;
}

export interface LocalServiceDeveloperBackend extends DeveloperBackend {
  /** The session client, for the tests that drive it directly. */
  readonly session: LocalServiceSession;
}

const MISSING_DEBUGGER = "The Local Service backend supplies no debugger; it implements no debug operations.";
const MISSING_PROFILER = "The Local Service backend supplies no profiler; it implements no recording operations.";

/** Turns a local service refusal into the backend vocabulary, code by code. */
export function toBackendError(error: LocalServiceError, what: string): BackendError {
  const details = error.details === undefined ? error.message : `${error.message} (${error.details})`;

  switch (error.code) {
    case "TRANSPORT_UNAVAILABLE":
      return {
        code: "PROVIDER_TRANSPORT_UNAVAILABLE",
        message: "Nova's local service is only reachable from the desktop application.",
        details,
      };
    case "AUTH_REQUIRED":
    case "AUTH_INVALID":
      return { code: "PROVIDER_AUTH_FAILED", message: "The local service did not accept Nova's session.", details };
    case "SESSION_STALE":
      return { code: "PROVIDER_SESSION_STALE", message: "The local service session has ended.", details };
    case "PROTOCOL_UNSUPPORTED":
    case "MESSAGE_MALFORMED":
    case "MESSAGE_TOO_LARGE":
    case "RESPONSE_MALFORMED":
    case "RESPONSE_MISMATCHED":
      return {
        code: "PROVIDER_PROTOCOL_MISMATCH",
        message: "Nova and its local service do not agree on the protocol.",
        details,
      };
    case "CAPABILITY_UNSUPPORTED":
    case "OPERATION_UNSUPPORTED":
      return {
        code: "PROVIDER_CAPABILITY_UNSUPPORTED",
        message: "The local service does not implement something this session needs.",
        details,
      };
    case "REQUEST_TIMEOUT":
      return { code: "PROVIDER_TIMEOUT", message: "The local service did not answer in time.", details };
    case "SERVICE_UNAVAILABLE":
    case "TRANSPORT_FAILED":
    case "ALREADY_ATTACHED":
      return { code: "PROVIDER_START_FAILED", message: `The local service could not ${what}.`, details };
  }
}

export function createLocalServiceDeveloperBackend(
  options: LocalServiceDeveloperBackendOptions = {},
): LocalServiceDeveloperBackend {
  const clock = options.clock ?? systemClock;
  const transport = options.transport ?? createTauriLocalServiceTransport();
  const policy = options.policy ?? (() => ({ healthCheckIntervalMs: LOCAL_SERVICE_HEALTH_INTERVAL_MS }));

  const session = createLocalServiceSession({
    transport,
    clock,
    ...(options.createId === undefined ? {} : { createId: options.createId }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
  });
  const target: LocalServiceTargetProvider = createLocalServiceTargetProvider({ session, clock });

  let running = false;
  let info: LocalServiceSessionInfo | null = null;
  let healthTimer: TimerId | null = null;
  let lastCheckAt: number | null = null;
  /** The target row, as the last thing that happened left it. */
  let targetHealth: ProviderHealth = "unavailable";
  let targetReason: string | null = "The backend has not been started.";

  /**
   * Bumped by every start and every stop.
   *
   * The controller may abandon a lifecycle operation and begin the next one
   * without waiting for the first to finish — a timed-out start is released
   * fire-and-forget, and a restart from `error` needs no permission from it. So
   * an operation here cannot assume that what it is acting on after an `await`
   * is still what it was acting on before: every await point compares this
   * against the value it captured, and a superseded operation stops touching
   * anything rather than tearing down the one that replaced it.
   */
  let lifecycle = 0;

  const healthListeners = new Set<() => void>();
  const publishHealth = () => {
    for (const listener of [...healthListeners]) listener();
  };

  const setTargetHealth = (health: ProviderHealth, reason: string | null) => {
    if (targetHealth === health && targetReason === reason) return;
    targetHealth = health;
    targetReason = reason;
    publishHealth();
  };

  const clearHealthTimer = () => {
    if (healthTimer !== null) clock.clearTimeout(healthTimer);
    healthTimer = null;
  };

  const intervalMs = () => {
    const configured = policy().healthCheckIntervalMs;
    return Number.isFinite(configured) && configured > 0 ? configured : LOCAL_SERVICE_HEALTH_INTERVAL_MS;
  };

  const scheduleHealthCheck = () => {
    clearHealthTimer();
    if (!running) return;
    healthTimer = clock.setTimeout(() => {
      healthTimer = null;
      void runHealthCheck();
    }, intervalMs());
  };

  /** Reads the service's health once and applies it to the target and the row. */
  const readHealthOnce = async (signal?: AbortSignal): Promise<BackendError | null> => {
    const mine = lifecycle;
    const answer = await session.health(signal === undefined ? {} : { signal });
    // A stop, or another start, happened while this question was in flight. Its
    // answer describes a backend that no longer exists: applying it would put a
    // ready target back on screen beside a stopped backend.
    if (mine !== lifecycle) return null;
    if (answer.status === "cancelled") return null;
    if (answer.status === "failed") {
      if (isSessionLost(answer.error.code)) {
        target.applyHealth(null);
        setTargetHealth("error", "The local service session has ended; the backend will try to open a new one.");
      } else {
        // The session is still believed good, so this is one failed question
        // rather than a lost backend. Saying "degraded" is the honest word for
        // it: the provider is wired and the last answer did not arrive.
        setTargetHealth("degraded", `The last health check did not succeed: ${answer.error.message}`);
      }
      return toBackendError(answer.error, "report its health");
    }

    lastCheckAt = clock.now();
    target.applyHealth(answer.value);

    /**
     * An attachment the service is holding and Nova is not.
     *
     * It happens when a detach did not land — the answer timed out, or the
     * bridge failed — and it is the one state where the service and Nova
     * genuinely disagree. Undoing it is the honest repair: Nova asked for the
     * attachment to end, so it ends, rather than being left for a shutdown to
     * clear whenever the backend next stops.
     */
    if (answer.value.attached && !target.isAttached()) {
      void session.detach();
    }

    // Read from the provider, not from the answer: the provider is what the
    // target controller was told, and the two must not be able to disagree —
    // "Target: Healthy" beside a target that says it is gone is one screen with
    // two answers on it.
    const visible = target.getDetection().available;
    setTargetHealth(
      visible ? "healthy" : "unavailable",
      visible ? null : "The local service reports no session to attach to.",
    );
    // Published even when the row did not move: the round trip, the request
    // count and the time of this check are diagnostics that changed, and the
    // panel only re-reads them when something tells it to.
    publishHealth();
    return null;
  };

  /**
   * One attempt to open a new session after the last one was lost.
   *
   * Recovery is deliberately this small: one handshake per health interval,
   * through the same code path a start uses, with the result reported exactly
   * as it is. Nothing here retries in a tight loop and nothing pretends the
   * backend is healthy while it is not.
   */
  const recover = async (): Promise<void> => {
    const mine = lifecycle;
    const opened = await session.open({ signal: new AbortController().signal });
    if (!running || mine !== lifecycle) return;
    if (opened.status !== "ok") {
      const reason = opened.status === "failed" ? opened.error.message : "The attempt was abandoned.";
      setTargetHealth("error", `The local service session has ended, and a new one could not be opened: ${reason}`);
      return;
    }
    info = opened.value;
    await readHealthOnce();
  };

  const runHealthCheck = async (): Promise<void> => {
    if (!running) return;
    if (session.isOpen()) await readHealthOnce();
    else await recover();
    scheduleHealthCheck();
  };

  const stop = async (): Promise<void> => {
    const mine = ++lifecycle;
    if (!running) {
      // A start that was abandoned mid-handshake still has to be told the
      // session it is opening is not wanted, or it would leave one behind.
      clearHealthTimer();
      await session.close();
      return;
    }
    running = false;
    clearHealthTimer();
    info = null;
    // The target goes away first, so the tool controllers see the loss and end
    // their sessions before the session itself is torn down. Clearing it here
    // also drops Nova's attachment, so no separate detach is needed.
    target.applyHealth(null);
    setTargetHealth("unavailable", "The backend is stopped.");
    // One request, not two. Ending the session ends the attachment with it —
    // the service keeps `attached` inside the session it belongs to — and the
    // controller's stop timeout has to fit whatever happens here inside it, so
    // a detach followed by a shutdown could not be afforded.
    await session.close();
    // A newer start may have opened a session while this stop was draining;
    // `close()` refuses to forget one it did not open, so there is nothing to
    // undo here. The check is kept so the reason is visible at this level too.
    if (mine !== lifecycle) return;
  };

  return {
    descriptor: LOCAL_SERVICE_BACKEND_DESCRIPTOR,
    // A tool this backend does not supply is null, never a simulation borrowed
    // from another backend so the row looks full.
    providers: Object.freeze({ target, debugger: null, profiler: null }),
    session,

    start: async ({ signal }): Promise<BackendStartOutcome> => {
      const mine = ++lifecycle;
      const opened = await session.open({ signal });
      if (mine !== lifecycle) return { status: "cancelled" };
      if (opened.status === "cancelled") return { status: "cancelled" };
      if (opened.status === "failed") {
        return { status: "failed", error: toBackendError(opened.error, "open a session") };
      }

      // The service is the authority on what it can do. A build that could not
      // attach a target would be refused here rather than reported as ready
      // with a capability that does not work.
      if (!opened.value.capabilities.target) {
        await session.close();
        return {
          status: "failed",
          error: {
            code: "PROVIDER_CAPABILITY_UNSUPPORTED",
            message: "The local service cannot attach a target in this build.",
            details: "The handshake reported the target capability as unavailable.",
          },
        };
      }

      info = opened.value;
      running = true;
      const failure = await readHealthOnce(signal);
      if (!running || mine !== lifecycle) return { status: "cancelled" };
      if (failure !== null) {
        running = false;
        info = null;
        await session.close();
        return { status: "failed", error: failure };
      }

      scheduleHealthCheck();
      return { status: "started" };
    },

    stop,

    getHealth: (): readonly ProviderHealthReport[] => [
      { tool: "target", health: targetHealth, reason: targetReason },
      // Reported rather than left out: "this backend has none" is an answer,
      // and it is not the same answer as "it is not working".
      { tool: "debugger", health: "unavailable", reason: MISSING_DEBUGGER },
      { tool: "profiler", health: "unavailable", reason: MISSING_PROFILER },
    ],

    /**
     * What the Developer Status panel shows about this backend beyond the
     * lifecycle it shares with every other one.
     *
     * The session token is not here and cannot be: the session client never
     * returns it, so there is nothing in scope to put in a row even by mistake.
     * The session *id* is here because it names the session in a diagnostic and
     * is not a secret — it authorises nothing on its own.
     */
    getDiagnostics: (): readonly BackendDiagnostic[] => {
      const stats = session.getStats();
      const detection = target.getDetection();
      return Object.freeze([
        Object.freeze({ label: "Transport", value: session.transportKind }),
        Object.freeze({ label: "Protocol", value: info?.service.protocol ?? "—" }),
        Object.freeze({
          label: "Service",
          value: info === null ? "—" : `${info.service.name} ${info.service.version}`,
        }),
        // "Service session", not "Session": the target has a session row of its
        // own in the same dialog, and two rows labelled the same with different
        // meanings is one screen asking to be misread.
        Object.freeze({ label: "Service session", value: session.isOpen() ? "Open" : "None" }),
        Object.freeze({ label: "Session id", value: info?.sessionId ?? "—" }),
        Object.freeze({ label: "Sessions issued", value: String(stats.sessionsIssued) }),
        Object.freeze({ label: "Attachment", value: target.isAttached() ? "Attached" : "Not attached" }),
        Object.freeze({ label: "Target version", value: detection.targetVersion ?? "—" }),
        Object.freeze({ label: "Requests", value: String(stats.requests) }),
        Object.freeze({
          label: "Last round trip",
          value: stats.lastLatencyMs === null ? "—" : `${stats.lastLatencyMs} ms`,
        }),
        Object.freeze({
          label: "Last health check",
          value: lastCheckAt === null ? "—" : new Date(lastCheckAt).toLocaleTimeString(),
        }),
        Object.freeze({ label: "Last error", value: stats.lastError?.code ?? "—" }),
      ]);
    },

    subscribeHealth: (listener) => {
      healthListeners.add(listener);
      return () => {
        healthListeners.delete(listener);
      };
    },
  };
}
