import {
  DIAGNOSTIC_CATEGORIES,
  type Diagnostic,
  type DiagnosticCategory,
  type DiagnosticEntry,
  type DiagnosticSeverity,
} from "@/features/diagnostics/types";
import { logger, type LogEntry } from "@/lib/logger";

/**
 * Reporting and reading developer diagnostics.
 *
 * Reporting goes through `logger.report`, so there is exactly one log stream in
 * the application; reading turns log entries back into typed diagnostics for
 * the surfaces that want the structure (filters, the console's category chip).
 */

const CATEGORIES: ReadonlySet<string> = new Set(DIAGNOSTIC_CATEGORIES);

/** Reports one diagnostic. `data` is optional technical context, never source text. */
export function reportDiagnostic(diagnostic: Diagnostic, data?: unknown): void {
  const { severity, category, message, objectId, source, code } = diagnostic;
  logger.report(
    severity,
    message,
    {
      category,
      ...(code === undefined ? {} : { code }),
      ...(source === undefined ? {} : { source }),
      ...(objectId === undefined ? {} : { objectId }),
    },
    data,
  );
}

export interface DiagnosticReporter {
  debug: (message: string, details?: DiagnosticDetails) => void;
  info: (message: string, details?: DiagnosticDetails) => void;
  warn: (message: string, details?: DiagnosticDetails) => void;
  error: (message: string, details?: DiagnosticDetails) => void;
}

export type DiagnosticDetails = Omit<Diagnostic, "severity" | "category" | "message"> & { data?: unknown };

/**
 * A reporter bound to one category and source, so a subsystem states them once
 * instead of on every call.
 */
export function createDiagnosticReporter(category: DiagnosticCategory, source?: string): DiagnosticReporter {
  const report = (severity: DiagnosticSeverity, message: string, details?: DiagnosticDetails) => {
    const { data, ...rest } = details ?? {};
    reportDiagnostic(
      {
        severity,
        category,
        message,
        ...(source === undefined ? {} : { source }),
        ...rest,
      },
      data,
    );
  };

  return {
    debug: (message, details) => report("debug", message, details),
    info: (message, details) => report("info", message, details),
    warn: (message, details) => report("warn", message, details),
    error: (message, details) => report("error", message, details),
  };
}

/**
 * The shape the existing subsystems already log through: `debug`, `info`,
 * `warn`, `error`, each taking a message and optional data.
 */
export type DiagnosticLog = Pick<typeof logger, "debug" | "info" | "warn" | "error">;

/**
 * A logger-shaped adapter that tags everything written through it with a
 * category and source.
 *
 * This is how the controllers and hooks that already log become structured
 * without changing a single call site — and without a second log stream: they
 * are handed one of these instead of the bare logger.
 */
export function createDiagnosticLog(category: DiagnosticCategory, source?: string): DiagnosticLog {
  const write = (severity: DiagnosticSeverity) => (message: string, data?: unknown) =>
    reportDiagnostic({ severity, category, message, ...(source === undefined ? {} : { source }) }, data);

  return { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") };
}

/**
 * The log entries of one category, or all of them when `category` is null.
 * This is the console panel's category filter: a plain log line has no
 * category, so filtering to one always leaves the unstructured lines out.
 */
export function filterByCategory(
  entries: readonly LogEntry[],
  category: DiagnosticCategory | null,
): readonly LogEntry[] {
  if (category === null) return entries;
  return entries.filter((entry) => entry.meta?.category === category);
}

/** The diagnostic a log entry carries, or null when it is a plain log line. */
export function toDiagnosticEntry(entry: LogEntry): DiagnosticEntry | null {
  const meta = entry.meta;
  if (!meta || meta.category === undefined || !CATEGORIES.has(meta.category)) return null;

  return {
    id: entry.id,
    timestamp: entry.timestamp,
    severity: entry.level,
    category: meta.category as DiagnosticCategory,
    message: entry.message,
    ...(meta.code === undefined ? {} : { code: meta.code }),
    ...(meta.source === undefined ? {} : { source: meta.source }),
    ...(meta.objectId === undefined ? {} : { objectId: meta.objectId }),
  };
}
