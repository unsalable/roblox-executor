import { createUnsupportedDebuggerProvider, createUnsupportedProfilerProvider } from "@/features/backend/providers/unsupported";
import type {
  BackendDescriptor,
  BackendError,
  BackendProviders,
  DeveloperBackend,
  ProviderHealth,
  ProviderHealthReport,
} from "@/features/backend/types";
import { createMockDebuggerProvider } from "@/features/debugger/providers/MockDebuggerProvider";
import { createMockProfilerProvider } from "@/features/profiler/providers/MockProfilerProvider";
import {
  createLocalTestTargetProvider,
  type LocalTestTargetProvider,
} from "@/features/target/providers/LocalTestTargetProvider";
import type { Clock, TimerId } from "@/lib/clock";

/**
 * Reusable backends for the contract tests.
 *
 * Test-only; never imported by application code, the same way
 * `lib/testing/fakeClock.ts` is not. The shipped backend lives in
 * `features/backend/backends/`, so nothing here reaches the production bundle.
 *
 * Every backend here is built from the real providers and the real controllers
 * are put on top of them, so a contract test exercises the production pipeline
 * with only the outermost edge replaced. Each one takes the test's fake clock, so
 * a lifecycle operation settles when the test advances time and never in real
 * time.
 */

export interface HarnessBackendOptions {
  clock: Clock;
  /** Milliseconds a start takes. */
  startMs?: number;
  /** Milliseconds a stop takes. */
  stopMs?: number;
  id?: string;
  label?: string;
}

/** The test-only handles a harness backend exposes beyond the production interface. */
export interface HarnessProbes {
  /** How often `start` was invoked. Two means idempotency was broken. */
  starts: () => number;
  stops: () => number;
  /** The simulated target, for moving it by hand. Null when the backend has none. */
  target: LocalTestTargetProvider | null;
  /** Replaces what `getHealth` answers, for the degraded and error rows. */
  setHealth: (tool: ProviderHealthReport["tool"], health: ProviderHealth, reason: string | null) => void;
}

export type HarnessBackend = DeveloperBackend & HarnessProbes;

const descriptorOf = (options: HarnessBackendOptions, fallbackId: string, fallbackLabel: string): BackendDescriptor =>
  Object.freeze({
    id: options.id ?? fallbackId,
    label: options.label ?? fallbackLabel,
    simulated: true,
    description: "A backend built for the contract tests. Nothing outside Nova is touched.",
  });

/** Waits `ms` on the test clock, or settles early as cancelled when aborted. */
function wait(clock: Clock, ms: number, signal: AbortSignal): Promise<"done" | "cancelled"> {
  return new Promise((resolve) => {
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
}

interface HarnessCore {
  providers: BackendProviders;
  target: LocalTestTargetProvider | null;
  starts: () => number;
  stops: () => number;
  countStart: () => void;
  countStop: () => void;
  health: () => readonly ProviderHealthReport[];
  setHealth: HarnessProbes["setHealth"];
}

/** The pieces every harness backend shares: real providers, counters and health overrides. */
function createCore(clock: Clock, tools: { target: boolean; debugger: boolean; profiler: boolean }): HarnessCore {
  const target = tools.target ? createLocalTestTargetProvider({ clock, availability: "unavailable" }) : null;
  const providers: BackendProviders = Object.freeze({
    target,
    debugger: tools.debugger ? createMockDebuggerProvider({ clock }) : null,
    profiler: tools.profiler ? createMockProfilerProvider({ clock }) : null,
  });

  let starts = 0;
  let stops = 0;
  const overrides = new Map<ProviderHealthReport["tool"], { health: ProviderHealth; reason: string | null }>();

  const reportFor = (tool: ProviderHealthReport["tool"], supported: boolean): ProviderHealthReport => {
    const override = overrides.get(tool);
    if (override) return { tool, health: override.health, reason: override.reason };
    if (!supported) return { tool, health: "unavailable", reason: "This backend supplies no provider for this tool." };
    if (tool === "target") {
      const visible = target?.getAvailability() === "available";
      return { tool, health: visible ? "healthy" : "unavailable", reason: visible ? null : "No target is visible." };
    }
    return { tool, health: "healthy", reason: null };
  };

  return {
    providers,
    target,
    starts: () => starts,
    stops: () => stops,
    countStart: () => {
      starts += 1;
    },
    countStop: () => {
      stops += 1;
    },
    health: () => [
      reportFor("target", tools.target),
      reportFor("debugger", tools.debugger),
      reportFor("profiler", tools.profiler),
    ],
    setHealth: (tool, health, reason) => overrides.set(tool, { health, reason }),
  };
}

/**
 * A backend that starts, becomes ready and reports a visible target. The
 * baseline every other harness backend is a variation on.
 */
export function createMockBackend(options: HarnessBackendOptions): HarnessBackend {
  const { clock } = options;
  const startMs = options.startMs ?? 50;
  const stopMs = options.stopMs ?? 30;
  const core = createCore(clock, { target: true, debugger: true, profiler: true });
  let running = false;

  return {
    descriptor: descriptorOf(options, "harness-mock", "Harness Mock"),
    providers: core.providers,
    start: async ({ signal }) => {
      core.countStart();
      if ((await wait(clock, startMs, signal)) === "cancelled") return { status: "cancelled" };
      running = true;
      core.target?.setAvailability("available");
      return { status: "started" };
    },
    stop: async () => {
      core.countStop();
      if (!running) return;
      running = false;
      core.target?.setAvailability("unavailable");
      await core.target?.disconnect();
      await new Promise<void>((resolve) => {
        clock.setTimeout(resolve, stopMs);
      });
    },
    getHealth: core.health,
    starts: core.starts,
    stops: core.stops,
    target: core.target,
    setHealth: core.setHealth,
  };
}

export interface FailingBackendOptions extends HarnessBackendOptions {
  /** How it fails: a reported failure, a thrown error, or a failure to stop. */
  mode?: "reported" | "thrown" | "stop";
  error?: BackendError;
}

/** A backend whose start (or stop) does not succeed. */
export function createFailingProvider(options: FailingBackendOptions): HarnessBackend {
  const { clock } = options;
  const startMs = options.startMs ?? 50;
  const mode = options.mode ?? "reported";
  const error: BackendError = options.error ?? {
    code: "PROVIDER_START_FAILED",
    message: "The harness backend refused to start.",
    details: "Configured to fail by the test.",
  };
  const core = createCore(clock, { target: true, debugger: true, profiler: true });

  return {
    descriptor: descriptorOf(options, "harness-failing", "Harness Failing"),
    providers: core.providers,
    start: async ({ signal }) => {
      core.countStart();
      if ((await wait(clock, startMs, signal)) === "cancelled") return { status: "cancelled" };
      if (mode === "thrown") throw new Error("The harness backend threw while starting");
      if (mode === "stop") {
        core.target?.setAvailability("available");
        return { status: "started" };
      }
      return { status: "failed", error };
    },
    stop: async () => {
      core.countStop();
      if (mode === "stop") throw new Error("The harness backend threw while stopping");
      core.target?.setAvailability("unavailable");
    },
    getHealth: core.health,
    starts: core.starts,
    stops: core.stops,
    target: core.target,
    setHealth: core.setHealth,
  };
}

/**
 * A backend that never answers, so the controller's start timeout is what ends
 * the operation. Its delay is longer than any timeout the tests configure.
 */
export function createDelayedProvider(options: HarnessBackendOptions): HarnessBackend {
  const { clock } = options;
  const startMs = options.startMs ?? 600_000;
  const core = createCore(clock, { target: true, debugger: true, profiler: true });

  return {
    descriptor: descriptorOf(options, "harness-delayed", "Harness Delayed"),
    providers: core.providers,
    start: async ({ signal }) => {
      core.countStart();
      if ((await wait(clock, startMs, signal)) === "cancelled") return { status: "cancelled" };
      core.target?.setAvailability("available");
      return { status: "started" };
    },
    stop: async () => {
      core.countStop();
      core.target?.setAvailability("unavailable");
    },
    getHealth: core.health,
    starts: core.starts,
    stops: core.stops,
    target: core.target,
    setHealth: core.setHealth,
  };
}

/**
 * A backend that starts, then loses its target on its own — the unexpected
 * disconnect the tool controllers have to survive.
 */
export function createDisconnectingProvider(
  options: HarnessBackendOptions & { afterMs?: number },
): HarnessBackend {
  const { clock } = options;
  const startMs = options.startMs ?? 50;
  const afterMs = options.afterMs ?? 200;
  const core = createCore(clock, { target: true, debugger: true, profiler: true });

  return {
    descriptor: descriptorOf(options, "harness-disconnecting", "Harness Disconnecting"),
    providers: core.providers,
    start: async ({ signal }) => {
      core.countStart();
      if ((await wait(clock, startMs, signal)) === "cancelled") return { status: "cancelled" };
      core.target?.setAvailability("available");
      // The target goes away by itself, without the backend stopping: the two
      // lifecycles are separate and this is the case that proves it.
      clock.setTimeout(() => core.target?.setAvailability("unavailable"), afterMs);
      return { status: "started" };
    },
    stop: async () => {
      core.countStop();
      core.target?.setAvailability("unavailable");
    },
    getHealth: core.health,
    starts: core.starts,
    stops: core.stops,
    target: core.target,
    setHealth: core.setHealth,
  };
}

/**
 * A backend that supplies a target but neither of the other tools. The
 * capability system's reason for existing: "Backend ready, Target ready,
 * Debugger unavailable" has to be a state Nova can be in and show.
 */
export function createPartialBackend(options: HarnessBackendOptions): HarnessBackend {
  const { clock } = options;
  const startMs = options.startMs ?? 50;
  const core = createCore(clock, { target: true, debugger: false, profiler: false });

  return {
    descriptor: descriptorOf(options, "harness-partial", "Harness Partial"),
    providers: core.providers,
    start: async ({ signal }) => {
      core.countStart();
      if ((await wait(clock, startMs, signal)) === "cancelled") return { status: "cancelled" };
      core.target?.setAvailability("available");
      return { status: "started" };
    },
    stop: async () => {
      core.countStop();
      core.target?.setAvailability("unavailable");
    },
    getHealth: core.health,
    starts: core.starts,
    stops: core.stops,
    target: core.target,
    setHealth: core.setHealth,
  };
}

/** The stand-ins the composition root wires for a tool a backend does not supply. */
export const unsupportedProviders = {
  debugger: createUnsupportedDebuggerProvider,
  profiler: createUnsupportedProfilerProvider,
} as const;
