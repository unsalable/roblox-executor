import type { BackendDescriptor, DeveloperBackend, ProviderHealthReport } from "@/features/backend/types";
import { createMockDebuggerProvider } from "@/features/debugger/providers/MockDebuggerProvider";
import { createMockProfilerProvider } from "@/features/profiler/providers/MockProfilerProvider";
import {
  createLocalTestTargetProvider,
  type LocalTestAvailability,
  type LocalTestInjectScenario,
} from "@/features/target/providers/LocalTestTargetProvider";
import { systemClock, type Clock, type TimerId } from "@/lib/clock";

export const LOCAL_MOCK_BACKEND_ID = "local-mock";
export const LOCAL_MOCK_BACKEND_LABEL = "Local Mock";
export const LOCAL_MOCK_BACKEND_DESCRIPTION =
  "Every provider is simulated inside Nova: nothing outside the application is read, attached to or contacted.";

/**
 * Simulated lifecycle timings. They are test values and are the only reason
 * starting this backend takes any time at all; stopping takes as long as the
 * simulated target needs to disconnect.
 */
export const LOCAL_MOCK_BACKEND_TIMINGS = { startMs: 120 } as const;

export const LOCAL_MOCK_BACKEND_DESCRIPTOR: BackendDescriptor = Object.freeze({
  id: LOCAL_MOCK_BACKEND_ID,
  label: LOCAL_MOCK_BACKEND_LABEL,
  simulated: true,
  description: LOCAL_MOCK_BACKEND_DESCRIPTION,
});

export interface LocalMockDeveloperBackendOptions {
  clock?: Clock;
  startMs?: number;
  /** The simulated target's availability once the backend has started. */
  availability?: LocalTestAvailability;
}

/** True when this backend is the local mock, and so offers developer test switches. */
export function isLocalMockDeveloperBackend(backend: DeveloperBackend): backend is LocalMockDeveloperBackend {
  return backend.descriptor.id === LOCAL_MOCK_BACKEND_ID && "testSwitches" in backend;
}

/**
 * The developer test switches a simulated backend offers.
 *
 * Availability goes through the backend rather than straight to the provider, so
 * the switch can never reach "backend not running, target visible" — a state the
 * lifecycle says is impossible. Switching the target on while the backend is
 * stopped records the intent; the backend applies it when it next starts, and a
 * restart keeps it rather than overwriting it.
 */
export interface LocalMockTestSwitches {
  getAvailability: () => LocalTestAvailability;
  setAvailability: (availability: LocalTestAvailability) => void;
  getScenario: () => LocalTestInjectScenario;
  setScenario: (scenario: LocalTestInjectScenario) => void;
}

export interface LocalMockDeveloperBackend extends DeveloperBackend {
  /**
   * The developer test switches, for the composition root to offer. Only a
   * simulated backend has them; the tool controllers still reach the provider
   * through `providers.target` like any other.
   */
  readonly testSwitches: LocalMockTestSwitches;
}

/**
 * The developer backend Nova ships with: the local simulations
 * gathered into one adapter with a lifecycle of its own.
 *
 * ```text
 * Local Mock
 *  ├── Local Test Target   detection, injection and the session, simulated
 *  ├── Mock Debugger       a call stack derived from the script's line count
 *  └── Mock Profiler       deterministic samples, generated from a counter
 * ```
 *
 * Everything happens inside Nova. No process is enumerated, opened, read or
 * written, no library is loaded into anything, no memory outside this
 * application is touched, no shell is invoked and no network endpoint is
 * contacted. Starting the backend means waiting for a timer and then reporting
 * that its simulated target is visible; stopping it means the reverse.
 *
 * The providers are the same deterministic ones as before the adapter layer, composed rather
 * than rewritten: the same script always produces the same stops, and the same
 * recording always produces the same numbers.
 */
export function createLocalMockDeveloperBackend(
  options: LocalMockDeveloperBackendOptions = {},
): LocalMockDeveloperBackend {
  const clock = options.clock ?? systemClock;
  const startMs = options.startMs ?? LOCAL_MOCK_BACKEND_TIMINGS.startMs;
  /**
   * What the developer wants the simulated target to be once the backend runs.
   * The provider itself starts invisible, because a backend that has not been
   * started must not report a target.
   */
  let intended: LocalTestAvailability = options.availability ?? "available";

  const target = createLocalTestTargetProvider({ clock, availability: "unavailable" });
  const debug = createMockDebuggerProvider({ clock });
  const profiler = createMockProfilerProvider({ clock });

  let running = false;

  /** Waits `ms`, or settles early as cancelled when the signal is aborted. */
  const wait = (ms: number, signal: AbortSignal): Promise<"done" | "cancelled"> =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve("cancelled");
        return;
      }
      let timer: TimerId | null = null;
      const onAbort = () => {
        if (timer !== null) clock.clearTimeout(timer);
        timer = null;
        resolve("cancelled");
      };
      signal.addEventListener("abort", onAbort, { once: true });
      timer = clock.setTimeout(() => {
        timer = null;
        signal.removeEventListener("abort", onAbort);
        resolve("done");
      }, ms);
    });

  return {
    descriptor: LOCAL_MOCK_BACKEND_DESCRIPTOR,
    providers: Object.freeze({ target, debugger: debug, profiler }),
    testSwitches: {
      getAvailability: () => intended,
      setAvailability: (next) => {
        intended = next;
        // Only a running backend has a target to show or take away.
        if (running) target.setAvailability(next);
      },
      getScenario: target.getScenario,
      setScenario: target.setScenario,
    },
    start: async ({ signal }) => {
      if (running) return { status: "started" };
      if ((await wait(startMs, signal)) === "cancelled") return { status: "cancelled" };

      running = true;
      // Announcing the simulated target is the whole of "starting" here, and it
      // announces what the developer asked for rather than overwriting it.
      // Whether Nova then follows it is Settings › Target › Auto detect, not this.
      target.setAvailability(intended);
      return { status: "started" };
    },
    stop: async () => {
      if (!running) return;
      running = false;
      // The target goes away first, so the tool controllers see the loss and end
      // their sessions before the session itself is torn down.
      target.setAvailability("unavailable");
      // The disconnect is the whole of "stopping" here; it takes simulated time
      // of its own, so no extra timer is armed that nothing could cancel.
      await target.disconnect();
    },
    getHealth: (): readonly ProviderHealthReport[] => {
      const visible = running && target.getAvailability() === "available";
      return [
        {
          tool: "target",
          health: visible ? "healthy" : "unavailable",
          reason: visible ? null : "The simulated target is switched off.",
        },
        { tool: "debugger", health: "healthy", reason: null },
        { tool: "profiler", health: "healthy", reason: null },
      ];
    },
  };
}
