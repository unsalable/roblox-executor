import { StatusIndicator, type StatusDescriptor } from "@/features/status/StatusIndicator";
import { useTargetHistory } from "@/features/target/useTarget";
import type { TargetHistoryStatus } from "@/features/target/types";

const time = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const historyDescriptor: Record<TargetHistoryStatus, StatusDescriptor> = {
  injected: { label: "Injected", tone: "text-success", shape: "filled" },
  failed: { label: "Failed", tone: "text-danger", shape: "cross" },
  timeout: { label: "Timed out", tone: "text-danger", shape: "cross" },
  cancelled: { label: "Cancelled", tone: "text-warning", shape: "square" },
  disconnected: { label: "Disconnected", tone: "text-muted", shape: "ring" },
};

/**
 * Target operations of this session, newest first and bounded. Entries hold
 * workflow metadata only — no script source and nothing about a process.
 */
export function TargetHistoryView() {
  const history = useTargetHistory();

  if (history.length === 0) {
    return (
      <p className="rounded border border-border bg-surface-secondary px-3 py-2 font-mono text-[11px] text-subtle">
        No target operations yet. This session's injections and disconnects are listed here; history is not saved
        when Nova closes.
      </p>
    );
  }

  return (
    <ul
      aria-label="Target history"
      className="max-h-40 overflow-y-auto rounded border border-border bg-surface-secondary px-3 py-1 font-mono text-[11px] leading-5"
    >
      {history.map((entry) => (
        <li
          key={`${entry.requestId}:${entry.startedAt}:${entry.status}`}
          title={entry.error ? `${entry.error.message} (${entry.error.code})` : `Request ${entry.requestId}`}
          className="grid grid-cols-[4.75rem_minmax(0,1fr)_4.5rem] items-center gap-3 py-0.5"
        >
          <span className="text-subtle tabular-nums">{time.format(entry.startedAt)}</span>
          <span className="flex min-w-0 items-center gap-2">
            <StatusIndicator descriptor={historyDescriptor[entry.status]} name="Result" />
            {entry.error ? <span className="truncate text-subtle">{entry.error.code}</span> : null}
          </span>
          <span className="text-right text-muted tabular-nums">
            {entry.durationMs === null ? "—" : `${entry.durationMs} ms`}
          </span>
        </li>
      ))}
    </ul>
  );
}
