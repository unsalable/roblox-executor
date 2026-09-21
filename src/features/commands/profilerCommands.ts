import { unavailableReason } from "@/features/backend/toolAvailability";
import type { Command } from "@/features/commands/types";
import type { ProfilerState } from "@/features/profiler/types";

/**
 * The profiler's entries in the command palette. Pure, for the same reason the
 * debugger's are: what the palette offers is exactly what the controller would
 * accept, and each command runs the action the panel's own buttons run.
 */

export interface ProfilerCommandState {
  readonly state: ProfilerState;
  /** The active backend supplies a profiler at all. */
  readonly supported: boolean;
  /** The active backend is running, so its profiler may be used. */
  readonly backendReady: boolean;
  /** An operation is in flight. */
  readonly busy: boolean;
  /** A finished recording is on screen. */
  readonly hasSession: boolean;
  /** A finished recording or some history exists. */
  readonly hasData: boolean;
}

export interface ProfilerCommandActions {
  readonly start: () => void;
  readonly stop: () => void;
  readonly clear: () => void;
  readonly refresh: () => void;
}

function startBlockedReason(state: ProfilerCommandState): string | undefined {
  if (state.state === "unavailable") return unavailableReason("profiler", state);
  if (state.state === "recording") return "A recording is already running.";
  if (state.busy) return "A profiler operation is already in progress.";
  return undefined;
}

export function buildProfilerCommands(
  state: ProfilerCommandState,
  actions: ProfilerCommandActions,
): readonly Command[] {
  const startReason = startBlockedReason(state);
  const stopReason =
    state.state !== "recording"
      ? "There is no recording to stop."
      : state.busy
        ? "A profiler operation is already in progress."
        : undefined;
  const clearReason =
    state.state === "recording"
      ? "Stop the recording first."
      : state.hasData
        ? undefined
        : "There is nothing to clear.";
  const refreshReason = state.hasSession ? undefined : "There is no recorded session to read again.";

  const disabled = (reason: string | undefined) => (reason === undefined ? {} : { disabledReason: reason });

  return [
    {
      id: "profiler-start",
      title: "Profiler: Start",
      category: "Profiler",
      keywords: ["record", "performance"],
      ...disabled(startReason),
      run: actions.start,
    },
    {
      id: "profiler-stop",
      title: "Profiler: Stop",
      category: "Profiler",
      keywords: ["record", "performance"],
      ...disabled(stopReason),
      run: actions.stop,
    },
    {
      id: "profiler-clear",
      title: "Profiler: Clear",
      category: "Profiler",
      keywords: ["reset", "sessions"],
      ...disabled(clearReason),
      run: actions.clear,
    },
    {
      id: "profiler-refresh",
      title: "Profiler: Refresh",
      category: "Profiler",
      keywords: ["reload", "samples"],
      ...disabled(refreshReason),
      run: actions.refresh,
    },
  ];
}
