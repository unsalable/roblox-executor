import { DEVELOPER_TOOLS } from "@/features/backend/types";
import type {
  BackendCapabilities,
  BackendProviders,
  DeveloperProviderInfo,
  DeveloperTool,
  ProviderHealthReport,
} from "@/features/backend/types";

/**
 * Deriving what a backend supports from the providers it actually supplies.
 *
 * Pure functions only: the same providers always produce the same capabilities,
 * so the Developer Status panel, the palette and the controllers all read one
 * answer and none of them has to guess.
 *
 * A capability is false for exactly two reasons — the backend supplies no
 * provider for that tool, or the provider declares it cannot do that thing. It
 * is never false because a target is missing or an operation is in flight;
 * those are state, and state lives in the controllers.
 */

export function deriveCapabilities(providers: BackendProviders): BackendCapabilities {
  const { target, debugger: debug, profiler } = providers;

  return Object.freeze({
    target: Object.freeze({
      canConnect: target !== null,
      canCancelInject: target?.supportsCancel ?? false,
    }),
    debugger: Object.freeze({
      canDebug: debug !== null,
      canPause: debug?.supportsCancel ?? false,
    }),
    profiler: Object.freeze({
      canProfile: profiler !== null,
    }),
  });
}

/** True when the backend supplies this tool at all. */
export function isToolSupported(capabilities: BackendCapabilities, tool: DeveloperTool): boolean {
  switch (tool) {
    case "target":
      return capabilities.target.canConnect;
    case "debugger":
      return capabilities.debugger.canDebug;
    case "profiler":
      return capabilities.profiler.canProfile;
  }
}

/**
 * The target provider's description, which its own interface does not carry.
 * Every other provider states one; the target's is written here so the common
 * {@link DeveloperProviderInfo} is complete without changing the
 * contract.
 */
const TARGET_DESCRIPTION = "Detection, the inject action and the session Nova executes against.";

/**
 * The providers a backend supplies, as the UI may know them. A tool the backend
 * does not supply produces no entry: the capability says it is unsupported, and
 * an entry describing a provider that is not there would be a lie.
 */
export function describeProviders(providers: BackendProviders): readonly DeveloperProviderInfo[] {
  const { target, debugger: debug, profiler } = providers;
  const list: DeveloperProviderInfo[] = [];

  if (target !== null) {
    list.push(
      Object.freeze({
        tool: "target" as const,
        label: target.label,
        providerType: target.providerType,
        simulated: target.simulated,
        description: TARGET_DESCRIPTION,
      }),
    );
  }
  if (debug !== null) {
    list.push(
      Object.freeze({
        tool: "debugger" as const,
        label: debug.label,
        providerType: debug.providerType,
        simulated: debug.simulated,
        description: debug.description,
      }),
    );
  }
  if (profiler !== null) {
    list.push(
      Object.freeze({
        tool: "profiler" as const,
        label: profiler.label,
        providerType: profiler.providerType,
        simulated: profiler.simulated,
        description: profiler.description,
      }),
    );
  }

  return Object.freeze(list);
}

/**
 * One health report per developer tool, in {@link DEVELOPER_TOOLS} order.
 *
 * A tool the backend did not report on falls back to `unavailable` rather than
 * being left out, so every reader gets one row per tool and none of them has to
 * decide what a missing row means.
 */
export function normalizeHealth(
  reports: readonly ProviderHealthReport[],
  capabilities: BackendCapabilities,
): readonly ProviderHealthReport[] {
  return Object.freeze(
    DEVELOPER_TOOLS.map((tool) => {
      const reported = reports.find((report) => report.tool === tool);
      if (reported) return Object.freeze({ ...reported });
      return Object.freeze({
        tool,
        health: "unavailable" as const,
        reason: isToolSupported(capabilities, tool)
          ? "The backend did not report on this provider."
          : "This backend supplies no provider for this tool.",
      });
    }),
  );
}

/** Health reports for a backend that is not running: nothing is usable yet. */
export function restingHealth(reason: string): readonly ProviderHealthReport[] {
  return Object.freeze(
    DEVELOPER_TOOLS.map((tool) => Object.freeze({ tool, health: "unavailable" as const, reason })),
  );
}

/** The health of one tool, for the surfaces that ask about a single one. */
export function healthOf(
  reports: readonly ProviderHealthReport[],
  tool: DeveloperTool,
): ProviderHealthReport {
  return reports.find((report) => report.tool === tool) ?? { tool, health: "unavailable", reason: null };
}
