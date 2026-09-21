import { useRef } from "react";
import { config } from "@/app/config";
import { formatBuildId } from "@/app/releaseVersion";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { useUpdates } from "@/features/updates/useUpdates";
import type { UpdateProgress, UpdateStatus } from "@/features/updates/types";

/**
 * The whole of the update UI: one dialog, opened by the update controller when
 * there is something worth interrupting for and by the user otherwise.
 *
 * It is deliberately small. A silent check that finds nothing shows nothing at
 * all, a check that fails because the machine is offline shows nothing either,
 * and nothing here blocks the rest of Nova — the dialog is dismissable in every
 * state, including while an update is downloading, because the download carries
 * on without it.
 */

const buttonBase = "h-7 rounded px-3 text-xs transition-colors duration-[var(--dur-fast)]";
const secondaryButton = `${buttonBase} border border-border-strong text-foreground hover:bg-surface-raised`;
const primaryButton = `${buttonBase} font-medium bg-accent text-accent-foreground hover:bg-accent-hover disabled:pointer-events-none disabled:opacity-50`;

/** Bytes as a person reads them. Sizes here are always megabytes in practice. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const TITLES: Record<UpdateStatus, string> = {
  idle: "Updates",
  checking: "Checking for updates",
  "up-to-date": "Nova is up to date",
  available: "Update available",
  downloading: "Downloading update",
  installing: "Installing update",
  ready: "Update ready",
  error: "Update failed",
};

function ProgressBar({ progress }: { progress: UpdateProgress }) {
  const { downloadedBytes, totalBytes } = progress;
  const ratio = totalBytes !== null && totalBytes > 0 ? Math.min(1, downloadedBytes / totalBytes) : null;

  return (
    <div className="mt-3">
      <div
        role="progressbar"
        aria-label="Update download"
        {...(ratio === null
          ? {}
          : { "aria-valuenow": Math.round(ratio * 100), "aria-valuemin": 0, "aria-valuemax": 100 })}
        className="h-1.5 overflow-hidden rounded-full bg-surface-secondary"
      >
        <div
          className={`h-full rounded-full bg-accent transition-[width] duration-[var(--dur-fast)] ${
            ratio === null ? "w-1/3 animate-pulse" : ""
          }`}
          {...(ratio === null ? {} : { style: { width: `${ratio * 100}%` } })}
        />
      </div>
      <p className="mt-1.5 font-mono text-[11px] text-muted tabular-nums">
        {totalBytes === null
          ? formatBytes(downloadedBytes)
          : `${formatBytes(downloadedBytes)} of ${formatBytes(totalBytes)}`}
      </p>
    </div>
  );
}

function Builds({ current, next }: { current: string; next?: string | undefined }) {
  return (
    <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11px]">
      <dt className="text-muted">Installed build</dt>
      <dd className="font-mono text-foreground tabular-nums">{formatBuildId(current)}</dd>
      {next === undefined ? null : (
        <>
          <dt className="text-muted">New build</dt>
          <dd className="font-mono text-foreground tabular-nums">{formatBuildId(next)}</dd>
        </>
      )}
    </dl>
  );
}

export function UpdateDialog() {
  const updates = useUpdates();
  const { status, release, progress, error, promptOpen, provider } = updates;
  const primaryRef = useRef<HTMLButtonElement>(null);

  const currentVersion = release?.currentVersion ?? config.version;
  const busy = status === "checking" || status === "downloading" || status === "installing";

  return (
    <Dialog
      open={promptOpen}
      title={TITLES[status]}
      description={provider.source}
      onClose={updates.dismiss}
      widthClassName="max-w-md"
      initialFocusRef={primaryRef}
    >
      <div className="px-5 py-4 text-xs leading-relaxed text-muted">
        {status === "checking" ? <p>Asking the release source whether a newer build exists…</p> : null}

        {status === "up-to-date" ? (
          <>
            <p>This is the newest published build of Nova.</p>
            <Builds current={currentVersion} />
          </>
        ) : null}

        {status === "available" || status === "idle" ? (
          release === null ? (
            <p>No update has been found yet.</p>
          ) : (
            <>
              <p>A newer build of Nova is available. It is downloaded and verified before anything is installed.</p>
              <Builds current={currentVersion} next={release.version} />
              {release.notes ? (
                <div className="mt-3 max-h-40 overflow-y-auto rounded border border-border bg-surface-secondary px-3 py-2 text-[11px] whitespace-pre-wrap">
                  {release.notes}
                </div>
              ) : null}
            </>
          )
        ) : null}

        {status === "downloading" ? (
          <>
            <p>Downloading the update. You can keep working; this runs in the background.</p>
            <Builds current={currentVersion} next={release?.version} />
            {progress ? <ProgressBar progress={progress} /> : null}
          </>
        ) : null}

        {status === "installing" ? (
          <p className="flex items-center gap-2">
            <Icon name="refresh" size={14} className="animate-spin" />
            Installing update…
          </p>
        ) : null}

        {status === "ready" ? (
          <>
            <p>The update is installed. Nova has to restart to run it; your open scripts and settings are kept.</p>
            <Builds current={currentVersion} next={release?.version} />
          </>
        ) : null}

        {status === "error" && error ? (
          <>
            <p className="text-foreground">{error.message}</p>
            {error.code === "SIGNATURE_INVALID" ? (
              <p className="mt-1.5">
                Nothing was installed and this build is untouched. Try again later; if it keeps happening, download Nova
                again from {config.releaseRepository}.
              </p>
            ) : null}
            {error.details ? (
              <p className="mt-2 rounded border border-border bg-surface-secondary px-3 py-2 font-mono text-[11px] break-words">
                {error.details}
              </p>
            ) : null}
            <Builds current={currentVersion} {...(release ? { next: release.version } : {})} />
          </>
        ) : null}
      </div>

      <footer className="flex justify-end gap-2 border-t border-border px-5 py-3">
        <button type="button" onClick={updates.dismiss} className={secondaryButton}>
          {status === "ready" || status === "downloading" ? "Later" : "Close"}
        </button>

        {status === "available" && release ? (
          <button ref={primaryRef} type="button" onClick={updates.install} className={primaryButton}>
            Update
          </button>
        ) : null}

        {status === "ready" ? (
          <button ref={primaryRef} type="button" onClick={updates.restart} className={primaryButton}>
            Restart and Update
          </button>
        ) : null}

        {status === "up-to-date" ? (
          <button ref={primaryRef} type="button" onClick={updates.check} disabled={busy} className={primaryButton}>
            Check Again
          </button>
        ) : null}

        {/*
          A failed download is retried from the release that was already found;
          a failed check has nothing to retry but the check. Asking the source
          again after a download failure would be a second answer to a question
          that was already answered.
        */}
        {status === "error" ? (
          <button
            ref={primaryRef}
            type="button"
            onClick={release === null ? updates.check : updates.install}
            disabled={busy}
            className={primaryButton}
          >
            Try Again
          </button>
        ) : null}
      </footer>
    </Dialog>
  );
}
