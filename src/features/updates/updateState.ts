import type { UpdateError, UpdateErrorCode, UpdateStatus } from "@/features/updates/types";

/**
 * The update state machine. Every launch starts at `idle`: no update state is
 * persisted, so a build that was told about a release yesterday asks again
 * today rather than trusting what it remembers.
 *
 * ```text
 * idle → checking → up-to-date → checking
 *                 → available → downloading → installing → ready
 *                 → error
 * ```
 *
 * `ready` is terminal on purpose. Once an update is installed the running
 * process is the old build, and the only honest thing left to offer is the
 * restart — checking again from there would ask the source about a build that
 * is already on disk.
 */
const TRANSITIONS: Record<UpdateStatus, readonly UpdateStatus[]> = {
  idle: ["checking"],
  checking: ["up-to-date", "available", "error"],
  "up-to-date": ["checking"],
  // "Later" puts an offered release back to `idle`; the release itself is kept,
  // so the prompt can be reopened without asking the source again.
  available: ["downloading", "idle", "checking"],
  downloading: ["installing", "error"],
  installing: ["ready", "error"],
  ready: [],
  // A failure can be retried from where it happened: a failed check checks
  // again, and a failed download goes back to the release it was offered.
  error: ["checking", "available", "idle"],
};

export const UPDATE_STATUSES = Object.keys(TRANSITIONS) as UpdateStatus[];

/** Statuses in which a check may be started. */
export const CHECKABLE_STATUSES: readonly UpdateStatus[] = ["idle", "up-to-date", "available", "error"];

export function canTransitionUpdate(from: UpdateStatus, to: UpdateStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidUpdateTransitionError extends Error {
  readonly from: UpdateStatus;
  readonly to: UpdateStatus;

  constructor(from: UpdateStatus, to: UpdateStatus) {
    super(`Invalid update transition: ${from} → ${to}`);
    this.name = "InvalidUpdateTransitionError";
    this.from = from;
    this.to = to;
  }
}

/** Returns `to`, or throws when the state machine does not allow the transition. */
export function transitionUpdate(from: UpdateStatus, to: UpdateStatus): UpdateStatus {
  if (!canTransitionUpdate(from, to)) throw new InvalidUpdateTransitionError(from, to);
  return to;
}

/** True while the updater is doing something the user should not be asked to repeat. */
export function isUpdateBusy(status: UpdateStatus): boolean {
  return status === "checking" || status === "downloading" || status === "installing";
}

/** True while an update is being fetched or installed and must not be interrupted. */
export function isUpdateInstalling(status: UpdateStatus): boolean {
  return status === "downloading" || status === "installing";
}

/**
 * Errors Nova asked for and can do nothing about. A check Nova started by
 * itself stays silent for these: a laptop that is offline has not encountered
 * a problem, and saying so on every launch would be noise.
 */
const SILENT_CODES: readonly UpdateErrorCode[] = ["NETWORK_UNAVAILABLE", "UPDATER_UNAVAILABLE"];

/** True when a failed background check should be reported to the user. */
export function shouldReportFailure(error: UpdateError, manual: boolean): boolean {
  return manual || !SILENT_CODES.includes(error.code);
}

/**
 * What a failing updater actually failed at.
 *
 * Tauri's updater reports failures as messages rather than as codes, so this is
 * where those messages become something Nova can act on — and it is
 * deliberately conservative: anything it does not recognise is `CHECK_FAILED`,
 * which the UI presents as a retryable failure with the original text attached.
 * Guessing "signature invalid" from an unfamiliar message would be worse than
 * admitting the updater said something unexpected.
 */
export function classifyUpdateError(error: unknown): UpdateError {
  const details = errorText(error);
  const text = details.toLowerCase();

  const code = matchCode(text);
  return { code, message: MESSAGES[code], details };
}

/**
 * The words are matched on word boundaries wherever a short one could hide
 * inside a longer, unrelated one: "nobody" contains "body", and reading an
 * unfamiliar failure as a download problem would hide what actually happened.
 */
function matchCode(text: string): UpdateErrorCode {
  // Signature first: a tampered artifact must never be reported as a plain
  // download problem, and its message can also mention the download.
  if (/signature|minisign|verif|untrusted|public key|pubkey/.test(text)) return "SIGNATURE_INVALID";
  if (/network|connect|\bdns\b|offline|unreachable|timed? ?out|timeout|sending request|resolv|resolut|lookup address/.test(text)) {
    return "NETWORK_UNAVAILABLE";
  }
  if (/json|parse|decod|deserial|invalid (release|manifest|response)|unexpected (character|token|end)|missing field/.test(text)) {
    return "RELEASE_MALFORMED";
  }
  if (/download|incomplete|content length|\bbody\b/.test(text)) return "DOWNLOAD_FAILED";
  if (/install|\bnsis\b|\bmsi\b|exit code|elevat|permission denied|access is denied/.test(text)) return "INSTALL_FAILED";
  return "CHECK_FAILED";
}

const MESSAGES: Record<UpdateErrorCode, string> = {
  UPDATER_UNAVAILABLE: "This build cannot update itself.",
  NETWORK_UNAVAILABLE: "Nova could not reach its release source.",
  RELEASE_MALFORMED: "The release information could not be read.",
  SIGNATURE_INVALID: "The update's signature did not verify and it was not installed.",
  DOWNLOAD_FAILED: "The update could not be downloaded.",
  INSTALL_FAILED: "The update could not be installed.",
  CHECK_FAILED: "The update check did not finish.",
};

/** The message an error carries, without letting a non-Error become "[object Object]". */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

export function updateError(code: UpdateErrorCode, details?: string): UpdateError {
  return details === undefined ? { code, message: MESSAGES[code] } : { code, message: MESSAGES[code], details };
}
