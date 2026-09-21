import type { BackendError, BackendErrorCode } from "@/features/backend/types";
import type { DebugError, DebugErrorCode } from "@/features/debugger/types";
import type { ExecutionError, ExecutionErrorCode } from "@/features/execution/types";
import type { ProfilerError, ProfilerErrorCode } from "@/features/profiler/types";
import type { TargetError, TargetErrorCode } from "@/features/target/types";

/**
 * How a structured error is presented to a developer.
 *
 * The controllers already produce a code, a sentence and optional technical
 * details; this module only decides how to say it and which of Nova's existing
 * actions is worth offering next. It changes no state and reads none, so
 * nothing here can claim a target is in a state it is not.
 */

/** Actions the shell already has. Nothing is listed here that does not exist. */
export type ErrorActionId = "detect-target" | "inject" | "disconnect-target" | "open-settings" | "new-script";

export interface ErrorAction {
  readonly id: ErrorActionId;
  readonly label: string;
}

export interface ErrorPresentation {
  /** Short heading, e.g. "Target Not Ready". */
  readonly title: string;
  /** One or two sentences explaining what happened, in plain words. */
  readonly explanation: string;
  /** The controller's own code, shown as-is so it can be searched for. */
  readonly code: string;
  /** The next step, when one of Nova's actions genuinely applies. */
  readonly action: ErrorAction | null;
  /** Technical context from the error, when it carries any. */
  readonly details: string | null;
  /** The sentence the controller itself reported, when it says more than the explanation. */
  readonly reported: string | null;
}

const DETECT: ErrorAction = { id: "detect-target", label: "Detect Target" };
const INJECT: ErrorAction = { id: "inject", label: "Inject" };
const DISCONNECT: ErrorAction = { id: "disconnect-target", label: "Disconnect" };
const SETTINGS: ErrorAction = { id: "open-settings", label: "Open Settings" };
const NEW_SCRIPT: ErrorAction = { id: "new-script", label: "New Script" };

interface Template {
  readonly title: string;
  readonly explanation: string;
  readonly action: ErrorAction | null;
}

const TARGET_TEMPLATES: Record<TargetErrorCode, Template> = {
  TARGET_UNAVAILABLE: {
    title: "No Target Found",
    explanation: "Nova cannot see a target to act on. Run a detection pass to look again.",
    action: DETECT,
  },
  TARGET_NOT_READY: {
    title: "Target Not Ready",
    explanation:
      "Nova cannot perform this operation because the current target is not ready. Detect it again, then inject.",
    action: DETECT,
  },
  ALREADY_INJECTED: {
    title: "Already Injected",
    explanation: "The target is already attached, so a second injection was refused. Disconnect first to start over.",
    action: DISCONNECT,
  },
  INJECTION_FAILED: {
    title: "Injection Failed",
    explanation: "The provider attempted the operation and reported that it did not succeed.",
    action: INJECT,
  },
  INJECTION_TIMEOUT: {
    title: "Injection Timed Out",
    explanation:
      "The provider did not finish within the configured inject timeout, so the request was abandoned. The timeout can be raised in Settings › Target.",
    action: SETTINGS,
  },
  INJECTION_CANCELLED: {
    title: "Injection Cancelled",
    explanation: "The request was cancelled before it completed. Nothing was attached.",
    action: INJECT,
  },
  TARGET_DISCONNECTED: {
    title: "Target Lost",
    explanation: "The target went away while Nova was working with it. Detect it again before retrying.",
    action: DETECT,
  },
  PROVIDER_UNAVAILABLE: {
    title: "Provider Unavailable",
    explanation: "No target provider is configured, or the configured one refused to start.",
    action: null,
  },
  PROVIDER_MISCONFIGURED: {
    title: "Provider Misconfigured",
    explanation: "The target provider is configured in a way it cannot work with.",
    action: null,
  },
};

const EXECUTION_TEMPLATES: Record<ExecutionErrorCode, Template> = {
  NO_ACTIVE_SCRIPT: {
    title: "No Script Open",
    explanation: "There is no script to execute. Open one from the sidebar, or create a new one.",
    action: NEW_SCRIPT,
  },
  EMPTY_SELECTION: {
    title: "Nothing Selected",
    explanation: "Execute Selected needs text selected in the editor. Select something, or execute the full script.",
    action: null,
  },
  EXECUTION_ALREADY_RUNNING: {
    title: "Execution In Progress",
    explanation: "One execution runs at a time. Wait for the current one to finish, or cancel it.",
    action: null,
  },
  INVALID_REQUEST: {
    title: "Request Not Understood",
    explanation: "The request was malformed, so nothing was submitted to the provider.",
    action: null,
  },
  TARGET_NOT_READY: {
    title: "Target Not Ready",
    explanation: "Nova cannot perform this operation because the current target is not ready.",
    action: DETECT,
  },
  EMPTY_SOURCE: {
    title: "Nothing To Run",
    explanation: "The script has no source text to execute.",
    action: null,
  },
  EXECUTION_TIMEOUT: {
    title: "Execution Timed Out",
    explanation:
      "The execution did not finish within the configured timeout and was stopped. The timeout can be raised in Settings › Executor.",
    action: SETTINGS,
  },
  TARGET_DISCONNECTED: {
    title: "Target Lost",
    explanation: "The target was lost while the script was running, so the execution was ended.",
    action: DETECT,
  },
  PROVIDER_ERROR: {
    title: "Execution Failed",
    explanation: "The provider reported an error while running the script.",
    action: null,
  },
};

const DEBUG_TEMPLATES: Record<DebugErrorCode, Template> = {
  DEBUGGER_UNAVAILABLE: {
    title: "No Target To Debug",
    explanation: "The debugger needs a target to work against. Run a detection pass to look for one.",
    action: DETECT,
  },
  DEBUGGER_NOT_READY: {
    title: "Debugger Not Ready",
    explanation: "The debugger is not in a state that allows this. Stop the current session, then start a new one.",
    action: null,
  },
  DEBUGGER_BUSY: {
    title: "Debugger Busy",
    explanation: "One debug operation runs at a time. Wait for the current one to finish.",
    action: null,
  },
  DEBUGGER_SESSION_FAILED: {
    title: "Debug Session Failed",
    explanation: "The provider attempted the operation and reported that it did not succeed.",
    action: null,
  },
  DEBUGGER_TIMEOUT: {
    title: "Debugger Timed Out",
    explanation: "The provider did not answer in time, so the operation was abandoned and the session was ended.",
    action: null,
  },
  DEBUGGER_CANCELLED: {
    title: "Debug Operation Cancelled",
    explanation: "The operation was cancelled before it completed.",
    action: null,
  },
  DEBUGGER_NO_SESSION: {
    title: "No Debug Session",
    explanation: "There is no session to act on. Start one from the Debugger panel.",
    action: null,
  },
  BREAKPOINT_INVALID: {
    title: "Breakpoint Not Set",
    explanation: "A breakpoint needs a script and a line of 1 or more.",
    action: null,
  },
  WATCH_EVALUATION_FAILED: {
    title: "Watch Not Evaluated",
    explanation:
      "The watch could not be read. Watches read a variable the paused frame already holds; they never run code.",
    action: null,
  },
  TARGET_DISCONNECTED: {
    title: "Target Lost",
    explanation: "The target went away while the session was running, so the session was stopped.",
    action: DETECT,
  },
};

const PROFILER_TEMPLATES: Record<ProfilerErrorCode, Template> = {
  PROFILER_UNAVAILABLE: {
    title: "No Target To Record",
    explanation: "The profiler needs a target to record against. Run a detection pass to look for one.",
    action: DETECT,
  },
  PROFILER_NOT_READY: {
    title: "Profiler Not Ready",
    explanation: "A recording is already running. Stop it before starting another one.",
    action: null,
  },
  PROFILER_BUSY: {
    title: "Profiler Busy",
    explanation: "One profiler operation runs at a time. Wait for the current one to finish.",
    action: null,
  },
  PROFILER_SESSION_FAILED: {
    title: "Recording Failed",
    explanation: "The provider attempted the operation and reported that it did not succeed.",
    action: null,
  },
  PROFILER_TIMEOUT: {
    title: "Profiler Timed Out",
    explanation: "The provider did not answer in time, so the recording was abandoned.",
    action: null,
  },
  PROFILER_CANCELLED: {
    title: "Recording Cancelled",
    explanation: "The recording was cancelled before it produced anything.",
    action: null,
  },
  PROFILER_NO_SESSION: {
    title: "No Recording",
    explanation: "There is no recording to act on. Start one from the Profiler panel.",
    action: null,
  },
  TARGET_DISCONNECTED: {
    title: "Target Lost",
    explanation: "The target went away while the profiler was recording, so the recording was stopped.",
    action: DETECT,
  },
};

/**
 * The developer backend: the adapter layer the tool providers come from. These
 * are the only errors in Nova that are about the *provider set* rather than
 * about a target, a script or a session, which is why they read differently —
 * none of them is something the user did.
 */
const BACKEND_TEMPLATES: Record<BackendErrorCode, Template> = {
  PROVIDER_UNAVAILABLE: {
    title: "Provider Unavailable",
    explanation: "The active developer backend supplies no provider for this tool, so the tool cannot be used.",
    action: null,
  },
  PROVIDER_START_FAILED: {
    title: "Backend Failed To Start",
    explanation:
      "The developer backend was asked to start and reported that it could not. Its providers stay unavailable until it starts.",
    action: null,
  },
  PROVIDER_STOP_FAILED: {
    title: "Backend Failed To Stop",
    explanation:
      "The developer backend reported an error while stopping. It is treated as unusable either way, so nothing claims to still be attached.",
    action: null,
  },
  PROVIDER_TIMEOUT: {
    title: "Backend Timed Out",
    explanation:
      "The developer backend did not answer in time, so the request was abandoned and a late answer is ignored.",
    action: null,
  },
  PROVIDER_CAPABILITY_UNSUPPORTED: {
    title: "Not Supported Here",
    explanation:
      "The active developer backend does not support this operation. It is refused rather than reported as having worked.",
    action: null,
  },
  PROVIDER_DISCONNECTED: {
    title: "Backend Disconnected",
    explanation: "The developer backend stopped while something depended on it, so that work was ended.",
    action: null,
  },
  PROVIDER_INVALID_STATE: {
    title: "Backend Busy",
    explanation: "The developer backend is in the middle of a lifecycle operation. Wait for it to finish.",
    action: null,
  },
  PROVIDER_TRANSPORT_UNAVAILABLE: {
    title: "No Local Channel",
    explanation:
      "This backend talks to a service in Nova's own process, and that channel does not exist in this window. It is only there in the desktop application.",
    action: null,
  },
  PROVIDER_AUTH_FAILED: {
    title: "Session Refused",
    explanation:
      "The backend would not accept the session Nova presented, so nothing was done with it. Starting the backend again issues a new one.",
    action: null,
  },
  PROVIDER_SESSION_STALE: {
    title: "Session Ended",
    explanation:
      "The session this backend was using has ended, so anything still holding it was refused rather than answered. A backend that is still running opens a new one at its next health check; one that stopped needs Developer: Restart Backend.",
    action: null,
  },
  PROVIDER_PROTOCOL_MISMATCH: {
    title: "Protocol Mismatch",
    explanation:
      "Nova and its backend do not agree on the protocol between them, so nothing either side said could be trusted. This is a build mismatch, not something you did.",
    action: null,
  },
};

/** Every code this module presents. Exported so nothing can be added without a presentation. */
export const PRESENTED_TARGET_CODES = Object.keys(TARGET_TEMPLATES) as readonly TargetErrorCode[];
export const PRESENTED_EXECUTION_CODES = Object.keys(EXECUTION_TEMPLATES) as readonly ExecutionErrorCode[];
export const PRESENTED_DEBUG_CODES = Object.keys(DEBUG_TEMPLATES) as readonly DebugErrorCode[];
export const PRESENTED_PROFILER_CODES = Object.keys(PROFILER_TEMPLATES) as readonly ProfilerErrorCode[];
export const PRESENTED_BACKEND_CODES = Object.keys(BACKEND_TEMPLATES) as readonly BackendErrorCode[];

function present(template: Template, code: string, message: string, details: string | undefined): ErrorPresentation {
  const reported = message.trim();
  return {
    title: template.title,
    explanation: template.explanation,
    code,
    action: template.action,
    details: details === undefined || details.trim() === "" ? null : details.trim(),
    // The controller's own sentence is kept only when it adds something.
    reported: reported === "" || reported === template.explanation ? null : reported,
  };
}

export function describeTargetError(error: TargetError): ErrorPresentation {
  return present(TARGET_TEMPLATES[error.code], error.code, error.message, error.details);
}

export function describeExecutionError(error: ExecutionError): ErrorPresentation {
  return present(EXECUTION_TEMPLATES[error.code], error.code, error.message, error.details);
}

export function describeDebugError(error: DebugError): ErrorPresentation {
  return present(DEBUG_TEMPLATES[error.code], error.code, error.message, error.details);
}

export function describeProfilerError(error: ProfilerError): ErrorPresentation {
  return present(PROFILER_TEMPLATES[error.code], error.code, error.message, error.details);
}

export function describeBackendError(error: BackendError): ErrorPresentation {
  return present(BACKEND_TEMPLATES[error.code], error.code, error.message, error.details);
}
