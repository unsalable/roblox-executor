/**
 * The update model.
 *
 * Nova updates itself from one fixed source — its own GitHub releases — through
 * Tauri's updater, and the rules that source imposes are the model's:
 *
 * - **The endpoint is not a setting.** It is compiled into the application
 *   (`src-tauri/tauri.conf.json`), so nothing in the UI, in the settings or in
 *   stored data can point Nova at another server.
 * - **Nothing unsigned is ever run.** The updater verifies every artifact
 *   against the public key built into the application before it is written
 *   anywhere, and a signature that does not verify is a failure, not a prompt.
 * - **Being offline is not an error the user has to see.** A check that cannot
 *   reach the source is reported here and swallowed by the caller when the
 *   check was Nova's own idea rather than the user's.
 *
 * Nova downloads exactly one kind of file — the installer for the release the
 * source names — and never executes anything outside that flow.
 */

/**
 * Where the update flow stands. One authoritative value, owned by the update
 * controller; see `updateState.ts` for the transitions between them.
 *
 * - `idle` — nothing has been checked, or the last answer was dismissed.
 * - `checking` — a check is in flight.
 * - `up-to-date` — the source answered, and this build is the newest one.
 * - `available` — a newer release exists and has not been started.
 * - `downloading` — the installer is being fetched and verified.
 * - `installing` — the installer is running.
 * - `ready` — the update is installed; only the restart is left.
 * - `error` — the last check, download or install failed.
 */
export type UpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "installing"
  | "ready"
  | "error";

export type UpdateErrorCode =
  /** This build has no updater: a development build, or the frontend in a browser. */
  | "UPDATER_UNAVAILABLE"
  /** The release source could not be reached. Being offline lands here. */
  | "NETWORK_UNAVAILABLE"
  /** The source answered, but the release metadata could not be read. */
  | "RELEASE_MALFORMED"
  /** The artifact's signature did not verify against the built-in public key. */
  | "SIGNATURE_INVALID"
  /** The artifact could not be downloaded in full. */
  | "DOWNLOAD_FAILED"
  /** The installer refused, failed, or was dismissed by the operating system. */
  | "INSTALL_FAILED"
  /** The updater failed in a way it did not explain. */
  | "CHECK_FAILED";

export interface UpdateError {
  readonly code: UpdateErrorCode;
  /** Short sentence suitable for the UI. */
  readonly message: string;
  /** Technical context, shown in the console and diagnostics. */
  readonly details?: string;
}

/** A release the source is offering, as Nova is willing to describe it. */
export interface UpdateRelease {
  /** The offered version, e.g. `2026.921.1350`. */
  readonly version: string;
  /** The version this build reports for itself. */
  readonly currentVersion: string;
  /** The release notes, when the release carries any. */
  readonly notes: string | null;
  /** When the release was published, as the source stated it. */
  readonly publishedAt: string | null;
}

export interface UpdateProgress {
  /**
   * Which half of the work is happening. The provider says so rather than
   * leaving it to be inferred from the byte counts: a source that declares no
   * content length would otherwise leave Nova unable to tell a download that is
   * still running from one that has finished.
   */
  readonly phase: "downloading" | "installing";
  readonly downloadedBytes: number;
  /** The full size, when the source declared one. */
  readonly totalBytes: number | null;
}

/**
 * An offered release, ready to be installed. Holding one does not start
 * anything: {@link UpdateInstall.run} is the only thing that downloads, and it
 * is only ever called because the user pressed Update.
 */
export interface UpdateInstall {
  /** Downloads, verifies and installs. Rejects with whatever the updater reported. */
  readonly run: (onProgress: (progress: UpdateProgress) => void) => Promise<void>;
  /** Releases the updater's handle on the release. Safe to call more than once. */
  readonly close: () => Promise<void>;
}

export type UpdateCheck =
  | { readonly status: "up-to-date" }
  | { readonly status: "available"; readonly release: UpdateRelease; readonly install: UpdateInstall };

/**
 * The updater, behind one interface. The controller owns the state machine,
 * the prompt, what reaches the console and every decision about when to ask;
 * a provider checks, installs and restarts.
 *
 * The boundary exists for the same reason the target's does: so the whole flow
 * — including a signature that does not verify and a source that cannot be
 * reached — is exercised by unit tests without a network, a release or a
 * packaged build.
 */
export interface UpdateProvider {
  /** Display name, e.g. "GitHub Releases". */
  readonly label: string;
  /** The fixed source, as the UI states it. Never a value the user can change. */
  readonly source: string;
  /** False when this build cannot update itself; `check` then fails with `UPDATER_UNAVAILABLE`. */
  readonly available: boolean;
  /** Asks the source once. */
  readonly check: () => Promise<UpdateCheck>;
  /** Restarts into the installed update. */
  readonly relaunch: () => Promise<void>;
}

export interface UpdateSnapshot {
  readonly status: UpdateStatus;
  /** The offered release, while there is one. */
  readonly release: UpdateRelease | null;
  /** Set while `status` is "downloading". */
  readonly progress: UpdateProgress | null;
  /** The latest failure, set while `status` is "error". */
  readonly error: UpdateError | null;
  /** Epoch milliseconds of the last completed check; null before the first. */
  readonly lastCheckedAt: number | null;
  /** The update prompt is showing. */
  readonly promptOpen: boolean;
  /** The check in flight, or the last one, was asked for by the user. */
  readonly manual: boolean;
}
