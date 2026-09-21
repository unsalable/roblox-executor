import type { Breakpoint } from "@/features/debugger/types";

/**
 * Breakpoints as data: adding, removing, enabling and looking them up, without
 * a controller, a provider or a view.
 *
 * There is exactly one breakpoint per script line — the editor gutter, the
 * breakpoint list and the command palette all act on the same object, so a line
 * can never be "on" in one surface and "off" in another.
 */

/** At most this many breakpoints are kept; the oldest are dropped past it. */
export const BREAKPOINT_LIMIT = 200;

/** True when `line` can hold a breakpoint at all. */
export function isValidBreakpointLine(line: number): boolean {
  return Number.isInteger(line) && line >= 1;
}

export function findBreakpoint(
  breakpoints: readonly Breakpoint[],
  scriptId: string,
  line: number,
): Breakpoint | null {
  return breakpoints.find((entry) => entry.scriptId === scriptId && entry.line === line) ?? null;
}

export function findBreakpointById(breakpoints: readonly Breakpoint[], id: string): Breakpoint | null {
  return breakpoints.find((entry) => entry.id === id) ?? null;
}

/** The breakpoints of one script, in line order. */
export function breakpointsForScript(
  breakpoints: readonly Breakpoint[],
  scriptId: string | null,
): readonly Breakpoint[] {
  if (scriptId === null) return [];
  return breakpoints.filter((entry) => entry.scriptId === scriptId).sort((a, b) => a.line - b.line);
}

/** True when execution reaching `line` of `scriptId` should stop. */
export function hasEnabledBreakpoint(
  breakpoints: readonly Breakpoint[],
  scriptId: string,
  line: number,
): boolean {
  const breakpoint = findBreakpoint(breakpoints, scriptId, line);
  return breakpoint !== null && breakpoint.enabled;
}

export interface NewBreakpoint {
  scriptId: string;
  line: number;
  enabled?: boolean;
  condition?: string;
}

/**
 * Adds a breakpoint. Returns the same list when the line already has one, so a
 * duplicate is never created and a caller can tell nothing happened.
 */
export function addBreakpoint(
  breakpoints: readonly Breakpoint[],
  breakpoint: NewBreakpoint,
  createId: () => string,
): readonly Breakpoint[] {
  if (findBreakpoint(breakpoints, breakpoint.scriptId, breakpoint.line) !== null) return breakpoints;

  const entry: Breakpoint = {
    id: createId(),
    scriptId: breakpoint.scriptId,
    line: breakpoint.line,
    enabled: breakpoint.enabled ?? true,
    ...(breakpoint.condition === undefined ? {} : { condition: breakpoint.condition }),
    hitCount: 0,
  };

  const next = [...breakpoints, entry];
  return next.length > BREAKPOINT_LIMIT ? next.slice(next.length - BREAKPOINT_LIMIT) : next;
}

export function removeBreakpoint(breakpoints: readonly Breakpoint[], id: string): readonly Breakpoint[] {
  const next = breakpoints.filter((entry) => entry.id !== id);
  return next.length === breakpoints.length ? breakpoints : next;
}

/** Removes every breakpoint, or only those of one script. */
export function clearBreakpoints(
  breakpoints: readonly Breakpoint[],
  scriptId?: string,
): readonly Breakpoint[] {
  if (scriptId === undefined) return breakpoints.length === 0 ? breakpoints : [];
  const next = breakpoints.filter((entry) => entry.scriptId !== scriptId);
  return next.length === breakpoints.length ? breakpoints : next;
}

/** Replaces one breakpoint with a changed copy. Returns the same list when nothing changed. */
export function updateBreakpoint(
  breakpoints: readonly Breakpoint[],
  id: string,
  patch: Partial<Omit<Breakpoint, "id" | "scriptId">>,
): readonly Breakpoint[] {
  let changed = false;
  const next = breakpoints.map((entry) => {
    if (entry.id !== id) return entry;
    const updated = { ...entry, ...patch };
    if (
      updated.line === entry.line &&
      updated.enabled === entry.enabled &&
      updated.condition === entry.condition &&
      updated.hitCount === entry.hitCount
    ) {
      return entry;
    }
    changed = true;
    return updated;
  });
  return changed ? next : breakpoints;
}

/** Sets every hit count back to zero, e.g. when a new session starts. */
export function resetHitCounts(breakpoints: readonly Breakpoint[]): readonly Breakpoint[] {
  if (breakpoints.every((entry) => entry.hitCount === 0)) return breakpoints;
  return breakpoints.map((entry) => (entry.hitCount === 0 ? entry : { ...entry, hitCount: 0 }));
}
