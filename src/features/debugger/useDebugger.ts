import { useMemo, useSyncExternalStore } from "react";
import { useAppServices } from "@/app/services";
import { breakpointsForScript } from "@/features/debugger/breakpoints";
import type { DebuggerController } from "@/features/debugger/debuggerController";
import type { Breakpoint, DebuggerSnapshot, StackFrame } from "@/features/debugger/types";

/**
 * React's view of the debugger controller. Components read state through these
 * hooks and never hold a copy, so the editor gutter, the debugger panel and the
 * command palette all show the same breakpoints and the same stop.
 */

export interface DebuggerView extends DebuggerSnapshot {
  controller: DebuggerController;
}

export function useDebugger(): DebuggerView {
  const { debug } = useAppServices();
  const snapshot = useSyncExternalStore(debug.subscribe, debug.getSnapshot);
  return { ...snapshot, controller: debug };
}

/** The frame the inspector is showing, or null when execution is not paused. */
export function useCurrentFrame(): StackFrame | null {
  const { debug } = useAppServices();
  const snapshot = useSyncExternalStore(debug.subscribe, debug.getSnapshot);
  return useMemo(
    () => snapshot.stack.find((frame) => frame.id === snapshot.currentFrameId) ?? null,
    [snapshot.stack, snapshot.currentFrameId],
  );
}

export interface EditorDebugState {
  /** The breakpoints of this script, in line order. */
  breakpoints: readonly Breakpoint[];
  /** The line execution is stopped on in this script, or null. */
  activeLine: number | null;
}

/**
 * What the editor has to draw for one script. It is memoized on the pieces the
 * editor actually uses, so a debugger change that does not touch this script
 * leaves the editor's props identical and the memoized editor does not
 * re-render.
 */
export function useEditorDebugState(scriptId: string | null): EditorDebugState {
  const { debug } = useAppServices();
  const snapshot = useSyncExternalStore(debug.subscribe, debug.getSnapshot);
  const { breakpoints, stack, currentFrameId, state } = snapshot;

  return useMemo(() => {
    const frame = state === "paused" ? stack.find((entry) => entry.id === currentFrameId) : undefined;
    return {
      breakpoints: breakpointsForScript(breakpoints, scriptId),
      activeLine: frame !== undefined && frame.scriptId === scriptId ? frame.line : null,
    };
  }, [breakpoints, stack, currentFrameId, state, scriptId]);
}
