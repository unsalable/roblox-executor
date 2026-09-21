import type { BackendState } from "@/features/backend/types";
import type { Command } from "@/features/commands/types";

/**
 * The developer backend's entries in the command palette. Pure, for the same
 * reason the debugger's and the profiler's are: what the palette offers is
 * exactly what the backend controller would accept, and every command runs the
 * controller action — there are no palette-only implementations.
 *
 * These are the only actions in Nova that act on the adapter layer itself rather
 * than on a target, a script or a session, which is why they are their own
 * category.
 */

export interface DeveloperCommandState {
  readonly state: BackendState;
  /** A lifecycle operation is in flight. */
  readonly busy: boolean;
  /** The backend supplies at least one provider, so there is something to report on. */
  readonly hasProviders: boolean;
}

export interface DeveloperCommandActions {
  readonly showStatus: () => void;
  readonly restartBackend: () => void;
  readonly refreshCapabilities: () => void;
}

/**
 * Why the backend cannot be restarted right now, or undefined when it can.
 *
 * A backend that has never been started is restartable on purpose: with
 * Settings › Developer › Auto start off, `created` is where it rests, and this is
 * the only command that can start it. Restarting from there stops nothing and
 * starts it, which is exactly what the setting's description promises.
 */
function restartBlockedReason(state: DeveloperCommandState): string | undefined {
  if (state.busy) return "The backend is already starting or stopping.";
  return undefined;
}

export function buildDeveloperCommands(
  state: DeveloperCommandState,
  actions: DeveloperCommandActions,
): readonly Command[] {
  const restartReason = restartBlockedReason(state);
  const refreshReason = state.hasProviders ? undefined : "This backend supplies no providers to ask.";

  const disabled = (reason: string | undefined) => (reason === undefined ? {} : { disabledReason: reason });

  return [
    {
      id: "developer-backend-status",
      title: "Developer: Show Backend Status",
      category: "Developer",
      keywords: ["backend", "provider", "diagnostics", "capabilities"],
      run: actions.showStatus,
    },
    {
      id: "developer-restart-backend",
      title: "Developer: Restart Backend",
      category: "Developer",
      keywords: ["backend", "reload", "provider"],
      ...disabled(restartReason),
      run: actions.restartBackend,
    },
    {
      id: "developer-refresh-capabilities",
      title: "Developer: Refresh Capabilities",
      category: "Developer",
      keywords: ["backend", "capabilities", "health"],
      ...disabled(refreshReason),
      run: actions.refreshCapabilities,
    },
  ];
}
