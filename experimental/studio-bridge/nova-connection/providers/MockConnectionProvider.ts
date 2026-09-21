import type { ConnectionProvider, ConnectionResult, ConnectionStatus } from "@/features/connection/types";
import { systemClock, type Clock, type TimerId } from "@/lib/clock";

/** Developer test scenarios, chosen through provider configuration. */
export type MockConnectionScenario = "success" | "fail" | "slow";

export const MOCK_CONNECTION_SCENARIOS: readonly { value: MockConnectionScenario; label: string }[] = [
  { value: "success", label: "Connect" },
  { value: "fail", label: "Refuse" },
  { value: "slow", label: "Never answer (times out)" },
];

export interface MockConnectionProviderOptions {
  scenario?: MockConnectionScenario;
  connectMs?: number;
  disconnectMs?: number;
  /** Connect time of the "slow" scenario; longer than any allowed timeout. */
  slowConnectMs?: number;
  clock?: Clock;
  /** Source of the simulated latency, in [0, 1). */
  random?: () => number;
}

export interface MockConnectionProvider extends ConnectionProvider {
  getScenario: () => MockConnectionScenario;
  /** Applies to connection attempts started afterwards. */
  setScenario: (scenario: MockConnectionScenario) => void;
}

const MOCK_CONNECTION_PROVIDER_LABEL = "Local Test";

/**
 * A local stand-in for a future authorized development target. Connecting only
 * waits; nothing outside Nova is contacted, and the reported latency is
 * generated test data, flagged as simulated.
 */
export function createMockConnectionProvider(options: MockConnectionProviderOptions = {}): MockConnectionProvider {
  const clock = options.clock ?? systemClock;
  const connectMs = options.connectMs ?? 450;
  const disconnectMs = options.disconnectMs ?? 150;
  const slowConnectMs = options.slowConnectMs ?? 60_000;
  const random = options.random ?? Math.random;

  let scenario = options.scenario ?? "success";
  let status: ConnectionStatus = "disconnected";
  let latencyMs = 0;
  let pending: { timer: TimerId; resolve: (result: ConnectionResult) => void; promise: Promise<ConnectionResult> } | null =
    null;
  let closing: { timer: TimerId; resolve: () => void; promise: Promise<void> } | null = null;

  const finishClosing = () => {
    if (!closing) return;
    clock.clearTimeout(closing.timer);
    closing.resolve();
    closing = null;
  };

  return {
    label: MOCK_CONNECTION_PROVIDER_LABEL,

    connect: () => {
      if (status === "connected") return Promise.resolve({ ok: true, latencyMs, latencySimulated: true });
      if (pending) return pending.promise;

      finishClosing();
      status = "connecting";
      const planned = scenario;

      let resolve!: (result: ConnectionResult) => void;
      const promise = new Promise<ConnectionResult>((done) => {
        resolve = done;
      });
      const timer = clock.setTimeout(
        () => {
          pending = null;
          if (planned === "fail") {
            status = "error";
            resolve({
              ok: false,
              error: {
                code: "CONNECTION_FAILED",
                message: "The local test provider refused the connection.",
                details: 'Produced by the "Refuse" test scenario.',
              },
            });
            return;
          }
          status = "connected";
          latencyMs = 6 + Math.round(random() * 12);
          resolve({ ok: true, latencyMs, latencySimulated: true });
        },
        planned === "slow" ? slowConnectMs : connectMs,
      );
      pending = { timer, resolve, promise };
      return promise;
    },

    disconnect: () => {
      if (pending) {
        clock.clearTimeout(pending.timer);
        pending.resolve({
          ok: false,
          error: { code: "CONNECTION_ABORTED", message: "The connection attempt was abandoned." },
        });
        pending = null;
      } else if (status !== "connected") {
        if (closing) return closing.promise;
        status = "disconnected";
        return Promise.resolve();
      }

      if (closing) return closing.promise;
      status = "disconnecting";
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      const timer = clock.setTimeout(() => {
        closing = null;
        status = "disconnected";
        resolve();
      }, disconnectMs);
      closing = { timer, resolve, promise };
      return promise;
    },

    getStatus: () => status,
    getScenario: () => scenario,
    setScenario: (next) => {
      scenario = next;
    },
  };
}
