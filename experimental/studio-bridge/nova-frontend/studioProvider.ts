import type { StudioBridge } from "@/features/bridge/session";
import { STUDIO_PROVIDER_TYPE, type BridgePhase } from "@/features/bridge/types";
import type { ConnectionProvider, ConnectionResult, ConnectionStatus } from "@/features/connection/types";
import type { ExecutionProvider } from "@/features/execution/types";

/**
 * Adapters that present a {@link StudioBridge} through the existing provider
 * interfaces, so the unchanged connection and execution controllers drive it.
 *
 * Connection semantics for the bridge: "connect" starts the loopback listener
 * and succeeds once the bridge is *listening*. Whether a Studio plugin has
 * actually connected is a second, independent axis exposed on the bridge
 * snapshot (`studioConnected`); the execution controller gates on that.
 */

export const STUDIO_CONNECTION_LABEL = "Roblox Studio";

/** Maps the richer bridge lifecycle onto the connection controller's coarse status. */
export function bridgePhaseToConnectionStatus(phase: BridgePhase): ConnectionStatus {
  switch (phase) {
    case "stopped":
      return "disconnected";
    case "starting":
      return "connecting";
    case "listening":
    case "connecting":
    case "connected":
      return "connected";
    case "stopping":
      return "disconnecting";
    case "error":
      return "error";
  }
}

export function createStudioConnectionProvider(bridge: StudioBridge, options: { getPort: () => number }): ConnectionProvider {
  return {
    label: STUDIO_CONNECTION_LABEL,
    providerType: STUDIO_PROVIDER_TYPE,
    connect: async (): Promise<ConnectionResult> => {
      const started = await bridge.start({ port: options.getPort() });
      if (!started) {
        const error = bridge.getSnapshot().error;
        return {
          ok: false,
          error: {
            code: "CONNECTION_FAILED",
            message: error?.message ?? "The Studio bridge could not start.",
            ...(error?.details === undefined ? {} : { details: error.details }),
          },
        };
      }
      // The bridge is listening; latency is unknown until a Studio heartbeat runs.
      return { ok: true, latencyMs: null, latencySimulated: false };
    },
    disconnect: () => bridge.stop(),
    getStatus: () => bridgePhaseToConnectionStatus(bridge.getSnapshot().phase),
  };
}

export function createStudioExecutionProvider(bridge: StudioBridge): ExecutionProvider {
  return {
    label: STUDIO_CONNECTION_LABEL,
    providerType: STUDIO_PROVIDER_TYPE,
    requiresConnection: true,
    execute: (request, hooks) => bridge.execute(request, hooks),
    cancel: (executionId) => bridge.cancel(executionId),
  };
}
