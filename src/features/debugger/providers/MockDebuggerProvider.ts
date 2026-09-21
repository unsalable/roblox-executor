import { hasEnabledBreakpoint } from "@/features/debugger/breakpoints";
import type {
  Breakpoint,
  DebugContext,
  DebugPauseReason,
  DebugResumeMode,
  DebugRunOutcome,
  DebugStartRequest,
  DebugStop,
  DebuggerProvider,
  StackFrame,
  Variable,
  WatchEvaluation,
} from "@/features/debugger/types";
import { systemClock, type Clock, type TimerId } from "@/lib/clock";

/**
 * The local mock debugger.
 *
 * Nothing here observes an external program. The provider walks the lines of
 * the Nova script it was given and decides, from the line alone, how deep the
 * call stack is:
 *
 * ```text
 * main()
 *  └── update()
 *       └── calculate()
 *       (returns)
 * main()
 * ```
 *
 * That is the whole execution model — no process is opened, no memory is read,
 * no code is evaluated and no expression a user types is ever executed. The
 * same script always produces the same stack, the same variables and the same
 * stops, which is what makes the debugger testable.
 */

export const MOCK_DEBUGGER_LABEL = "Mock Debugger";
export const MOCK_DEBUGGER_TYPE = "local-mock";
export const MOCK_DEBUGGER_DESCRIPTION =
  "A simulated execution model written inside Nova. No process is attached and no code is run.";

/** Simulated timings, reported as simulated wherever they are shown. */
export const MOCK_DEBUGGER_TIMINGS = {
  startMs: 180,
  resumeMs: 90,
  stopMs: 120,
} as const;

/** Innermost function last: level 1 is the outermost frame. */
const FUNCTION_NAMES = ["main", "update", "calculate"] as const;

/**
 * The call depth of every line of a script, from its length alone.
 *
 * Short scripts degrade rather than breaking: one line is one frame, and the
 * bands only appear once there are enough lines to hold them.
 */
export function buildDebugProgram(lineCount: number): readonly number[] {
  const lines = Math.max(1, Math.floor(lineCount));
  if (lines === 1) return [1];
  if (lines === 2) return [1, 2];
  if (lines === 3) return [1, 2, 3];
  if (lines === 4) return [1, 2, 3, 1];

  const head = Math.max(1, Math.floor(lines * 0.25));
  const inUpdate = Math.max(1, Math.floor(lines * 0.2));
  const inCalculate = Math.max(1, Math.floor(lines * 0.25));

  const depths: number[] = [];
  for (let index = 0; index < head; index += 1) depths.push(1);
  for (let index = 0; index < inUpdate && depths.length < lines - 1; index += 1) depths.push(2);
  for (let index = 0; index < inCalculate && depths.length < lines - 1; index += 1) depths.push(3);
  // Whatever is left is `main` again, after the calls have returned.
  while (depths.length < lines) depths.push(1);
  return depths;
}

/** The call site of each outer frame: the last line that was still at that depth. */
function callSiteLine(depths: readonly number[], index: number, level: number): number {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (depths[cursor] === level) return cursor + 1;
  }
  return 1;
}

function buildStack(
  depths: readonly number[],
  index: number,
  scriptId: string,
  frameId: (depth: number) => string,
): readonly StackFrame[] {
  const depth = depths[index] ?? 1;
  const frames: StackFrame[] = [];

  for (let level = depth; level >= 1; level -= 1) {
    const position = depth - level;
    frames.push({
      id: frameId(position),
      functionName: `${FUNCTION_NAMES[level - 1] ?? "main"}()`,
      scriptId,
      line: level === depth ? index + 1 : callSiteLine(depths, index, level),
      column: 1,
      depth: position,
    });
  }
  return frames;
}

/** Deterministic, readable numbers: the same line always produces the same value. */
const fixed = (value: number, digits: number) => value.toFixed(digits);

function frameVariables(level: number, line: number, context: DebugContext | null): readonly Variable[] {
  const variables: Variable[] = [];

  if (level >= 1) {
    if (level === 1) {
      variables.push(
        { name: "player", value: "Player1", type: "Player", scope: "local" },
        { name: "startTime", value: fixed(line * 0.016, 3), type: "number", scope: "local" },
        { name: "running", value: "true", type: "boolean", scope: "local" },
      );
    }
    if (level === 2) {
      variables.push(
        { name: "delta", value: fixed((16 + (line % 5)) / 1000, 3), type: "number", scope: "local" },
        { name: "speed", value: String(12 + (line % 7)), type: "number", scope: "local" },
        { name: "player", value: "Player1", type: "Player", scope: "upvalue" },
      );
    }
    if (level === 3) {
      variables.push(
        {
          name: "position",
          value: `${line % 32}, ${fixed(4 + (line % 3) * 0.5, 1)}, ${(line * 3) % 48}`,
          type: "Vector3",
          scope: "local",
        },
        { name: "health", value: String(100 - (line % 13)), type: "number", scope: "local" },
        { name: "speed", value: String(12 + (line % 7)), type: "number", scope: "upvalue" },
      );
    }
  }

  variables.push({ name: "workspace", value: "Workspace", type: "Workspace", scope: "global" });
  if (context !== null) {
    // The shared developer selection, visible as the session's context object.
    variables.push({ name: "context", value: context.path, type: context.className, scope: "global" });
  }
  return variables;
}

/** Fields a watch may read on a value the frame already holds. */
const MEMBERS: Readonly<Record<string, Readonly<Record<string, { value: string; type: string }>>>> = {
  player: {
    Name: { value: "Player1", type: "string" },
    UserId: { value: "1", type: "number" },
    DisplayName: { value: "Player1", type: "string" },
  },
  workspace: {
    Name: { value: "Workspace", type: "string" },
    Gravity: { value: "196.2", type: "number" },
  },
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

interface Session {
  id: string;
  scriptId: string;
  depths: readonly number[];
  context: DebugContext | null;
  /** 0-based index of the line execution stands on, or -1 before it started. */
  index: number;
  stopSeq: number;
  /** frame id → the call level and line it shows. */
  frames: Map<string, { level: number; line: number }>;
  pauseRequested: boolean;
}

export interface MockDebuggerProviderOptions {
  clock?: Clock;
  startMs?: number;
  resumeMs?: number;
  stopMs?: number;
}

export function createMockDebuggerProvider(options: MockDebuggerProviderOptions = {}): DebuggerProvider {
  const clock = options.clock ?? systemClock;
  const startMs = options.startMs ?? MOCK_DEBUGGER_TIMINGS.startMs;
  const resumeMs = options.resumeMs ?? MOCK_DEBUGGER_TIMINGS.resumeMs;
  const stopMs = options.stopMs ?? MOCK_DEBUGGER_TIMINGS.stopMs;

  let session: Session | null = null;

  const noSession = (): DebugRunOutcome => ({
    status: "failed",
    error: {
      code: "DEBUGGER_NO_SESSION",
      message: "The debug session is no longer running.",
      details: "The provider was asked to continue a session it does not hold.",
    },
  });

  /** Records a stop and builds what the controller shows for it. */
  const stopAt = (current: Session, index: number, reason: DebugPauseReason): DebugStop => {
    current.index = index;
    current.stopSeq += 1;
    current.pauseRequested = false;
    current.frames = new Map();

    const depth = current.depths[index] ?? 1;
    const stack = buildStack(current.depths, index, current.scriptId, (position) => {
      const id = `${current.id}-${current.stopSeq}-${position}`;
      const level = depth - position;
      const line = level === depth ? index + 1 : callSiteLine(current.depths, index, level);
      current.frames.set(id, { level, line });
      return id;
    });

    return { line: index + 1, reason, stack };
  };

  /** Where the next run lands, or -1 when the program runs to the end. */
  const nextIndex = (current: Session, mode: DebugResumeMode, breakpoints: readonly Breakpoint[]): number => {
    const { depths, index } = current;
    const depth = depths[index] ?? 1;

    if (mode === "continue" && !current.pauseRequested) {
      for (let cursor = index + 1; cursor < depths.length; cursor += 1) {
        if (hasEnabledBreakpoint(breakpoints, current.scriptId, cursor + 1)) return cursor;
      }
      return -1;
    }
    // A pause request lands on the next line, whatever was asked for.
    if (mode === "step-into" || current.pauseRequested) return index + 1 < depths.length ? index + 1 : -1;

    for (let cursor = index + 1; cursor < depths.length; cursor += 1) {
      const next = depths[cursor] ?? 1;
      if (mode === "step-over" ? next <= depth : next < depth) return cursor;
    }
    return -1;
  };

  const reasonFor = (
    current: Session,
    index: number,
    mode: DebugResumeMode | null,
    breakpoints: readonly Breakpoint[],
  ): DebugPauseReason => {
    if (current.pauseRequested) return "pause";
    if (hasEnabledBreakpoint(breakpoints, current.scriptId, index + 1)) return "breakpoint";
    return mode === null ? "entry" : "step";
  };

  /** Runs `settle` after `delay`, honouring cancellation. */
  const schedule = (
    delay: number,
    signal: AbortSignal,
    settle: () => DebugRunOutcome,
  ): Promise<DebugRunOutcome> =>
    new Promise<DebugRunOutcome>((resolve) => {
      if (signal.aborted) {
        resolve({ status: "cancelled" });
        return;
      }

      let timer: TimerId | null = null;
      const onAbort = () => {
        if (timer !== null) clock.clearTimeout(timer);
        timer = null;
        resolve({ status: "cancelled" });
      };
      signal.addEventListener("abort", onAbort, { once: true });

      timer = clock.setTimeout(() => {
        timer = null;
        signal.removeEventListener("abort", onAbort);
        resolve(settle());
      }, delay);
    });

  return {
    label: MOCK_DEBUGGER_LABEL,
    providerType: MOCK_DEBUGGER_TYPE,
    simulated: true,
    supportsCancel: true,
    description: MOCK_DEBUGGER_DESCRIPTION,

    start: (request: DebugStartRequest, breakpoints, { signal }) => {
      const current: Session = {
        id: request.sessionId,
        scriptId: request.target.scriptId,
        depths: buildDebugProgram(request.target.lineCount),
        context: request.context,
        index: -1,
        stopSeq: 0,
        frames: new Map(),
        pauseRequested: false,
      };
      session = current;

      return schedule(startMs, signal, () => {
        if (session !== current) return noSession();
        // A session always stops on its first line, so there is something to
        // inspect even before a breakpoint has been set.
        return { status: "paused", stop: stopAt(current, 0, reasonFor(current, 0, null, breakpoints)) };
      });
    },

    resume: (sessionId, mode, breakpoints, { signal }) => {
      const current = session;
      if (!current || current.id !== sessionId) return Promise.resolve(noSession());

      return schedule(resumeMs, signal, () => {
        if (session !== current) return noSession();

        const index = nextIndex(current, mode, breakpoints);
        if (index < 0) {
          session = null;
          return { status: "completed" };
        }
        return { status: "paused", stop: stopAt(current, index, reasonFor(current, index, mode, breakpoints)) };
      });
    },

    requestPause: (sessionId) => {
      if (session && session.id === sessionId) session.pauseRequested = true;
    },

    stop: (sessionId) => {
      if (!session || session.id !== sessionId) return Promise.resolve();
      const current = session;
      return new Promise<void>((resolve) => {
        clock.setTimeout(() => {
          if (session === current) session = null;
          resolve();
        }, stopMs);
      });
    },

    getVariables: (sessionId, frameId) => {
      const current = session;
      const frame = current?.frames.get(frameId);
      if (!current || current.id !== sessionId || !frame) return [];
      return frameVariables(frame.level, frame.line, current.context);
    },

    evaluate: (sessionId, frameId, expression): WatchEvaluation => {
      const current = session;
      const frame = current?.frames.get(frameId);
      if (!current || current.id !== sessionId || !frame) {
        return {
          status: "error",
          error: {
            code: "WATCH_EVALUATION_FAILED",
            message: "There is no paused frame to read this name in.",
          },
        };
      }

      const trimmed = expression.trim();
      if (!IDENTIFIER.test(trimmed)) {
        return {
          status: "error",
          error: {
            code: "WATCH_EVALUATION_FAILED",
            message: "Only a plain name, or one field of it, can be watched.",
            details: "Watches read variables that are already in the frame; they never run code.",
          },
        };
      }

      const variables = frameVariables(frame.level, frame.line, current.context);
      const [root, member] = trimmed.split(".");
      const variable = variables.find((entry) => entry.name === root);

      if (!variable) {
        return {
          status: "error",
          error: {
            code: "WATCH_EVALUATION_FAILED",
            message: `No variable named "${root}" is visible in this frame.`,
          },
        };
      }
      if (member === undefined) return { status: "ok", value: variable.value, type: variable.type };

      const field = MEMBERS[root]?.[member];
      if (!field) {
        return {
          status: "error",
          error: {
            code: "WATCH_EVALUATION_FAILED",
            message: `"${root}" reports no field named "${member}".`,
          },
        };
      }
      return { status: "ok", value: field.value, type: field.type };
    },
  };
}
