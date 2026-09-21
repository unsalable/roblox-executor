import type { Breakpoint } from "@/features/debugger/types";

/**
 * What the editor draws for the debugger, decided here rather than inside the
 * editor component: which lines carry a breakpoint glyph and which line
 * execution is stopped on.
 *
 * The result is plain data, so the rule can be tested without Monaco, and the
 * editor only has to translate it into decorations.
 */

/** Class names the editor applies; they are styled in `styles/globals.css`. */
export const DEBUG_CLASS = {
  breakpoint: "nova-glyph-breakpoint",
  breakpointDisabled: "nova-glyph-breakpoint nova-glyph-breakpoint-off",
  activeLine: "nova-debug-line",
  activeGlyph: "nova-debug-arrow",
} as const;

export interface DebugDecoration {
  /** 1-based line. */
  readonly line: number;
  /** Drawn in the glyph margin, left of the line numbers. */
  readonly glyphClassName?: string;
  /** Drawn across the whole line. */
  readonly lineClassName?: string;
  /** Drawn in the line-number margin. */
  readonly marginClassName?: string;
  readonly hoverMessage: string;
}

export interface DebugDecorationInput {
  /** Breakpoints of the script the editor is showing. */
  readonly breakpoints: readonly Breakpoint[];
  /** The line execution is stopped on in this script, or null. */
  readonly activeLine: number | null;
}

const breakpointHover = (breakpoint: Breakpoint): string => {
  const state = breakpoint.enabled ? "Breakpoint" : "Breakpoint (disabled)";
  const condition = breakpoint.condition === undefined ? "" : ` — condition: ${breakpoint.condition}`;
  const hits = breakpoint.hitCount > 0 ? ` — hit ${breakpoint.hitCount}×` : "";
  return `${state}${condition}${hits}`;
};

/**
 * One decoration per line, in line order. A line that is both stopped on and
 * has a breakpoint gets one decoration carrying both, so the editor never draws
 * two overlapping highlights.
 */
export function buildDebugDecorations({ breakpoints, activeLine }: DebugDecorationInput): readonly DebugDecoration[] {
  const byLine = new Map<number, DebugDecoration>();

  for (const breakpoint of breakpoints) {
    byLine.set(breakpoint.line, {
      line: breakpoint.line,
      glyphClassName: breakpoint.enabled ? DEBUG_CLASS.breakpoint : DEBUG_CLASS.breakpointDisabled,
      hoverMessage: breakpointHover(breakpoint),
    });
  }

  if (activeLine !== null && activeLine >= 1) {
    const existing = byLine.get(activeLine);
    byLine.set(activeLine, {
      ...(existing?.glyphClassName === undefined ? {} : { glyphClassName: existing.glyphClassName }),
      line: activeLine,
      lineClassName: DEBUG_CLASS.activeLine,
      marginClassName: DEBUG_CLASS.activeGlyph,
      hoverMessage: existing === undefined ? "Execution is stopped here" : `${existing.hoverMessage} — stopped here`,
    });
  }

  return [...byLine.values()].sort((a, b) => a.line - b.line);
}
