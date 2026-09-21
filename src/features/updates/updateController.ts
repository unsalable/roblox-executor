import {
  CHECKABLE_STATUSES,
  classifyUpdateError,
  shouldReportFailure,
  transitionUpdate,
  updateError,
} from "@/features/updates/updateState";
import type {
  UpdateError,
  UpdateInstall,
  UpdateProgress,
  UpdateProvider,
  UpdateSnapshot,
  UpdateStatus,
} from "@/features/updates/types";
import { systemClock, type Clock, type TimerId } from "@/lib/clock";
import { logger } from "@/lib/logger";

export type UpdateLog = Pick<typeof logger, "debug" | "info" | "warn" | "error">;

/**
 * How long after launch the startup check waits. Long enough that the window,
 * the editor and the backend all have the main thread to themselves first;
 * short enough that a user who is about to be offered an update finds out
 * before they start working.
 */
export const STARTUP_CHECK_DELAY_MS = 4000;

/** The Settings › Updates behaviours, read when they are needed so changes apply at once. */
export interface UpdatePolicy {
  checkOnStartup: boolean;
}

const DEFAULT_POLICY: UpdatePolicy = { checkOnStartup: true };

export interface UpdateControllerOptions {
  provider: UpdateProvider;
  /** Read on every decision, so Settings changes need no restart. */
  policy?: () => UpdatePolicy;
  clock?: Clock;
  startupDelayMs?: number;
  log?: UpdateLog;
}

/** What the UI may know about the updater without reaching for the implementation. */
export interface UpdateProviderInfo {
  readonly label: string;
  readonly source: string;
  readonly available: boolean;
}

export interface UpdateController {
  readonly provider: UpdateProviderInfo;
  getSnapshot: () => UpdateSnapshot;
  subscribe: (listener: () => void) => () => void;
  /**
   * Asks the release source once. `manual` is what the user pressed rather than
   * what Nova decided, and it is the only thing that makes a negative answer
   * — "no update", "you are offline" — visible.
   */
  check: (options?: { manual?: boolean }) => Promise<void>;
  /** Downloads, verifies and installs the offered release. */
  install: () => Promise<void>;
  /** Restarts into the installed update. */
  restart: () => Promise<void>;
  /** "Later": closes the prompt and keeps what was found. */
  dismiss: () => void;
  /** Reopens the prompt on what is already known, without asking the source. */
  open: () => void;
  /** The startup check, after its delay. Only the first call has any effect. */
  start: () => void;
  /** Stops timers, abandons a check in flight and releases the offered release. */
  dispose: () => void;
}

const idle: UpdateSnapshot = {
  status: "idle",
  release: null,
  progress: null,
  error: null,
  lastCheckedAt: null,
  promptOpen: false,
  manual: false,
};

/**
 * The update pipeline, and the single source of truth for update state.
 *
 * It owns the state machine, the prompt, the startup delay, what reaches the
 * console and every decision about when the user should be interrupted; a
 * provider checks, installs and restarts. Nothing here knows the release
 * source's address — that is compiled into the application — so no path
 * through this file can be made to fetch from somewhere else.
 *
 * Nothing is persisted: a launch always starts at `idle` and asks again, so a
 * remembered "up to date" can never keep Nova on an old build.
 */
export function createUpdateController(options: UpdateControllerOptions): UpdateController {
  const { provider } = options;
  const clock = options.clock ?? systemClock;
  const log = options.log ?? logger;
  const policy = options.policy ?? (() => DEFAULT_POLICY);
  const startupDelayMs = options.startupDelayMs ?? STARTUP_CHECK_DELAY_MS;

  const listeners = new Set<() => void>();
  let snapshot: UpdateSnapshot = idle;

  /** The release the source offered, held only so Update has something to run. */
  let offered: UpdateInstall | null = null;
  /** Bumped by every check, so a late answer from an abandoned one is ignored. */
  let checkPass = 0;
  let startupTimer: TimerId | null = null;
  let startHandled = false;
  let disposed = false;

  const setSnapshot = (patch: Partial<UpdateSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of [...listeners]) listener();
  };

  const moveTo = (status: UpdateStatus, patch: Partial<Omit<UpdateSnapshot, "status">> = {}) =>
    setSnapshot({ ...patch, status: transitionUpdate(snapshot.status, status) });

  /**
   * The status as it is right now. `snapshot` is reassigned from inside
   * `setSnapshot`, which the type checker cannot see through, so reading it
   * through a call is what keeps a check after a transition honest instead of
   * being narrowed away to the value it had before.
   */
  const statusNow = (): UpdateStatus => snapshot.status;

  /** Releases the updater's handle on an offered release. Never throws. */
  const release = () => {
    const held = offered;
    offered = null;
    if (held) void held.close().catch((error: unknown) => log.debug("Releasing the update failed", error));
  };

  /** Records a failure Nova has already identified, without re-reading its text. */
  const failWith = (failure: UpdateError, manual: boolean) => {
    const report = shouldReportFailure(failure, manual);

    // An offline laptop has not encountered a problem worth a warning in the
    // console every launch; a failure the user asked for always is one.
    if (report) log.warn(`Update: ${failure.message}`, failure.details);
    else log.debug(`Update: ${failure.message}`, failure.details);

    moveTo("error", { error: failure, progress: null, promptOpen: report, lastCheckedAt: clock.now() });
  };

  /** Records a failure the updater threw, identifying it first. */
  const fail = (error: unknown, manual: boolean) => failWith(classifyUpdateError(error), manual);

  const check: UpdateController["check"] = async ({ manual = false } = {}) => {
    if (disposed) return;
    if (!CHECKABLE_STATUSES.includes(snapshot.status)) {
      log.debug("Update: a check is already in flight or an update is installing");
      return;
    }

    // A new check replaces whatever the last one offered: keeping the old
    // release would let Update install something the source no longer names.
    release();
    const pass = (checkPass += 1);
    moveTo("checking", { manual, error: null, progress: null, release: null, promptOpen: snapshot.promptOpen && manual });

    if (!provider.available) {
      if (pass === checkPass && !disposed) failWith(updateError("UPDATER_UNAVAILABLE", provider.source), manual);
      return;
    }

    log.debug(`Update: asking ${provider.source}`);

    try {
      const result = await provider.check();
      // Disposed, or another check started while this one was in flight.
      if (pass !== checkPass || disposed) {
        if (result.status === "available") void result.install.close().catch(() => undefined);
        return;
      }

      if (result.status === "up-to-date") {
        log.info("Update: this is the newest build");
        moveTo("up-to-date", { lastCheckedAt: clock.now(), promptOpen: manual });
        return;
      }

      offered = result.install;
      log.info(`Update: ${result.release.version} is available (running ${result.release.currentVersion})`);
      moveTo("available", { release: result.release, lastCheckedAt: clock.now(), promptOpen: true });
    } catch (error) {
      if (pass !== checkPass || disposed) return;
      fail(error, manual);
    }
  };

  const install: UpdateController["install"] = async () => {
    if (disposed) return;
    // A failed download is retried from the release it was offered.
    if (snapshot.status === "error" && offered !== null && snapshot.release !== null) {
      moveTo("available", { error: null });
    }
    if (snapshot.status !== "available") {
      log.debug("Update: there is nothing to install");
      return;
    }

    const held = offered;
    if (held === null) {
      failWith(updateError("INSTALL_FAILED", "The offered release was already released."), true);
      return;
    }

    const version = snapshot.release?.version ?? "the update";
    log.info(`Update: downloading ${version}`);
    moveTo("downloading", {
      promptOpen: true,
      error: null,
      progress: { phase: "downloading", downloadedBytes: 0, totalBytes: null },
    });

    const onProgress = (progress: UpdateProgress) => {
      if (disposed) return;
      if (progress.phase === "installing" && statusNow() === "downloading") {
        log.info(`Update: installing ${version}`);
        moveTo("installing", { progress });
        return;
      }
      if (statusNow() === "downloading") setSnapshot({ progress });
    };

    try {
      await held.run(onProgress);
      if (disposed) return;

      // A provider that reported no "installing" progress still installed;
      // the state machine has no path from `downloading` straight to `ready`.
      if (statusNow() === "downloading") moveTo("installing", { progress: snapshot.progress });

      log.info(`Update: ${version} is installed and will run after a restart`);
      moveTo("ready", { progress: null, promptOpen: true });
      offered = null;
    } catch (error) {
      if (disposed) return;
      // Whatever went wrong, nothing unsigned was installed: the updater
      // verifies before it writes, so a failure here leaves this build intact.
      fail(error, true);
    }
  };

  const restart: UpdateController["restart"] = async () => {
    if (snapshot.status !== "ready") {
      log.debug("Update: there is no installed update to restart into");
      return;
    }
    log.info("Update: restarting into the new build");
    try {
      await provider.relaunch();
    } catch (error) {
      // The update is installed either way; only the restart failed, and the
      // user can close Nova themselves.
      log.warn("Update: the restart failed; close and reopen Nova to use it", error);
    }
  };

  return {
    provider: { label: provider.label, source: provider.source, available: provider.available },
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    check,
    install,
    restart,
    dismiss: () => {
      // "Later" on an offered release puts it back to `idle` and keeps it, so
      // reopening the prompt does not have to ask the source again. "Later" on
      // an installed update only closes the prompt: it is still installed.
      if (snapshot.status === "available") moveTo("idle", { promptOpen: false });
      else setSnapshot({ promptOpen: false });
    },
    open: () => setSnapshot({ promptOpen: true }),
    start: () => {
      if (startHandled || disposed) return;
      startHandled = true;

      if (!policy().checkOnStartup) {
        log.debug("Update: the startup check is off in Settings");
        return;
      }
      if (!provider.available) {
        log.debug(`Update: this build cannot update itself (${provider.source})`);
        return;
      }

      startupTimer = clock.setTimeout(() => {
        startupTimer = null;
        void check();
      }, startupDelayMs);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      checkPass += 1;
      clock.clearTimeout(startupTimer);
      startupTimer = null;
      release();
      listeners.clear();
    },
  };
}
