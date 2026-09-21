import { memo, useCallback, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { useExecutionHistory } from "@/features/execution/useExecution";
import { executionModeLabel, type ExecutionHistoryEntry } from "@/features/execution/types";
import { executionDescriptor, StatusIndicator } from "@/features/status/StatusIndicator";

const time = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const HistoryRow = memo(function HistoryRow({
  entry,
  selected,
  onSelect,
}: {
  entry: ExecutionHistoryEntry;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => onSelect(entry.executionId)}
        className={`animate-row-in grid w-full grid-cols-[minmax(0,1fr)_6.5rem_4.5rem_4.5rem] items-center gap-3 px-3 py-0.5 text-left transition-colors duration-[var(--dur-fast)] ${
          selected ? "bg-accent-soft" : "hover:bg-surface-secondary"
        }`}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-code-plain">{entry.scriptName}</span>
          {entry.mode === "selection" ? (
            <span className="shrink-0 rounded-sm border border-border px-1 text-[9px] tracking-wide text-subtle uppercase">
              Selection
            </span>
          ) : null}
        </span>
        <StatusIndicator descriptor={executionDescriptor[entry.status]} name="Status" />
        <span className="text-right text-muted tabular-nums">{entry.durationMs} ms</span>
        <span className="text-right text-subtle tabular-nums">{time.format(entry.startedAt)}</span>
      </button>
    </li>
  );
});

function Details({ entry, onClose }: { entry: ExecutionHistoryEntry; onClose: () => void }) {
  const rows: { label: string; value: string; wide?: boolean }[] = [
    { label: "Script", value: entry.scriptName },
    { label: "Mode", value: executionModeLabel[entry.mode] },
    { label: "Status", value: executionDescriptor[entry.status].label },
    { label: "Duration", value: `${entry.durationMs} ms` },
    { label: "Time", value: time.format(entry.startedAt) },
    { label: "Provider", value: entry.provider },
    { label: "ID", value: entry.executionId, wide: true },
  ];
  if (entry.error) rows.push({ label: "Error", value: `${entry.error.message} (${entry.error.code})`, wide: true });

  return (
    <aside
      aria-label="Execution details"
      className="flex w-[40%] max-w-[26rem] min-w-72 shrink-0 flex-col border-l border-border"
    >
      <header className="flex h-7 shrink-0 items-center justify-between border-b border-border pr-1 pl-3">
        <h3 className="text-[10px] font-semibold tracking-[0.12em] text-subtle uppercase">Execution</h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close execution details"
          className="rounded p-1 text-subtle transition-colors duration-[var(--dur-fast)] hover:bg-surface-raised hover:text-foreground"
        >
          <Icon name="close" size={12} />
        </button>
      </header>
      <dl className="select-text-area grid min-h-0 flex-1 grid-cols-[4.75rem_minmax(0,1fr)_4.25rem_minmax(0,1fr)] content-start gap-x-2 overflow-y-auto px-3 py-1">
        {rows.map(({ label, value, wide }) => (
          <div key={label} className="contents">
            <dt className="whitespace-nowrap text-subtle">{label}</dt>
            <dd className={`break-words text-code-plain ${wide ? "col-span-3" : ""}`}>{value}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}

/** Finished executions of this session, newest first. Kept in memory only. */
export function ExecutionHistoryView() {
  const history = useExecutionHistory();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const toggle = useCallback((id: string) => setSelectedId((current) => (current === id ? null : id)), []);
  const selected = selectedId === null ? undefined : history.find((entry) => entry.executionId === selectedId);

  if (history.length === 0) {
    return (
      <p className="px-3 py-4 font-mono text-[11px] text-subtle">
        No executions yet. Finished executions of this session are listed here; history is not saved when Nova closes.
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 font-mono text-[11px] leading-5">
      <ul aria-label="Execution history" className="min-h-0 min-w-0 flex-1 overflow-y-auto py-1">
        {history.map((entry) => (
          <HistoryRow
            key={entry.executionId}
            entry={entry}
            selected={entry.executionId === selectedId}
            onSelect={toggle}
          />
        ))}
      </ul>
      {selected ? <Details entry={selected} onClose={() => setSelectedId(null)} /> : null}
    </div>
  );
}
