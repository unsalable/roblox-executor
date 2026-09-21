import type { DebuggerProvider, DebugRunOutcome } from "@/features/debugger/types";
import type { ProfilerProvider } from "@/features/profiler/types";
import type { TargetProvider } from "@/features/target/types";

/**
 * Providers for a tool a backend does not supply.
 *
 * A backend that supports only some of the developer tools reports `null` for
 * the rest (see {@link BackendProviders}). The controllers still exist — the
 * Explorer, the editor and the panels must not disappear because one tool is
 * missing — so the composition root wires one of these in its place.
 *
 * **Their whole job is to refuse, in the open.** Every operation answers with the
 * tool's own structured error code, the capability derived for that tool is
 * false, the health report says the backend supplies nothing, and the commands
 * and panels are disabled with that reason. Nothing here reports a success that
 * did not happen, and nothing pretends to be a simulation either: a simulated
 * provider produces test data, while these produce refusals.
 *
 * In practice the devtools binding never marks an unsupported tool as present,
 * so these are asked nothing. They exist so that the one path where that could
 * be wrong fails loudly instead of quietly.
 */

export const UNSUPPORTED_PROVIDER_TYPE = "unsupported";

const TARGET_LABEL = "No Target Provider";
const DEBUGGER_LABEL = "No Debugger";
const PROFILER_LABEL = "No Profiler";

export function createUnsupportedTargetProvider(backendLabel: string): TargetProvider {
  const details = `The ${backendLabel} backend supplies no target provider.`;

  return {
    label: TARGET_LABEL,
    providerType: UNSUPPORTED_PROVIDER_TYPE,
    simulated: false,
    supportsCancel: false,
    detect: () => Promise.resolve({ available: false, ready: false, targetVersion: null }),
    inject: () =>
      Promise.resolve({
        status: "failed",
        error: { code: "PROVIDER_UNAVAILABLE", message: "This backend cannot attach to a target.", details },
      }),
    disconnect: () => Promise.resolve(),
    getDiagnostics: () => ({
      provider: TARGET_LABEL,
      providerType: UNSUPPORTED_PROVIDER_TYPE,
      simulated: false,
      transport: "None",
      session: "inactive",
      latency: null,
      targetVersion: null,
    }),
    subscribe: () => () => undefined,
  };
}

export function createUnsupportedDebuggerProvider(backendLabel: string): DebuggerProvider {
  const details = `The ${backendLabel} backend supplies no debugger provider.`;
  const refuse = (): DebugRunOutcome => ({
    status: "failed",
    error: { code: "DEBUGGER_UNAVAILABLE", message: "This backend cannot debug.", details },
  });

  return {
    label: DEBUGGER_LABEL,
    providerType: UNSUPPORTED_PROVIDER_TYPE,
    simulated: false,
    supportsCancel: false,
    description: "This backend supplies no debugger, so sessions and stepping are unavailable.",
    start: () => Promise.resolve(refuse()),
    resume: () => Promise.resolve(refuse()),
    requestPause: () => undefined,
    stop: () => Promise.resolve(),
    getVariables: () => [],
    evaluate: () => ({
      status: "error",
      error: { code: "WATCH_EVALUATION_FAILED", message: "This backend cannot evaluate a watch.", details },
    }),
  };
}

export function createUnsupportedProfilerProvider(backendLabel: string): ProfilerProvider {
  const details = `The ${backendLabel} backend supplies no profiler provider.`;
  const error = {
    code: "PROFILER_UNAVAILABLE" as const,
    message: "This backend cannot record a profile.",
    details,
  };

  return {
    label: PROFILER_LABEL,
    providerType: UNSUPPORTED_PROVIDER_TYPE,
    simulated: false,
    description: "This backend supplies no profiler, so recordings are unavailable.",
    start: () => Promise.resolve({ status: "failed", error }),
    stop: () => Promise.resolve({ status: "failed", error }),
    read: () => null,
    clear: () => undefined,
  };
}
