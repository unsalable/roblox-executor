import { BREAKPOINT_LIMIT, isValidBreakpointLine } from "@/features/debugger/breakpoints";
import type { Breakpoint } from "@/features/debugger/types";
import { createId } from "@/lib/id";
import { logger } from "@/lib/logger";
import { readStored, writeStored } from "@/lib/storage";

/**
 * Breakpoint persistence.
 *
 * Breakpoints are local configuration — where the user wants execution to stop
 * — so they are kept between launches, in their own versioned document beside
 * the settings and the workspace. Session state never is: Nova always starts
 * with no session, so a stale "paused" cannot survive a restart, and nothing
 * here stores a stack, a variable or a watch value.
 */

export const BREAKPOINTS_STORAGE_KEY = "nova.debugger";
export const BREAKPOINTS_SCHEMA_VERSION = 1;

export interface PersistedBreakpointV1 {
  id: string;
  scriptId: string;
  line: number;
  enabled: boolean;
  condition?: string;
}

export interface PersistedBreakpointsV1 {
  version: number;
  breakpoints: PersistedBreakpointV1[];
}

export function serializeBreakpoints(breakpoints: readonly Breakpoint[]): PersistedBreakpointsV1 {
  return {
    version: BREAKPOINTS_SCHEMA_VERSION,
    breakpoints: breakpoints.map((entry) => ({
      id: entry.id,
      scriptId: entry.scriptId,
      line: entry.line,
      enabled: entry.enabled,
      ...(entry.condition === undefined ? {} : { condition: entry.condition }),
    })),
  };
}

export interface BreakpointParseResult {
  breakpoints: readonly Breakpoint[];
  /** Everything that was repaired or dropped, phrased for the log. */
  issues: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Validates stored breakpoints. Unreadable entries are dropped rather than
 * repaired into something the user did not ask for; hit counts are session
 * state and always start at zero.
 */
export function parseBreakpoints(value: unknown, context: { createId: () => string }): BreakpointParseResult {
  if (!isRecord(value) || !Array.isArray(value.breakpoints)) {
    return { breakpoints: [], issues: ["stored breakpoints are not readable"] };
  }
  if (value.version !== BREAKPOINTS_SCHEMA_VERSION) {
    return { breakpoints: [], issues: [`unsupported breakpoint version ${JSON.stringify(value.version)}`] };
  }

  const issues: string[] = [];
  const breakpoints: Breakpoint[] = [];
  const seen = new Set<string>();
  const ids = new Set<string>();

  for (const [index, entry] of value.breakpoints.entries()) {
    if (!isRecord(entry)) {
      issues.push(`dropped breakpoint #${index + 1}: not an object`);
      continue;
    }

    const { id, scriptId, line, enabled, condition } = entry;
    if (typeof scriptId !== "string" || scriptId === "") {
      issues.push(`dropped breakpoint #${index + 1}: it names no script`);
      continue;
    }
    if (typeof line !== "number" || !isValidBreakpointLine(line)) {
      issues.push(`dropped a breakpoint with an unusable line ${JSON.stringify(line)}`);
      continue;
    }

    const key = `${scriptId}:${line}`;
    if (seen.has(key)) {
      issues.push(`dropped a second breakpoint on line ${line} of the same script`);
      continue;
    }
    seen.add(key);

    let breakpointId = typeof id === "string" && id !== "" && !ids.has(id) ? id : null;
    if (breakpointId === null) {
      breakpointId = context.createId();
      issues.push(`a breakpoint on line ${line} had no usable id and was given a new one`);
    }
    ids.add(breakpointId);

    if (enabled !== undefined && typeof enabled !== "boolean") {
      issues.push(`a breakpoint on line ${line} had an unreadable enabled flag and was enabled`);
    }

    breakpoints.push({
      id: breakpointId,
      scriptId,
      line,
      enabled: enabled !== false,
      ...(typeof condition === "string" && condition.trim() !== "" ? { condition: condition.trim() } : {}),
      hitCount: 0,
    });

    if (breakpoints.length >= BREAKPOINT_LIMIT) {
      if (value.breakpoints.length > BREAKPOINT_LIMIT) {
        issues.push(`kept the first ${BREAKPOINT_LIMIT} breakpoints and dropped the rest`);
      }
      break;
    }
  }

  return { breakpoints, issues };
}

/** Reads the stored breakpoints, reporting whatever had to be repaired. */
export function loadBreakpoints(log: Pick<typeof logger, "info" | "warn"> = logger): readonly Breakpoint[] {
  const read = readStored(BREAKPOINTS_STORAGE_KEY);
  if (read.status === "missing") return [];
  if (read.status === "unreadable") {
    log.warn("Stored breakpoints could not be read, starting with none", read.error);
    return [];
  }

  const { breakpoints, issues } = parseBreakpoints(read.value, { createId });
  if (issues.length > 0) log.warn(`Stored breakpoints were repaired: ${issues.join("; ")}`);
  if (breakpoints.length > 0) log.info(`${breakpoints.length} breakpoint${breakpoints.length === 1 ? "" : "s"} restored`);
  return breakpoints;
}

export function saveBreakpoints(
  breakpoints: readonly Breakpoint[],
  log: Pick<typeof logger, "error"> = logger,
): boolean {
  let raw: string;
  try {
    raw = JSON.stringify(serializeBreakpoints(breakpoints));
  } catch (error) {
    log.error("Breakpoints could not be serialized", error);
    return false;
  }

  const write = writeStored(BREAKPOINTS_STORAGE_KEY, raw);
  if (!write.ok) log.error("Breakpoints could not be persisted", write.error);
  return write.ok;
}
