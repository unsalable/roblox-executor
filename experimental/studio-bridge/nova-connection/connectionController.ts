import { transitionConnection } from "@/features/connection/connectionState";
import type {
  ConnectionError,
  ConnectionProvider,
  ConnectionResult,
  ConnectionSnapshot,
  ConnectionStatus,
} from "@/features/connection/types";
import { systemClock, type Clock, type TimerId } from "@/lib/clock";
import { logger } from "@/lib/logger";

export type ConnectionLog = Pick<typeof logger, "debug" | "info" | "warn" | "error">;

const DEFAULT_CONNECTION_TIMEOUT_MS = 5000;

export interface ConnectionControllerOptions {
  provider: ConnectionProvider;
  clock?: Clock;
  log?: ConnectionLog;
}

export interface ConnectOptions {
  timeoutMs: number;
}

export interface ConnectionController {
  readonly provider: { label: string; providerType?: string };
  getSnapshot: () => ConnectionSnapshot;
  subscribe: (listener: () => void) => () => void;
  /** Starts connecting from disconnected or error. Resolves true once this attempt connected. */
  connect: (options: ConnectOptions) => Promise<boolean>;
  /** Disconnects, abandons an attempt in progress, or dismisses an error. */
  disconnect: () => Promise<void>;
  /** The startup auto connect: only the first call has any effect. */
  autoConnect: (options: ConnectOptions & { enabled: boolean }) => Promise<boolean>;
  /** Stops timers, abandons an attempt in progress and releases the provider. */
  dispose: () => void;
}

interface Attempt {
  timer: TimerId | null;
  resolve: (connected: boolean) => void;
}

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

const errorData = (error: ConnectionError) =>
  error.details === undefined ? error.code : `${error.code}: ${error.details}`;

const disconnectedSnapshot: ConnectionSnapshot = {
  status: "disconnected",
  latencyMs: null,
  latencySimulated: false,
  connectedAt: null,
  error: null,
};

/**
 * Tracks the connection to the active provider. Its snapshot is the single
 * source of truth for connection state; results from abandoned or timed-out
 * attempts are ignored, so no impossible state can be reached.
 */
export function createConnectionController(options: ConnectionControllerOptions): ConnectionController {
  const { provider } = options;
  const clock = options.clock ?? systemClock;
  const log = options.log ?? logger;
  const label = provider.label;

  const listeners = new Set<() => void>();
  let snapshot = disconnectedSnapshot;
  let attempt: Attempt | null = null;
  let disconnecting: Promise<void> | null = null;
  let autoConnectHandled = false;

  const setSnapshot = (next: ConnectionSnapshot) => {
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };

  const moveTo = (status: ConnectionStatus, patch: Partial<Omit<ConnectionSnapshot, "status">> = {}) =>
    setSnapshot({ ...snapshot, ...patch, status: transitionConnection(snapshot.status, status) });

  /** Ends the attempt in progress, if any, without touching state. */
  const abandonAttempt = () => {
    const current = attempt;
    attempt = null;
    if (!current) return;
    clock.clearTimeout(current.timer);
    current.resolve(false);
  };

  const fail = (error: ConnectionError) => {
    moveTo("error", { error, latencyMs: null, latencySimulated: false, connectedAt: null });
    log.error(`Connection failed: ${error.message}`, errorData(error));
  };

  const handleResult = (current: Attempt, result: ConnectionResult) => {
    if (attempt !== current) {
      log.debug(`Ignored a result from an abandoned connection attempt to the ${label} provider`);
      return;
    }
    attempt = null;
    clock.clearTimeout(current.timer);

    if (!result.ok) {
      fail(result.error);
      current.resolve(false);
      return;
    }

    moveTo("connected", {
      latencyMs: result.latencyMs,
      latencySimulated: result.latencySimulated,
      connectedAt: clock.now(),
      error: null,
    });
    const latency = result.latencySimulated ? "Simulated latency" : "Latency";
    log.info(`Connected to the ${label} provider`, result.latencyMs === null ? undefined : `${latency} ${result.latencyMs} ms`);
    current.resolve(true);
  };

  const startConnect = (timeoutMs: number, trigger: "user" | "auto"): Promise<boolean> => {
    if (snapshot.status !== "disconnected" && snapshot.status !== "error") {
      log.debug(`Connect ignored while ${snapshot.status}`);
      return Promise.resolve(false);
    }

    const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_CONNECTION_TIMEOUT_MS;

    return new Promise<boolean>((resolve) => {
      const current: Attempt = { timer: null, resolve };
      attempt = current;

      moveTo("connecting", { error: null, latencyMs: null, latencySimulated: false, connectedAt: null });
      log.info(`${trigger === "auto" ? "Auto connect: connecting" : "Connecting"} to the ${label} provider`);

      current.timer = clock.setTimeout(() => {
        if (attempt !== current) return;
        current.timer = null;
        abandonAttempt();
        fail({
          code: "CONNECTION_TIMEOUT",
          message: `The ${label} provider did not connect within ${limit} ms.`,
          details: "The connection attempt was abandoned.",
        });
        provider
          .disconnect()
          .catch((error: unknown) => log.debug("Provider cleanup after the timeout failed", describeError(error)));
      }, limit);

      let pending: Promise<ConnectionResult>;
      try {
        pending = provider.connect();
      } catch (error) {
        pending = Promise.reject(error);
      }
      Promise.resolve(pending).then(
        (result) => handleResult(current, result),
        (error: unknown) =>
          handleResult(current, {
            ok: false,
            error: {
              code: "CONNECTION_FAILED",
              message: `The ${label} provider failed to connect.`,
              details: describeError(error),
            },
          }),
      );
    });
  };

  const disconnect = (): Promise<void> => {
    const { status } = snapshot;
    if (status === "disconnected") return Promise.resolve();
    if (status === "disconnecting") return disconnecting ?? Promise.resolve();
    if (status === "error") {
      moveTo("disconnected", { error: null });
      return Promise.resolve();
    }

    const wasConnecting = status === "connecting";
    abandonAttempt();
    moveTo("disconnecting");

    const done = (async () => {
      try {
        await provider.disconnect();
      } catch (error) {
        log.warn(`The ${label} provider reported an error while disconnecting`, describeError(error));
      }
      disconnecting = null;
      if (snapshot.status !== "disconnecting") return;
      setSnapshot({ ...disconnectedSnapshot, status: transitionConnection(snapshot.status, "disconnected") });
      log.info(
        wasConnecting ? `Connection attempt to the ${label} provider cancelled` : `Disconnected from the ${label} provider`,
      );
    })();
    disconnecting = done;
    return done;
  };

  return {
    provider: Object.freeze(provider.providerType === undefined ? { label } : { label, providerType: provider.providerType }),
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    connect: ({ timeoutMs }) => startConnect(timeoutMs, "user"),
    disconnect,
    autoConnect: ({ enabled, timeoutMs }) => {
      if (autoConnectHandled) return Promise.resolve(false);
      autoConnectHandled = true;
      return enabled ? startConnect(timeoutMs, "auto") : Promise.resolve(false);
    },
    dispose: () => {
      listeners.clear();
      const { status } = snapshot;
      abandonAttempt();
      if (status === "connecting" || status === "connected") {
        provider.disconnect().catch((error: unknown) => log.debug("Provider cleanup on dispose failed", describeError(error)));
      }
    },
  };
}
