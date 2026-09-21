import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Icon, type IconName } from "@/components/ui/Icon";
import type { ConsoleLog } from "@/features/console/useConsoleLog";
import { filterByCategory } from "@/features/diagnostics/diagnostics";
import { DIAGNOSTIC_CATEGORIES, type DiagnosticCategory } from "@/features/diagnostics/types";
import { ExecutionHistoryView } from "@/features/execution/ExecutionHistoryView";
import { useExecutionHistory } from "@/features/execution/useExecution";
import type { LogLevel } from "@/lib/logger";

const time = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const levelStyle: Record<LogLevel, { label: string; icon: IconName; className: string }> = {
  debug: { label: "DEBUG", icon: "debug", className: "text-subtle" },
  info: { label: "INFO", icon: "info", className: "text-accent" },
  warn: { label: "WARN", icon: "warning", className: "text-warning" },
  error: { label: "ERROR", icon: "error", className: "text-danger" },
};

const LEVEL_FILTERS = ["all", "debug", "info", "warn", "error"] as const;
type LevelFilter = (typeof LEVEL_FILTERS)[number];

/** Diagnostics carry a category; plain log lines do not, so "all" is the only filter that shows both. */
type CategoryFilter = DiagnosticCategory | "all";

export type ConsoleTab = "console" | "history";

const TABS: readonly { id: ConsoleTab; label: string; icon: IconName }[] = [
  { id: "console", label: "Console", icon: "console" },
  { id: "history", label: "History", icon: "history" },
];

interface ConsolePanelProps {
  log: ConsoleLog;
  tab: ConsoleTab;
  onTabChange: (tab: ConsoleTab) => void;
  height: number;
  onHeightChange: (height: number) => void;
  onClose: () => void;
  minHeight: number;
  maxHeight: number;
}

function formatData(data: unknown): string {
  if (data === undefined) return "";
  if (typeof data === "string") return data;
  if (data instanceof Error) return `${data.name}: ${data.message}`;
  try {
    return JSON.stringify(data) ?? String(data);
  } catch {
    return String(data);
  }
}

/**
 * The bottom panel: logger output and the execution history of this session.
 * Memoized: editor keystrokes re-render the shell but must not re-render up to 1000 log rows.
 */
export const ConsolePanel = memo(function ConsolePanel({
  log,
  tab,
  onTabChange,
  height,
  onHeightChange,
  onClose,
  minHeight,
  maxHeight,
}: ConsolePanelProps) {
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const history = useExecutionHistory();
  const tabsId = useId();

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const byCategory = filterByCategory(log.entries, categoryFilter === "all" ? null : categoryFilter);
    return byCategory.filter((entry) => {
      if (levelFilter !== "all" && entry.level !== levelFilter) return false;
      if (needle === "") return true;
      return entry.message.toLowerCase().includes(needle);
    });
  }, [log.entries, levelFilter, categoryFilter, query]);

  useEffect(() => {
    const list = listRef.current;
    if (list && stickToBottom.current) list.scrollTop = list.scrollHeight;
  }, [visible, tab]);

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = TABS.findIndex((item) => item.id === tab);
    const next = TABS[(index + (event.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length]!;
    onTabChange(next.id);
    document.getElementById(`${tabsId}-${next.id}-tab`)?.focus();
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;

    const onMove = (move: PointerEvent) => {
      const next = Math.min(maxHeight, Math.max(minHeight, startHeight - (move.clientY - startY)));
      onHeightChange(next);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
    };

    document.body.style.cursor = "ns-resize";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <section
      aria-label="Console"
      className="flex shrink-0 flex-col border-t border-border bg-surface"
      style={{ height }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize console"
        aria-valuenow={Math.round(height)}
        aria-valuemin={minHeight}
        aria-valuemax={Math.round(maxHeight)}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp") {
            event.preventDefault();
            onHeightChange(Math.min(maxHeight, height + 24));
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            onHeightChange(Math.max(minHeight, height - 24));
          }
        }}
        className="group h-1.5 shrink-0 cursor-ns-resize"
      >
        <div className="mx-auto mt-0.5 h-0.5 w-16 rounded-full bg-transparent transition-colors duration-[var(--dur-fast)] group-hover:bg-border-strong" />
      </div>

      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-1.5">
        <div role="tablist" aria-label="Output panel" className="flex h-full items-stretch">
          {TABS.map((item) => {
            const selected = item.id === tab;
            const count =
              item.id === "history"
                ? history.length
                : visible.length === log.entries.length
                  ? log.entries.length
                  : `${visible.length}/${log.entries.length}`;
            return (
              <button
                key={item.id}
                id={`${tabsId}-${item.id}-tab`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`${tabsId}-panel`}
                tabIndex={selected ? 0 : -1}
                onClick={() => onTabChange(item.id)}
                onKeyDown={onTabKeyDown}
                className={`relative flex items-center gap-1.5 px-2 text-[10px] font-semibold tracking-[0.12em] uppercase transition-colors duration-[var(--dur-fast)] ${
                  selected ? "text-foreground" : "text-subtle hover:text-muted"
                }`}
              >
                <Icon name={item.icon} size={13} className={selected ? "text-accent" : ""} />
                {item.label}
                <span className="font-mono font-normal tracking-normal text-subtle">{count}</span>
                <span
                  aria-hidden="true"
                  className={`absolute right-1.5 bottom-0 left-1.5 h-0.5 rounded-full bg-accent transition-opacity duration-[var(--dur-fast)] ${
                    selected ? "opacity-100" : "opacity-0"
                  }`}
                />
              </button>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <label
            hidden={tab !== "console"}
            className="flex items-center gap-1.5 rounded border border-border bg-surface-secondary px-1.5"
          >
            <Icon name="search" size={12} className="text-subtle" />
            <span className="sr-only">Filter console messages</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter"
              className="h-5 w-28 bg-transparent text-[11px] text-foreground outline-none placeholder:text-subtle"
            />
          </label>

          <select
            hidden={tab !== "console"}
            aria-label="Log level filter"
            value={levelFilter}
            onChange={(event) => setLevelFilter(event.target.value as LevelFilter)}
            className="h-5 rounded border border-border bg-surface-secondary px-1 text-[11px] text-muted"
          >
            {LEVEL_FILTERS.map((level) => (
              <option key={level} value={level}>
                {level === "all" ? "All levels" : level.toUpperCase()}
              </option>
            ))}
          </select>

          <select
            hidden={tab !== "console"}
            aria-label="Diagnostic category filter"
            value={categoryFilter}
            onChange={(event) => setCategoryFilter(event.target.value as CategoryFilter)}
            className="h-5 rounded border border-border bg-surface-secondary px-1 text-[11px] text-muted"
          >
            <option value="all">All areas</option>
            {DIAGNOSTIC_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>

          <button
            type="button"
            hidden={tab !== "console"}
            onClick={log.clear}
            aria-label="Clear console"
            title="Clear console"
            className="rounded p-1 text-subtle transition-colors duration-[var(--dur-fast)] hover:bg-surface-raised hover:text-foreground"
          >
            <Icon name="trash" size={14} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Hide console"
            title="Hide console"
            className="rounded p-1 text-subtle transition-colors duration-[var(--dur-fast)] hover:bg-surface-raised hover:text-foreground"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      </header>

      {tab === "history" ? (
        <div
          id={`${tabsId}-panel`}
          role="tabpanel"
          aria-labelledby={`${tabsId}-history-tab`}
          className="flex min-h-0 flex-1"
        >
          <ExecutionHistoryView />
        </div>
      ) : null}

      <div
        ref={listRef}
        hidden={tab !== "console"}
        {...(tab === "console"
          ? { id: `${tabsId}-panel`, role: "tabpanel", "aria-labelledby": `${tabsId}-console-tab` }
          : {})}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        }}
        className="select-text-area min-h-0 flex-1 overflow-y-auto py-1 font-mono text-[11px] leading-5"
      >
        {visible.length === 0 ? (
          <p className="px-3 py-4 text-[11px] text-subtle">
            {log.entries.length === 0 ? "No log output yet." : "No entries match the current filter."}
          </p>
        ) : (
          visible.map((entry) => {
            const style = levelStyle[entry.level];
            const data = formatData(entry.data);

            return (
              <div
                key={entry.id}
                className="flex gap-3 px-3 py-px transition-colors duration-[var(--dur-fast)] hover:bg-surface-secondary"
              >
                <span className="shrink-0 text-subtle tabular-nums">{time.format(entry.timestamp)}</span>
                <span className={`flex w-16 shrink-0 items-center gap-1 self-start leading-5 ${style.className}`}>
                  <Icon name={style.icon} size={11} />
                  {style.label}
                </span>
                <span
                  className="w-[4.5rem] shrink-0 truncate text-subtle"
                  title={entry.meta?.source ? `${entry.meta.category} · ${entry.meta.source}` : entry.meta?.category}
                >
                  {entry.meta?.category ?? ""}
                </span>
                <span className="min-w-0 break-words text-code-plain">
                  {entry.message}
                  {entry.meta?.code ? (
                    <span className="ml-1.5 rounded-sm border border-border px-1 text-[10px] text-subtle">
                      {entry.meta.code}
                    </span>
                  ) : null}
                  {data ? <span className="text-subtle"> {data}</span> : null}
                </span>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
});
