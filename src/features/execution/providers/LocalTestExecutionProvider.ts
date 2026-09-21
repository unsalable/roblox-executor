import type { ExecutionOutcome, ExecutionProvider } from "@/features/execution/types";
import { systemClock, type Clock, type TimerId } from "@/lib/clock";

/**
 * Developer test scenarios. They are chosen through provider configuration,
 * never through the script text.
 */
export type LocalTestExecutionScenario = "success" | "error" | "slow" | "cancel";

export const LOCAL_TEST_EXECUTION_SCENARIOS: readonly { value: LocalTestExecutionScenario; label: string }[] = [
  { value: "success", label: "Succeed" },
  { value: "error", label: "Fail" },
  { value: "slow", label: "Run slowly (15 s)" },
  { value: "cancel", label: "Stop partway" },
];

export interface LocalTestExecutionProviderOptions {
  scenario?: LocalTestExecutionScenario;
  preparingMs?: number;
  runningMs?: number;
  /** Running time of the "slow" scenario; longer than the default timeout. */
  slowRunningMs?: number;
  clock?: Clock;
}

export interface LocalTestExecutionProvider extends ExecutionProvider {
  getScenario: () => LocalTestExecutionScenario;
  /** Applies to executions started afterwards. */
  setScenario: (scenario: LocalTestExecutionScenario) => void;
  /** Simulations that have not ended yet. */
  activeCount: () => number;
}

// Named after what it is, not after the target: a real target provider now
// exists, and two boundaries sharing one label made the diagnostics dialog read
// as though the execution provider was that target.
export const LOCAL_TEST_EXECUTION_LABEL = "Local Test Execution";
export const LOCAL_TEST_EXECUTION_TYPE = "local-test";

interface Simulation {
  timer: TimerId | null;
  end: (outcome: ExecutionOutcome) => void;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * The execution half of the local test target: it exercises Nova's execution
 * pipeline without a real target. It only waits and reports — the source is
 * never evaluated, interpreted or passed anywhere, and no process, file or
 * network endpoint is touched.
 *
 * It declares `requiresTarget`, so the execution controller refuses requests
 * with `TARGET_NOT_READY` until the target controller reports an injected
 * target. That gate is the contract a replacement provider inherits.
 */
export function createLocalTestExecutionProvider(
  options: LocalTestExecutionProviderOptions = {},
): LocalTestExecutionProvider {
  const clock = options.clock ?? systemClock;
  const preparingMs = options.preparingMs ?? 150;
  const runningMs = options.runningMs ?? 450;
  const slowRunningMs = options.slowRunningMs ?? 15_000;
  let scenario = options.scenario ?? "success";
  const simulations = new Map<string, Simulation>();

  return {
    label: LOCAL_TEST_EXECUTION_LABEL,
    providerType: LOCAL_TEST_EXECUTION_TYPE,
    requiresTarget: true,

    execute: (request, hooks) =>
      new Promise<ExecutionOutcome>((resolve) => {
        const { executionId, source } = request;
        const planned = scenario;
        const simulation: Simulation = {
          timer: null,
          end: (outcome) => {
            clock.clearTimeout(simulation.timer);
            simulation.timer = null;
            simulations.delete(executionId);
            resolve(outcome);
          },
        };
        simulations.set(executionId, simulation);

        simulation.timer = clock.setTimeout(() => {
          if (source.trim() === "") {
            simulation.end({
              status: "error",
              error: {
                code: "EMPTY_SOURCE",
                message: "Script is empty.",
                details: "The local test target received no source text.",
              },
            });
            return;
          }

          hooks.onRunning();

          const lines = source.split("\n").length;
          simulation.timer = clock.setTimeout(
            () => {
              if (planned === "error") {
                simulation.end({
                  status: "error",
                  error: {
                    code: "PROVIDER_ERROR",
                    message: "The local test target reported a simulated failure.",
                    details: 'Produced by the "Fail" test scenario. The source was not evaluated.',
                  },
                });
              } else if (planned === "cancel") {
                simulation.end({ status: "cancelled" });
              } else {
                simulation.end({
                  status: "success",
                  output: [
                    `Execution succeeded in ${LOCAL_TEST_EXECUTION_LABEL} (simulated).`,
                    `${plural(lines, "line")} (${plural(source.length, "character")}) received, not evaluated.`,
                  ],
                });
              }
            },
            planned === "slow" ? slowRunningMs : planned === "cancel" ? Math.round(runningMs / 2) : runningMs,
          );
        }, preparingMs);
      }),

    cancel: (executionId) => {
      simulations.get(executionId)?.end({ status: "cancelled" });
    },

    getScenario: () => scenario,
    setScenario: (next) => {
      scenario = next;
    },
    activeCount: () => simulations.size,
  };
}
