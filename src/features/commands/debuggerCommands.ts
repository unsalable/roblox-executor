import { unavailableReason } from "@/features/backend/toolAvailability";
import type { Command } from "@/features/commands/types";
import type { DebugState } from "@/features/debugger/types";

/**
 * The debugger's entries in the command palette.
 *
 * Built as a pure function of the debugger's state, so what the palette offers
 * — and the reason it gives when it cannot — is exactly what the controller
 * would answer. Every command runs the controller action the panel's own
 * buttons run; there are no palette-only implementations.
 */

export interface DebuggerCommandState {
  readonly state: DebugState;
  /** The active backend supplies a debugger at all. */
  readonly supported: boolean;
  /** The active backend is running, so its debugger may be used. */
  readonly backendReady: boolean;
  /** An operation is in flight. */
  readonly busy: boolean;
  /** A pause was already asked for. */
  readonly pausePending: boolean;
  /** The provider can stop a run once it has started. */
  readonly supportsPause: boolean;
  /** A script is open, so a session can be started and lines can be marked. */
  readonly hasScript: boolean;
  /** Breakpoints in the open script. */
  readonly scriptBreakpoints: number;
  /** Breakpoints in every script. */
  readonly totalBreakpoints: number;
}

export interface DebuggerCommandActions {
  readonly start: () => void;
  readonly stop: () => void;
  readonly resume: () => void;
  readonly pause: () => void;
  readonly stepOver: () => void;
  readonly stepInto: () => void;
  readonly stepOut: () => void;
  readonly addBreakpoint: () => void;
  readonly removeBreakpoint: () => void;
  readonly clearBreakpoints: () => void;
}

/** Why a session cannot be started right now, or undefined when it can. */
function startBlockedReason(state: DebuggerCommandState): string | undefined {
  if (state.state === "unavailable") return unavailableReason("debugger", state);
  if (state.state === "running" || state.state === "paused") return "A debug session is already running.";
  if (state.busy) return "A debug operation is already in progress.";
  if (!state.hasScript) return "No script is open.";
  return undefined;
}

/** Why the paused session cannot be moved on, or undefined when it can. */
function resumeBlockedReason(state: DebuggerCommandState): string | undefined {
  if (state.state === "unavailable") return "No target has been detected.";
  if (state.state === "running") return "The session is already running.";
  if (state.state !== "paused") return "No debug session is paused.";
  if (state.busy) return "A debug operation is already in progress.";
  return undefined;
}

function pauseBlockedReason(state: DebuggerCommandState): string | undefined {
  if (state.state !== "running") return "No debug session is running.";
  if (!state.supportsPause) return "This provider cannot pause a run once it has started.";
  if (state.pausePending) return "A pause has already been requested.";
  return undefined;
}

export function buildDebuggerCommands(
  state: DebuggerCommandState,
  actions: DebuggerCommandActions,
): readonly Command[] {
  const startReason = startBlockedReason(state);
  const resumeReason = resumeBlockedReason(state);
  const pauseReason = pauseBlockedReason(state);
  const stopReason =
    state.state === "running" || state.state === "paused" ? undefined : "There is no debug session to stop.";
  const breakpointReason = state.hasScript ? undefined : "No script is open.";
  const removeReason = breakpointReason ?? (state.scriptBreakpoints > 0 ? undefined : "This script has no breakpoints.");
  const clearReason = state.totalBreakpoints > 0 ? undefined : "There are no breakpoints to clear.";

  const disabled = (reason: string | undefined) => (reason === undefined ? {} : { disabledReason: reason });

  return [
    {
      id: "debugger-start",
      title: "Debugger: Start Session",
      category: "Debugger",
      keywords: ["debug", "run", "attach"],
      ...disabled(startReason),
      run: actions.start,
    },
    {
      id: "debugger-continue",
      title: "Debugger: Continue",
      category: "Debugger",
      keywords: ["resume", "debug"],
      ...disabled(resumeReason),
      run: actions.resume,
    },
    {
      id: "debugger-pause",
      title: "Debugger: Pause",
      category: "Debugger",
      keywords: ["break", "debug"],
      ...disabled(pauseReason),
      run: actions.pause,
    },
    {
      id: "debugger-step-over",
      title: "Debugger: Step Over",
      category: "Debugger",
      keywords: ["next", "debug"],
      ...disabled(resumeReason),
      run: actions.stepOver,
    },
    {
      id: "debugger-step-into",
      title: "Debugger: Step Into",
      category: "Debugger",
      keywords: ["down", "debug"],
      ...disabled(resumeReason),
      run: actions.stepInto,
    },
    {
      id: "debugger-step-out",
      title: "Debugger: Step Out",
      category: "Debugger",
      keywords: ["up", "return", "debug"],
      ...disabled(resumeReason),
      run: actions.stepOut,
    },
    {
      id: "debugger-stop",
      title: "Debugger: Stop",
      category: "Debugger",
      keywords: ["end", "debug"],
      ...disabled(stopReason),
      run: actions.stop,
    },
    {
      id: "debugger-add-breakpoint",
      title: "Debugger: Add Breakpoint",
      category: "Debugger",
      keywords: ["breakpoint", "line"],
      ...disabled(breakpointReason),
      run: actions.addBreakpoint,
    },
    {
      id: "debugger-remove-breakpoint",
      title: "Debugger: Remove Breakpoint",
      category: "Debugger",
      keywords: ["breakpoint", "line"],
      ...disabled(removeReason),
      run: actions.removeBreakpoint,
    },
    {
      id: "debugger-clear-breakpoints",
      title: "Debugger: Clear Breakpoints",
      category: "Debugger",
      keywords: ["breakpoint", "remove all"],
      ...disabled(clearReason),
      run: actions.clearBreakpoints,
    },
  ];
}
