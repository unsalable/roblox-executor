import { Icon, type IconName } from "@/components/ui/Icon";
import { toolAvailability, unavailableReason } from "@/features/backend/toolAvailability";
import { useBackend } from "@/features/backend/useBackend";
import { Panel, PanelEmpty } from "@/components/ui/Panel";
import { ErrorCallout } from "@/features/errors/ErrorCallout";
import { describeProfilerError } from "@/features/errors/errorPresentation";
import { formatDuration, formatPercentage } from "@/features/profiler/profilerModel";
import { ProfilerTimeline, CATEGORY_COLOR } from "@/features/profiler/ProfilerTimeline";
import type { ProfilerState } from "@/features/profiler/types";
import { useProfiler } from "@/features/profiler/useProfiler";

/**
 * The Profiler workspace: record, stop, and read what the recording contained.
 *
 * **Whether the numbers here are simulated is the provider's own answer**, read
 * from its `simulated` flag: the mock provider generates them inside Nova,
 * deterministically, and the panel says so beside the summary rather than
 * leaving a developer to assume they are measurements. A backend that supplies
 * no profiler at all says that instead, rather than blaming a missing target.
 */

const STATE_TEXT: Record<ProfilerState, { label: string; tone: string }> = {
  // Not "No target": a missing target is only one of the three reasons a tool
  // is unavailable, and with a backend that supplies no profiler it is the
  // wrong one. The specific reason is on the Start control and below.
  unavailable: { label: "Unavailable", tone: "border-border text-subtle" },
  ready: { label: "Ready", tone: "border-border-strong text-muted" },
  recording: { label: "Recording", tone: "border-danger/50 bg-danger-soft text-danger" },
  error: { label: "Error", tone: "border-danger/50 bg-danger-soft text-danger" },
};

function ControlButton({
  icon,
  label,
  onClick,
  disabledReason,
  primary = false,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabledReason?: string | undefined;
  primary?: boolean;
}) {
  const disabled = disabledReason !== undefined;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabledReason ?? label}
      aria-label={label}
      className={`flex h-7 items-center gap-1.5 rounded border px-2.5 text-[11px] transition-colors duration-[var(--dur-fast)] disabled:pointer-events-none disabled:opacity-40 ${
        primary
          ? "border-accent bg-accent text-accent-foreground hover:bg-accent-hover"
          : "border-border-strong bg-surface text-foreground hover:border-accent hover:bg-surface-raised"
      }`}
    >
      <Icon name={icon} size={13} className="shrink-0" />
      <span>{label}</span>
    </button>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-24 rounded border border-border bg-surface px-3 py-2" title={hint}>
      <p className="text-[10px] tracking-[0.12em] text-subtle uppercase">{label}</p>
      <p className="mt-0.5 font-mono text-sm text-foreground tabular-nums">{value}</p>
    </div>
  );
}

export function ProfilerWorkspace() {
  const { state, session, recordingSince, busy, error, history, controller } = useProfiler();
  const backend = useBackend();

  const recording = state === "recording";
  const startReason =
    state === "unavailable"
      ? unavailableReason("profiler", toolAvailability("profiler", backend.state, backend.capabilities))
      : recording
        ? "A recording is already running."
        : busy
          ? "A profiler operation is already in progress."
          : undefined;
  const stopReason = !recording
    ? "There is no recording to stop."
    : busy
      ? "A profiler operation is already in progress."
      : undefined;
  const clearReason = recording
    ? "Stop the recording first."
    : session === null && history.length === 0
      ? "There is nothing to clear."
      : undefined;
  const refreshReason = session === null ? "There is no recorded session to read again." : undefined;

  const badge = STATE_TEXT[state];

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2.5">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground">
          <Icon name="profiler" size={15} className="text-accent" />
          Profiler
        </h2>
        <span className={`rounded-full border px-2 py-0.5 text-[10px] tracking-wide uppercase ${badge.tone}`}>
          {badge.label}
        </span>
        {busy ? <span className="text-[11px] text-subtle">working…</span> : null}
        {recording && recordingSince !== null ? (
          <span className="text-[11px] text-muted">
            started at {new Date(recordingSince).toLocaleTimeString()}
          </span>
        ) : null}

        <span className="ml-auto flex items-center gap-2 text-[11px] text-subtle">
          {controller.provider.simulated ? (
            <span
              title={controller.provider.description}
              className="rounded-sm border border-warning/40 px-1 text-[9px] tracking-wide text-warning uppercase"
            >
              Simulated
            </span>
          ) : null}
          <span title={controller.provider.description}>{controller.provider.label}</span>
        </span>
      </header>

      <div
        role="toolbar"
        aria-label="Profiler controls"
        className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-surface px-3 py-2"
      >
        <ControlButton
          icon="record"
          label="Start"
          onClick={() => void controller.start()}
          disabledReason={startReason}
          primary
        />
        <ControlButton icon="stop" label="Stop" onClick={() => void controller.stop()} disabledReason={stopReason} />
        <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
        <ControlButton
          icon="refresh"
          label="Refresh"
          onClick={() => void controller.refresh()}
          disabledReason={refreshReason}
        />
        <ControlButton icon="trash" label="Clear" onClick={controller.clear} disabledReason={clearReason} />
      </div>

      {error === null ? null : (
        <div className="shrink-0 px-3 pt-3">
          <ErrorCallout presentation={describeProfilerError(error)} />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {session === null ? (
          <div className="flex min-h-64 items-center justify-center">
            <div className="max-w-sm text-center">
              <div className="mx-auto flex size-11 items-center justify-center rounded-lg border border-border bg-surface text-subtle">
                <Icon name="profiler" size={20} />
              </div>
              <h3 className="mt-4 text-sm font-medium text-foreground">
                {recording ? "Recording…" : "No profile recorded"}
              </h3>
              <p className="mt-1.5 text-xs leading-relaxed text-muted">
                {recording
                  ? "Stop the recording to see its timeline and frames."
                  : state === "unavailable"
                    ? (startReason ?? "This profiler has nothing to record against.")
                    : "Start a recording to collect frames, samples and timings."}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <section aria-label="Summary" className="flex flex-wrap items-stretch gap-2">
              <Stat label="Duration" value={formatDuration(session.durationMs)} hint="How long the recording ran" />
              <Stat label="Samples" value={String(session.summary.sampleCount)} hint="Samples collected" />
              <Stat
                label="Frames"
                value={String(session.summary.frameCount)}
                hint="Distinct functions the samples landed in"
              />
              <Stat
                label="Sampled"
                value={formatDuration(session.summary.sampledDurationMs)}
                hint="Every sample's duration added up"
              />
              {session.simulated ? (
                <p className="flex min-w-48 flex-1 items-center rounded border border-warning/40 bg-warning-soft px-3 py-2 text-[11px] leading-relaxed text-warning">
                  Simulated data: these numbers are generated inside Nova and measure nothing outside it.
                </p>
              ) : null}
            </section>

            <Panel title="Timeline" badge={`${session.summary.sampleCount} samples`}>
              <ProfilerTimeline session={session} />
            </Panel>

            <Panel title="Top Frames" badge={`${session.frames.length}`}>
              {session.frames.length === 0 ? (
                <PanelEmpty title="No frames" detail="This recording collected no samples." />
              ) : (
                <ul className="py-1">
                  {session.frames.map((frame) => (
                    <li key={frame.name} className="flex items-center gap-3 px-3 py-1">
                      <span
                        aria-hidden="true"
                        className="size-2 shrink-0 rounded-sm"
                        style={{ backgroundColor: CATEGORY_COLOR[frame.category] }}
                      />
                      <span className="min-w-0 basis-40 truncate font-mono text-[11px] text-code-function">
                        {frame.name}
                      </span>
                      <span className="w-16 shrink-0 text-[10px] text-subtle">{frame.category}</span>
                      <span className="min-w-0 flex-1">
                        <span
                          aria-hidden="true"
                          className="block h-1.5 rounded-full bg-accent-soft"
                          style={{ width: `${Math.max(2, frame.percentage)}%` }}
                        />
                      </span>
                      <span className="w-14 shrink-0 text-right font-mono text-[11px] text-foreground tabular-nums">
                        {formatPercentage(frame.percentage)}
                      </span>
                      <span
                        className="w-16 shrink-0 text-right font-mono text-[10px] text-subtle tabular-nums"
                        title={`${frame.sampleCount} samples`}
                      >
                        {formatDuration(frame.totalDurationMs)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        )}

        {history.length === 0 ? null : (
          <section aria-label="Session history" className="mt-3">
            <Panel title="Session History" badge={`${history.length}`}>
              <ul className="py-1">
                {history.map((entry) => (
                  <li
                    key={entry.id}
                    className={`flex items-baseline gap-3 px-3 py-1 text-[11px] ${
                      entry.id === session?.id ? "text-foreground" : "text-muted"
                    }`}
                  >
                    <span className="shrink-0 font-mono text-[10px] text-subtle">
                      {new Date(entry.startedAt).toLocaleTimeString()}
                    </span>
                    <span className="w-16 shrink-0 font-mono tabular-nums">{formatDuration(entry.durationMs)}</span>
                    <span className="w-20 shrink-0 font-mono text-[10px] text-subtle tabular-nums">
                      {entry.sampleCount} samples
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-code-function">
                      {entry.busiestFrame ?? "—"}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          </section>
        )}
      </div>

      <p className="shrink-0 border-t border-border bg-surface px-4 py-1.5 text-[10px] leading-relaxed text-subtle">
        {controller.provider.label}: {controller.provider.description}
      </p>
    </div>
  );
}
