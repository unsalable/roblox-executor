import type {
  UpdateCheck,
  UpdateInstall,
  UpdateProgress,
  UpdateProvider,
  UpdateRelease,
} from "@/features/updates/types";

/**
 * A scripted updater, used only by unit tests.
 *
 * Every outcome the real one can produce is an outcome this one can be told to
 * produce — including the two that must never be reachable by accident: an
 * artifact whose signature does not verify, and a source that cannot be
 * reached. Without it those paths could only be exercised by publishing a
 * broken release.
 */

export interface FakeUpdateProviderOptions {
  available?: boolean;
  source?: string;
}

export interface FakeUpdateProvider extends UpdateProvider {
  /** The next check answers "no newer release". */
  answerUpToDate: () => void;
  /** The next check offers `version`. */
  answerAvailable: (version: string, release?: Partial<UpdateRelease>) => void;
  /** The next check rejects with `error`. */
  answerFailure: (error: unknown) => void;
  /** The next install rejects with `error`, after reporting `progress` first. */
  failInstall: (error: unknown, progress?: readonly UpdateProgress[]) => void;
  /** The progress the next successful install reports, in order. */
  installProgress: (progress: readonly UpdateProgress[]) => void;
  /** Makes the next check hang until the returned function is called. */
  holdCheck: () => () => void;
  readonly calls: { check: number; install: number; relaunch: number; close: number };
}

const CURRENT_VERSION = "2026.921.1350";

export function createFakeUpdateProvider(options: FakeUpdateProviderOptions = {}): FakeUpdateProvider {
  const calls = { check: 0, install: 0, relaunch: 0, close: 0 };

  let answer: () => Promise<UpdateCheck> = () => Promise.resolve<UpdateCheck>({ status: "up-to-date" });
  let installOutcome: { error: unknown } | null = null;
  let progressScript: readonly UpdateProgress[] = [
    { phase: "downloading", downloadedBytes: 0, totalBytes: 100 },
    { phase: "downloading", downloadedBytes: 100, totalBytes: 100 },
    { phase: "installing", downloadedBytes: 100, totalBytes: 100 },
  ];
  let gate: Promise<void> | null = null;

  const makeInstall = (): UpdateInstall => ({
    run: async (onProgress) => {
      calls.install += 1;
      for (const progress of progressScript) onProgress(progress);
      if (installOutcome !== null) throw installOutcome.error;
    },
    close: async () => {
      calls.close += 1;
    },
  });

  return {
    label: "Fake Updater",
    source: options.source ?? "test://releases",
    available: options.available ?? true,

    check: async () => {
      calls.check += 1;
      if (gate) await gate;
      return answer();
    },

    relaunch: async () => {
      calls.relaunch += 1;
    },

    answerUpToDate: () => {
      answer = () => Promise.resolve<UpdateCheck>({ status: "up-to-date" });
    },

    answerAvailable: (version, release = {}) => {
      answer = () =>
        Promise.resolve<UpdateCheck>({
          status: "available",
          release: {
            version,
            currentVersion: CURRENT_VERSION,
            notes: null,
            publishedAt: null,
            ...release,
          },
          install: makeInstall(),
        });
    },

    answerFailure: (error) => {
      answer = () => Promise.reject(error);
    },

    failInstall: (error, progress) => {
      installOutcome = { error };
      if (progress) progressScript = progress;
    },

    installProgress: (progress) => {
      progressScript = progress;
      installOutcome = null;
    },

    holdCheck: () => {
      let open = () => {};
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return () => {
        gate = null;
        open();
      };
    },

    calls,
  };
}
