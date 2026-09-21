import type { BackendCapabilities, BackendState } from "@/features/backend/types";
import { isBackendReady } from "@/features/backend/backendState";

/**
 * Why a developer tool has nothing to work against.
 *
 * A tool reports `unavailable` for three different reasons. There used to be only
 * one, so every surface said "No target has been detected." That
 * is now sometimes untrue: the backend may not be running, or may not supply the
 * tool at all. This is the one place the outermost cause is named, so the command
 * palette and the tool panels give the same answer rather than two.
 *
 * It answers about capability and lifecycle only. Whether a target is there is
 * the target controller's answer, and it is the last thing left when the other
 * two are fine.
 */

/** The two facts about a tool that come from the backend rather than the target. */
export interface ToolAvailability {
  /** The active backend supplies this tool at all. */
  readonly supported: boolean;
  /** The backend is ready, so its providers may be used. */
  readonly backendReady: boolean;
}

export type GatedTool = "debugger" | "profiler";

const MISSING: Record<GatedTool, string> = {
  debugger: "This developer backend provides no debugger.",
  profiler: "This developer backend provides no profiler.",
};

const BACKEND_NOT_RUNNING = "The developer backend is not running.";
const NO_TARGET = "No target has been detected.";

/**
 * The reason a tool cannot be used, named outermost cause first: a tool the
 * backend does not supply, then a backend that is not running, then the target.
 * Callers use it exactly where the tool reports `unavailable`.
 */
export function unavailableReason(tool: GatedTool, availability: ToolAvailability): string {
  if (!availability.supported) return MISSING[tool];
  if (!availability.backendReady) return BACKEND_NOT_RUNNING;
  return NO_TARGET;
}

/** What the backend says about one tool, for the surfaces that read a snapshot. */
export function toolAvailability(
  tool: GatedTool,
  state: BackendState,
  capabilities: BackendCapabilities,
): ToolAvailability {
  return {
    supported: tool === "debugger" ? capabilities.debugger.canDebug : capabilities.profiler.canProfile,
    backendReady: isBackendReady(state),
  };
}
