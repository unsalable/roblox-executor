import type { Command } from "@/features/commands/types";
import { isUpdateBusy } from "@/features/updates/updateState";
import type { UpdateStatus } from "@/features/updates/types";

/**
 * The updater's entries in the command palette. Pure, for the same reason the
 * debugger's and the profiler's are: what the palette offers is exactly what
 * the update controller would accept, and every command runs the controller
 * action — there are no palette-only implementations.
 */

export interface UpdateCommandState {
  readonly status: UpdateStatus;
  /** This build can update itself: a packaged release rather than a development build. */
  readonly available: boolean;
  /** A release has been found and not yet installed. */
  readonly hasRelease: boolean;
}

export interface UpdateCommandActions {
  readonly check: () => void;
  readonly showUpdate: () => void;
}

/** Why Nova cannot check right now, or undefined when it can. */
function checkBlockedReason(state: UpdateCommandState): string | undefined {
  if (!state.available) return "This build cannot update itself; it was not installed from a release.";
  if (isUpdateBusy(state.status)) return "Nova is already checking or installing an update.";
  if (state.status === "ready") return "An update is installed and waiting for a restart.";
  return undefined;
}

export function buildUpdateCommands(state: UpdateCommandState, actions: UpdateCommandActions): readonly Command[] {
  const checkReason = checkBlockedReason(state);
  const showReason =
    state.hasRelease || state.status === "ready" ? undefined : "No update has been found to show.";

  const disabled = (reason: string | undefined) => (reason === undefined ? {} : { disabledReason: reason });

  return [
    {
      id: "updates-check",
      title: "Check for Updates",
      category: "Updates",
      keywords: ["update", "upgrade", "version", "release", "build"],
      ...disabled(checkReason),
      run: actions.check,
    },
    {
      id: "updates-show",
      title: "Show Update",
      category: "Updates",
      keywords: ["update", "install", "restart", "release"],
      ...disabled(showReason),
      run: actions.showUpdate,
    },
  ];
}
