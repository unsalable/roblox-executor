import { config } from "@/app/config";

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Structured fields a caller may attach to an entry. They are all optional and
 * all free-form strings, so the logger stays a plain log stream that knows
 * nothing about the features writing to it; `features/diagnostics` supplies the
 * typed vocabulary on top.
 */
export interface LogMeta {
  /** Subsystem the entry came from, e.g. "Explorer". */
  category?: string;
  /** Machine-readable code, e.g. "TARGET_NOT_READY". */
  code?: string;
  /** Where in Nova it was raised, e.g. "explorerController". */
  source?: string;
  /** Identity of the developer object the entry is about, e.g. an Explorer node id. */
  objectId?: string;
}

export interface LogEntry {
  /** Monotonic id, used as a stable list key by the console panel. */
  id: number;
  level: LogLevel;
  message: string;
  timestamp: number;
  data?: unknown;
  /** Present on entries reported as structured diagnostics. */
  meta?: LogMeta;
}

const severity: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const minSeverity = severity[config.isDev ? "debug" : "info"];

const consoleMethod: Record<LogLevel, "debug" | "info" | "warn" | "error"> = {
  debug: "debug",
  info: "info",
  warn: "warn",
  error: "error",
};

const listeners = new Set<(entry: LogEntry) => void>();

/**
 * Entries emitted before any listener attached. The console panel mounts after
 * startup logging has already run, so it replays this buffer on mount instead
 * of showing an empty view.
 */
const HISTORY_LIMIT = 500;
const history: LogEntry[] = [];
let nextId = 1;

/** The Console panel attaches here. */
export function subscribeToLogs(listener: (entry: LogEntry) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Entries recorded so far, oldest first. */
export function getLogHistory(): readonly LogEntry[] {
  return history;
}

function log(level: LogLevel, message: string, data?: unknown, meta?: LogMeta): void {
  if (severity[level] < minSeverity) return;

  const entry: LogEntry = {
    id: nextId++,
    level,
    message,
    timestamp: Date.now(),
    ...(data === undefined ? {} : { data }),
    ...(meta === undefined ? {} : { meta }),
  };

  history.push(entry);
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);

  for (const listener of listeners) listener(entry);

  const prefix = `[${config.appName.toLowerCase()}] ${message}`;
  if (data === undefined) console[consoleMethod[level]](prefix);
  else console[consoleMethod[level]](prefix, data);
}

export const logger = {
  debug: (message: string, data?: unknown) => log("debug", message, data),
  info: (message: string, data?: unknown) => log("info", message, data),
  warn: (message: string, data?: unknown) => log("warn", message, data),
  error: (message: string, data?: unknown) => log("error", message, data),
  /**
   * The same stream, with the structured fields a developer diagnostic carries.
   * There is no second log: a diagnostic is a log entry that says more about
   * itself, so filtering, the console panel and the history all keep working.
   */
  report: (level: LogLevel, message: string, meta: LogMeta, data?: unknown) => log(level, message, data, meta),
};
