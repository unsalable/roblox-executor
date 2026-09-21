import type { LogLevel } from "@/lib/logger";

/**
 * Developer diagnostics: the structured half of Nova's one log stream.
 *
 * A diagnostic is an ordinary log entry that says more about itself — which
 * subsystem raised it, which object it concerns, which error code it carries.
 * It is reported through `lib/logger`, so the console panel, the log history
 * and every existing filter keep working unchanged.
 *
 * What a diagnostic never contains: script source, selected text, file
 * contents, tokens or credentials. Diagnostics describe what Nova did, not what
 * the user wrote.
 */

/** Same severities as the logger, so one stream keeps one scale. */
export type DiagnosticSeverity = LogLevel;

export const DIAGNOSTIC_CATEGORIES = [
  "Editor",
  "Workspace",
  "Explorer",
  "Debugger",
  "Profiler",
  "Execution",
  "Target",
  "Backend",
  "Updates",
  "System",
] as const;

export type DiagnosticCategory = (typeof DIAGNOSTIC_CATEGORIES)[number];

export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  readonly category: DiagnosticCategory;
  /** One sentence, written for a developer reading the console. Never source text. */
  readonly message: string;
  /** Identity of the developer object it concerns, e.g. an Explorer node id. */
  readonly objectId?: string;
  /** Where in Nova it was raised, e.g. "explorerController". */
  readonly source?: string;
  /** Machine-readable code, e.g. "EXPLORER_MISSING_PARENT". */
  readonly code?: string;
}

/** A diagnostic as it is read back out of the log stream. */
export interface DiagnosticEntry extends Diagnostic {
  /** The log entry's id, unique for the session. */
  readonly id: number;
  /** Epoch milliseconds. */
  readonly timestamp: number;
}
