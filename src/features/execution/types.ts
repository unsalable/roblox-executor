export type ExecutionMode = "full-script" | "selection";

export const EXECUTION_MODES: readonly ExecutionMode[] = ["full-script", "selection"];

export const executionModeLabel: Record<ExecutionMode, string> = {
  "full-script": "Full script",
  selection: "Selection",
};

export type ExecutionPhase = "idle" | "preparing" | "running" | "success" | "error" | "cancelled";

/** Phases in which an execution has ended; each one is followed only by a new request. */
export type TerminalExecutionPhase = Extract<ExecutionPhase, "success" | "error" | "cancelled">;

export type ExecutionErrorCode =
  /** Validation: there is no script to execute. */
  | "NO_ACTIVE_SCRIPT"
  /** Validation: selection mode with no non-whitespace text selected. */
  | "EMPTY_SELECTION"
  /** Validation: another execution is preparing or running. */
  | "EXECUTION_ALREADY_RUNNING"
  /** Validation: the request is malformed. */
  | "INVALID_REQUEST"
  /** Validation: the provider needs an injected target and there is none. */
  | "TARGET_NOT_READY"
  /** Provider: there is no source text to execute. */
  | "EMPTY_SOURCE"
  /** The execution did not finish within the configured timeout. */
  | "EXECUTION_TIMEOUT"
  /** The target was lost while the execution was in flight. */
  | "TARGET_DISCONNECTED"
  /** The provider failed or reported an error. */
  | "PROVIDER_ERROR";

export interface ExecutionError {
  code: ExecutionErrorCode;
  /** Short sentence suitable for the UI. */
  message: string;
  /** Technical context, shown in the console. */
  details?: string;
  /** Only when a provider reports a real one; never synthesized. */
  stack?: string;
}

/** What the UI submits: the script and the text to run, read at the moment Execute was chosen. */
export interface ExecutionInput {
  mode: ExecutionMode;
  script: { id: string; name: string } | null;
  /** The full script text, or the selected text in selection mode. */
  source: string | null;
}

/** An accepted request. Frozen when created, so later edits in the editor never reach it. */
export interface ExecutionRequest {
  readonly executionId: string;
  readonly scriptId: string;
  readonly scriptName: string;
  readonly source: string;
  readonly mode: ExecutionMode;
  /** Epoch milliseconds. */
  readonly createdAt: number;
}

/** Everything known about an execution apart from its source. */
export interface ExecutionContext {
  readonly executionId: string;
  /** Display name of the provider that runs it. */
  readonly provider: string;
  readonly mode: ExecutionMode;
  readonly scriptId: string;
  readonly scriptName: string;
  /** Epoch milliseconds. */
  readonly startedAt: number;
  readonly timeoutMs: number;
}

export interface ExecutionResult {
  readonly executionId: string;
  readonly success: boolean;
  readonly cancelled: boolean;
  readonly durationMs: number;
  /** Lines reported by the provider. */
  readonly output: readonly string[];
  /** Set exactly when the execution failed (including timeouts). */
  readonly error: ExecutionError | null;
}

/** How a provider reports the end of an execution. */
export type ExecutionOutcome =
  | { status: "success"; output: readonly string[] }
  | { status: "error"; error: ExecutionError; output?: readonly string[] }
  | { status: "cancelled" };

export interface ExecutionProviderHooks {
  /** Tells the controller that preparation is done and the script is now running. */
  onRunning: () => void;
}

/**
 * Where scripts are actually executed. The controller owns validation,
 * timeouts, state, history and logging; a provider only runs one request at a
 * time and reports how it ended.
 */
export interface ExecutionProvider {
  /** Display name, e.g. "Local Test Target". */
  readonly label: string;
  /** Machine-readable family, e.g. "local-test". */
  readonly providerType?: string;
  /** When true, the controller refuses requests until the target reports it is injected. */
  readonly requiresTarget: boolean;
  /** Settles once the execution has ended; rejecting is reported as a provider error. */
  execute: (request: ExecutionRequest, hooks: ExecutionProviderHooks) => Promise<ExecutionOutcome>;
  /** Asks the provider to stop; the pending `execute` promise then settles, normally as "cancelled". */
  cancel?: (executionId: string) => Promise<void> | void;
}

/** A finished execution as kept in the session history. Never contains source text. */
export interface ExecutionHistoryEntry {
  readonly executionId: string;
  readonly scriptId: string;
  readonly scriptName: string;
  readonly mode: ExecutionMode;
  readonly provider: string;
  readonly status: TerminalExecutionPhase;
  readonly durationMs: number;
  /** Epoch milliseconds. */
  readonly startedAt: number;
  readonly error: { code: ExecutionErrorCode; message: string } | null;
}

export interface ExecutionSnapshot {
  readonly phase: ExecutionPhase;
  /** The execution in progress, or the last one to finish; null before the first. */
  readonly context: ExecutionContext | null;
  /** Result of `context`, set exactly when `phase` is terminal. */
  readonly result: ExecutionResult | null;
  /** Cancellation was requested and the provider has not stopped yet. */
  readonly cancelling: boolean;
  /** The latest request refused by validation since the last execution started or ended. */
  readonly rejection: ExecutionError | null;
  /** Newest first. */
  readonly history: readonly ExecutionHistoryEntry[];
}
