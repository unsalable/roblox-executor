/**
 * The developer Debugger model.
 *
 * Nova owns the workflow — the session, the state machine, breakpoints,
 * stepping, the selected frame, watches, timeouts and cancellation — while a
 * {@link DebuggerProvider} owns the execution model underneath. That split is
 * the point: the provider is a replaceable implementation boundary, and the one
 * provider shipped today is a local simulation that never leaves Nova.
 *
 * Deliberately absent from every type here: process ids, thread handles, memory
 * addresses, module lists and evaluated code. Nova does not attach to another
 * process, and nothing in this model describes one.
 */

/**
 * Where the debugger stands. One authoritative value, owned by the debugger
 * controller; see `debuggerState.ts` for the transitions between them.
 *
 * - `unavailable` — there is no target for a session to run against.
 * - `ready` — a session can be started.
 * - `running` — the session is executing and has not stopped.
 * - `paused` — execution is stopped at a line, with a stack to inspect.
 * - `stopped` — the session ended, by request or by running to completion.
 * - `error` — the last operation failed.
 */
export type DebugState = "unavailable" | "ready" | "running" | "paused" | "stopped" | "error";

/** Where a variable was found. */
export type DebugScope = "local" | "upvalue" | "global";

/** Why execution stopped where it did. */
export type DebugPauseReason = "entry" | "breakpoint" | "step" | "pause";

/** How a session ended. */
export type DebugStopReason = "completed" | "stopped" | "target-lost" | "failed";

/** What the user asked for when leaving a paused state. */
export type DebugResumeMode = "continue" | "step-over" | "step-into" | "step-out";

export type DebugErrorCode =
  /** There is no target for the debugger to work against. */
  | "DEBUGGER_UNAVAILABLE"
  /** The debugger is not in a state that allows the operation. */
  | "DEBUGGER_NOT_READY"
  /** Another debugger operation is already in flight. */
  | "DEBUGGER_BUSY"
  /** The operation was attempted and the provider reported a failure. */
  | "DEBUGGER_SESSION_FAILED"
  /** The provider did not answer within the operation timeout. */
  | "DEBUGGER_TIMEOUT"
  /** The operation was cancelled before it completed. */
  | "DEBUGGER_CANCELLED"
  /** The operation needs a session and there is none. */
  | "DEBUGGER_NO_SESSION"
  /** A breakpoint was requested that cannot exist, e.g. on line 0. */
  | "BREAKPOINT_INVALID"
  /** A watch expression could not be resolved. */
  | "WATCH_EVALUATION_FAILED"
  /** The target went away while a session was active. */
  | "TARGET_DISCONNECTED";

export interface DebugError {
  code: DebugErrorCode;
  /** Short sentence suitable for the UI. */
  message: string;
  /** Technical context, shown in the console and the panel. */
  details?: string;
}

/**
 * A breakpoint, as Nova keeps it. It is configuration, not session state: it
 * survives a session ending and is the only debugger data that is persisted.
 */
export interface Breakpoint {
  /** Stable identity. Never derived from the line, which moves. */
  readonly id: string;
  /** The Nova script document the breakpoint belongs to. */
  readonly scriptId: string;
  /** 1-based line within that script. */
  readonly line: number;
  readonly enabled: boolean;
  /**
   * A condition the user wrote. Stored and shown; the simulated provider does
   * not evaluate it, because evaluating one would mean running code.
   */
  readonly condition?: string;
  /** How often this breakpoint stopped execution in the current session. */
  readonly hitCount: number;
}

export interface StackFrame {
  /** Stable for the lifetime of one stop. */
  readonly id: string;
  readonly functionName: string;
  readonly scriptId: string;
  /** 1-based line within that script. */
  readonly line: number;
  readonly column?: number;
  /** 0 is the innermost frame, which is where execution stands. */
  readonly depth: number;
}

export interface Variable {
  readonly name: string;
  /** Already formatted for display; the provider decides how a value reads. */
  readonly value: string;
  readonly type: string;
  readonly scope: DebugScope;
}

/** The script a session runs. Read when the session starts, then frozen. */
export interface DebugTarget {
  readonly scriptId: string;
  readonly scriptName: string;
  /** Lines in the script when the session started. At least 1. */
  readonly lineCount: number;
}

/**
 * The shared developer selection, as the debugger sees it. It is the object
 * picked in the Explorer — the same selection the Property Inspector and the
 * status bar read — and never the text selected in the editor.
 */
export interface DebugContext {
  readonly objectId: string;
  readonly name: string;
  readonly className: string;
  /** The Explorer path, e.g. "Workspace / Camera". */
  readonly path: string;
}

export interface DebugSession {
  readonly id: string;
  readonly provider: string;
  readonly target: DebugTarget;
  readonly context: DebugContext | null;
  /** Epoch milliseconds. */
  readonly startedAt: number;
  /** Epoch milliseconds, set once the session ended. */
  readonly endedAt: number | null;
  readonly stopReason: DebugStopReason | null;
}

/** Where execution stands, as the provider reports it. */
export interface DebugStop {
  readonly line: number;
  readonly reason: DebugPauseReason;
  /** Innermost frame first. */
  readonly stack: readonly StackFrame[];
}

/** How a provider reports the end of a run or step. */
export type DebugRunOutcome =
  | { status: "paused"; stop: DebugStop }
  | { status: "completed" }
  | { status: "failed"; error: DebugError }
  | { status: "cancelled" };

/** The result of evaluating a watch expression: reading a name, never running code. */
export type WatchEvaluation =
  | { status: "ok"; value: string; type: string }
  | { status: "error"; error: DebugError };

export interface WatchEntry {
  readonly id: string;
  readonly expression: string;
  /** Null until it has been evaluated against a paused frame. */
  readonly value: string | null;
  readonly type: string | null;
  readonly error: { code: DebugErrorCode; message: string } | null;
}

export interface DebugStartRequest {
  readonly sessionId: string;
  readonly target: DebugTarget;
  readonly context: DebugContext | null;
  /** Epoch milliseconds. */
  readonly createdAt: number;
}

/**
 * The execution model, behind one interface. The controller owns state,
 * breakpoints, the selected frame, watches, timeouts, cancellation and
 * reporting; a provider only runs, stops and answers questions about the stop
 * it is currently at.
 *
 * Breakpoints are passed in on every run rather than registered, so the
 * controller stays the single source of truth for them.
 */
export interface DebuggerProvider {
  /** Display name, e.g. "Mock Debugger". */
  readonly label: string;
  /** Machine-readable family, e.g. "local-mock". */
  readonly providerType: string;
  /** True while the provider simulates execution rather than observing one. */
  readonly simulated: boolean;
  /** False when the provider cannot stop a run once it has started. */
  readonly supportsCancel: boolean;
  /** One sentence the UI shows wherever the data is presented. */
  readonly description: string;
  /** Begins a session and runs to its first stop. */
  start: (
    request: DebugStartRequest,
    breakpoints: readonly Breakpoint[],
    options: { signal: AbortSignal },
  ) => Promise<DebugRunOutcome>;
  /** Leaves a stop the way `mode` asks for, and runs to the next one. */
  resume: (
    sessionId: string,
    mode: DebugResumeMode,
    breakpoints: readonly Breakpoint[],
    options: { signal: AbortSignal },
  ) => Promise<DebugRunOutcome>;
  /** Asks for the run in progress to stop at the next execution point. */
  requestPause: (sessionId: string) => void;
  /** Ends the session. Safe to call when there is none. */
  stop: (sessionId: string) => Promise<void>;
  /** The variables visible in one frame of the current stop. */
  getVariables: (sessionId: string, frameId: string) => readonly Variable[];
  /** Resolves a name against one frame of the current stop. Never executes code. */
  evaluate: (sessionId: string, frameId: string, expression: string) => WatchEvaluation;
}

/** What the UI may know about the provider without reaching for the implementation. */
export interface DebuggerProviderInfo {
  readonly label: string;
  readonly providerType: string;
  readonly simulated: boolean;
  readonly supportsCancel: boolean;
  readonly description: string;
}

export interface DebuggerSnapshot {
  readonly state: DebugState;
  /** The session in progress, or the last one to end; null before the first. */
  readonly session: DebugSession | null;
  /** Innermost frame first. Empty unless paused. */
  readonly stack: readonly StackFrame[];
  /** The frame the inspector is showing, always one of `stack` while paused. */
  readonly currentFrameId: string | null;
  /** Variables of `currentFrameId`. */
  readonly locals: readonly Variable[];
  /** Every breakpoint Nova holds, for every script. */
  readonly breakpoints: readonly Breakpoint[];
  readonly watches: readonly WatchEntry[];
  /** Why execution stopped where it did; null unless paused. */
  readonly pauseReason: DebugPauseReason | null;
  /** An operation is in flight. */
  readonly busy: boolean;
  /** A pause was asked for and the provider has not stopped yet. */
  readonly pausePending: boolean;
  /** The latest failure, set while `state` is "error". */
  readonly error: DebugError | null;
}
