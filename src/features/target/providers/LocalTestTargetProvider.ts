import type {
  InjectOutcome,
  InjectRequest,
  TargetDetection,
  TargetDiagnostics,
  TargetProvider,
} from "@/features/target/types";
import { systemClock, type Clock, type TimerId } from "@/lib/clock";

/**
 * Developer test scenarios for the inject operation. They are chosen through
 * provider configuration in the diagnostics dialog, never derived from a script
 * or from anything outside Nova.
 */
export type LocalTestInjectScenario = "success" | "failure" | "slow" | "timeout" | "cancelled";

export const LOCAL_TEST_INJECT_SCENARIOS: readonly { value: LocalTestInjectScenario; label: string }[] = [
  { value: "success", label: "Succeed" },
  { value: "failure", label: "Fail" },
  { value: "slow", label: "Run slowly (15 s)" },
  { value: "timeout", label: "Never answer (times out)" },
  { value: "cancelled", label: "Stop partway" },
];

export type LocalTestAvailability = "available" | "unavailable";

export const LOCAL_TEST_AVAILABILITY: readonly { value: LocalTestAvailability; label: string }[] = [
  { value: "available", label: "Available" },
  { value: "unavailable", label: "Unavailable" },
];

export const LOCAL_TEST_TARGET_LABEL = "Local Test Target";
export const LOCAL_TEST_TARGET_TYPE = "local-test";
const TARGET_VERSION = "Test Target v1";

/**
 * Simulated timings. They are test values, reported as simulated wherever they
 * are shown, and are the only reason an operation here takes any time at all.
 */
export const LOCAL_TEST_TIMINGS = {
  detectMs: 200,
  injectMs: 500,
  disconnectMs: 150,
  /** "Run slowly": longer than the default inject timeout, but it does finish. */
  slowInjectMs: 15_000,
  /** "Never answer": longer than any timeout the settings allow. */
  unansweredInjectMs: 600_000,
} as const;

export interface LocalTestTargetProviderOptions {
  availability?: LocalTestAvailability;
  scenario?: LocalTestInjectScenario;
  detectMs?: number;
  injectMs?: number;
  disconnectMs?: number;
  slowInjectMs?: number;
  unansweredInjectMs?: number;
  clock?: Clock;
}

export interface LocalTestTargetProvider extends TargetProvider {
  getAvailability: () => LocalTestAvailability;
  /**
   * Simulates the target appearing or going away. Setting it to "unavailable"
   * while a session is active is how an unexpected disconnect is exercised.
   */
  setAvailability: (availability: LocalTestAvailability) => void;
  getScenario: () => LocalTestInjectScenario;
  /** Applies to inject requests started afterwards. */
  setScenario: (scenario: LocalTestInjectScenario) => void;
}

/**
 * A local stand-in for an external target, used to build and exercise Nova's
 * target workflow. Everything here happens inside Nova: no process is
 * enumerated, opened, read or written, no library is loaded into anything, no
 * memory outside this application is touched and no network endpoint is
 * contacted. "Injecting" means waiting for a timer and reporting a simulated
 * outcome, and the provider says so in its own diagnostics.
 */
export function createLocalTestTargetProvider(
  options: LocalTestTargetProviderOptions = {},
): LocalTestTargetProvider {
  const clock = options.clock ?? systemClock;
  const detectMs = options.detectMs ?? LOCAL_TEST_TIMINGS.detectMs;
  const injectMs = options.injectMs ?? LOCAL_TEST_TIMINGS.injectMs;
  const disconnectMs = options.disconnectMs ?? LOCAL_TEST_TIMINGS.disconnectMs;
  const slowInjectMs = options.slowInjectMs ?? LOCAL_TEST_TIMINGS.slowInjectMs;
  const unansweredInjectMs = options.unansweredInjectMs ?? LOCAL_TEST_TIMINGS.unansweredInjectMs;

  let availability: LocalTestAvailability = options.availability ?? "available";
  let scenario: LocalTestInjectScenario = options.scenario ?? "success";
  let sessionActive = false;
  let pendingInject: { timer: TimerId; end: (outcome: InjectOutcome) => void } | null = null;
  let closing: { timer: TimerId; resolve: () => void; promise: Promise<void> } | null = null;

  const listeners = new Set<(detection: TargetDetection) => void>();

  const detection = (): TargetDetection => ({
    available: availability === "available",
    ready: availability === "available",
    targetVersion: availability === "available" ? TARGET_VERSION : null,
  });

  const announce = () => {
    const current = detection();
    for (const listener of [...listeners]) listener(current);
  };

  const delayFor = (planned: LocalTestInjectScenario): number => {
    if (planned === "slow") return slowInjectMs;
    if (planned === "timeout") return unansweredInjectMs;
    if (planned === "cancelled") return Math.round(injectMs / 2);
    return injectMs;
  };

  return {
    label: LOCAL_TEST_TARGET_LABEL,
    providerType: LOCAL_TEST_TARGET_TYPE,
    simulated: true,
    supportsCancel: true,

    detect: () =>
      new Promise<TargetDetection>((resolve) => {
        clock.setTimeout(() => resolve(detection()), detectMs);
      }),

    inject: (_request: InjectRequest, { signal }) =>
      new Promise<InjectOutcome>((resolve) => {
        if (availability !== "available") {
          resolve({
            status: "failed",
            error: {
              code: "TARGET_UNAVAILABLE",
              message: `No ${LOCAL_TEST_TARGET_LABEL} is available.`,
              details: 'The "Unavailable" test scenario is selected.',
            },
          });
          return;
        }

        const planned = scenario;
        let stopListening = () => {};

        const end = (outcome: InjectOutcome) => {
          if (pendingInject) clock.clearTimeout(pendingInject.timer);
          pendingInject = null;
          stopListening();
          resolve(outcome);
        };

        // Cancellation is real here: the pending timer is cleared and the
        // request settles as cancelled, never as an injection that happened.
        const onAbort = () => end({ status: "cancelled" });
        if (signal.aborted) {
          resolve({ status: "cancelled" });
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        stopListening = () => signal.removeEventListener("abort", onAbort);

        const timer = clock.setTimeout(() => {
          if (planned === "failure") {
            end({
              status: "failed",
              error: {
                code: "INJECTION_FAILED",
                message: `The ${LOCAL_TEST_TARGET_LABEL} reported a simulated failure.`,
                details: 'Produced by the "Fail" test scenario. Nothing was attached to.',
              },
            });
            return;
          }
          if (planned === "cancelled") {
            end({ status: "cancelled" });
            return;
          }
          sessionActive = true;
          end({ status: "injected" });
        }, delayFor(planned));

        pendingInject = { timer, end };
      }),

    disconnect: () => {
      pendingInject?.end({ status: "cancelled" });

      if (!sessionActive) {
        return closing?.promise ?? Promise.resolve();
      }
      if (closing) return closing.promise;

      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      const timer = clock.setTimeout(() => {
        closing = null;
        sessionActive = false;
        resolve();
      }, disconnectMs);
      closing = { timer, resolve, promise };
      return promise;
    },

    getDiagnostics: (): TargetDiagnostics => ({
      provider: LOCAL_TEST_TARGET_LABEL,
      providerType: LOCAL_TEST_TARGET_TYPE,
      simulated: true,
      transport: "Local",
      session: sessionActive ? "active" : "inactive",
      latency: "Simulated",
      targetVersion: availability === "available" ? TARGET_VERSION : null,
    }),

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getAvailability: () => availability,
    setAvailability: (next) => {
      if (next === availability) return;
      availability = next;
      if (availability === "unavailable") {
        // The target vanishing takes its session with it, exactly as an
        // unexpected disconnect would.
        sessionActive = false;
        pendingInject?.end({
          status: "failed",
          error: {
            code: "TARGET_DISCONNECTED",
            message: `The ${LOCAL_TEST_TARGET_LABEL} went away during the injection.`,
            details: 'Produced by setting the test target to "Unavailable".',
          },
        });
      }
      announce();
    },

    getScenario: () => scenario,
    setScenario: (next) => {
      scenario = next;
    },
  };
}
