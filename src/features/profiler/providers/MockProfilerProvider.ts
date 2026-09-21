import type {
  ProfileCategory,
  ProfileSample,
  ProfileStartOutcome,
  ProfileStartRequest,
  ProfileStopOutcome,
  ProfilerProvider,
} from "@/features/profiler/types";
import { systemClock, type Clock, type TimerId } from "@/lib/clock";

/**
 * The local mock profiler.
 *
 * Every number this provider reports is generated here, from a fixed table and
 * a seeded generator: **nothing is measured**. No frame time, allocation,
 * process or counter outside Nova is read, and the same recording length always
 * produces the same samples, which is what makes the profiler testable. The UI
 * labels the data as simulated wherever it is shown.
 */

export const MOCK_PROFILER_LABEL = "Mock Profiler";
export const MOCK_PROFILER_TYPE = "local-mock";
export const MOCK_PROFILER_DESCRIPTION =
  "Deterministic sample data generated inside Nova. Nothing outside Nova is measured.";

/** Simulated timings for the start and stop operations. */
export const MOCK_PROFILER_TIMINGS = { startMs: 80, stopMs: 120 } as const;

/** One sample per simulated frame at 60 Hz. */
export const MOCK_SAMPLE_INTERVAL_MS = 16;
export const MOCK_SAMPLE_RANGE = { min: 60, max: 600 } as const;

interface FrameTemplate {
  readonly name: string;
  readonly category: ProfileCategory;
  /** Relative chance of a sample landing in this frame. */
  readonly weight: number;
  /** Typical duration of one sample, in milliseconds. */
  readonly baseMs: number;
}

const FRAMES: readonly FrameTemplate[] = [
  { name: "render()", category: "Render", weight: 22, baseMs: 4.1 },
  { name: "update()", category: "Update", weight: 20, baseMs: 3.2 },
  { name: "calculate()", category: "Script", weight: 18, baseMs: 2.1 },
  { name: "stepPhysics()", category: "Physics", weight: 14, baseMs: 2.6 },
  { name: "replicate()", category: "Network", weight: 10, baseMs: 1.4 },
  { name: "idle()", category: "Idle", weight: 16, baseMs: 0.9 },
];

const TOTAL_WEIGHT = FRAMES.reduce((total, frame) => total + frame.weight, 0);

/**
 * A small, fast, fully deterministic generator. `Math.random` is deliberately
 * not used: the same session must produce the same profile every time.
 */
function createSequence(seed: number): () => number {
  let state = (seed >>> 0) + 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const clampSampleCount = (durationMs: number): number => {
  const estimated = Math.round(durationMs / MOCK_SAMPLE_INTERVAL_MS);
  return Math.min(MOCK_SAMPLE_RANGE.max, Math.max(MOCK_SAMPLE_RANGE.min, estimated));
};

/**
 * The samples a recording of `durationMs` produces. Exported so the shape of
 * the data can be checked directly, without a controller.
 */
export function generateMockSamples(
  seed: number,
  startedAt: number,
  durationMs: number,
): readonly ProfileSample[] {
  const next = createSequence(seed);
  const count = clampSampleCount(durationMs);
  const samples: ProfileSample[] = [];

  for (let index = 0; index < count; index += 1) {
    let pick = next() * TOTAL_WEIGHT;
    let template = FRAMES[FRAMES.length - 1] as FrameTemplate;
    for (const frame of FRAMES) {
      pick -= frame.weight;
      if (pick <= 0) {
        template = frame;
        break;
      }
    }

    // ±25% around the template's typical duration, so the timeline has shape.
    const duration = template.baseMs * (0.75 + next() * 0.5);
    samples.push({
      timestamp: startedAt + index * MOCK_SAMPLE_INTERVAL_MS,
      frame: template.name,
      category: template.category,
      durationMs: Math.round(duration * 1000) / 1000,
    });
  }

  return samples;
}

export interface MockProfilerProviderOptions {
  clock?: Clock;
  startMs?: number;
  stopMs?: number;
}

export function createMockProfilerProvider(options: MockProfilerProviderOptions = {}): ProfilerProvider {
  const clock = options.clock ?? systemClock;
  const startMs = options.startMs ?? MOCK_PROFILER_TIMINGS.startMs;
  const stopMs = options.stopMs ?? MOCK_PROFILER_TIMINGS.stopMs;

  /** Seeds come from a counter, not the session id, so runs stay reproducible. */
  let sessionIndex = 0;
  let recording: { id: string; seed: number } | null = null;
  const finished = new Map<string, readonly ProfileSample[]>();

  const schedule = <T>(delay: number, signal: AbortSignal, cancelled: T, settle: () => T): Promise<T> =>
    new Promise<T>((resolve) => {
      if (signal.aborted) {
        resolve(cancelled);
        return;
      }

      let timer: TimerId | null = null;
      const onAbort = () => {
        if (timer !== null) clock.clearTimeout(timer);
        timer = null;
        resolve(cancelled);
      };
      signal.addEventListener("abort", onAbort, { once: true });

      timer = clock.setTimeout(() => {
        timer = null;
        signal.removeEventListener("abort", onAbort);
        resolve(settle());
      }, delay);
    });

  return {
    label: MOCK_PROFILER_LABEL,
    providerType: MOCK_PROFILER_TYPE,
    simulated: true,
    description: MOCK_PROFILER_DESCRIPTION,

    start: (request: ProfileStartRequest, { signal }) => {
      sessionIndex += 1;
      const session = { id: request.sessionId, seed: sessionIndex };
      recording = session;

      return schedule<ProfileStartOutcome>(startMs, signal, { status: "cancelled" }, () => {
        if (recording !== session) {
          return {
            status: "failed",
            error: {
              code: "PROFILER_NO_SESSION",
              message: "The recording was replaced before it started.",
            },
          };
        }
        return { status: "started" };
      });
    },

    stop: (sessionId, context, { signal }) => {
      const session = recording;
      if (!session || session.id !== sessionId) {
        return Promise.resolve<ProfileStopOutcome>({
          status: "failed",
          error: {
            code: "PROFILER_NO_SESSION",
            message: "There is no recording to stop.",
            details: "The provider was asked to stop a session it does not hold.",
          },
        });
      }

      return schedule<ProfileStopOutcome>(stopMs, signal, { status: "cancelled" }, () => {
        if (recording !== session) {
          return {
            status: "failed",
            error: { code: "PROFILER_NO_SESSION", message: "The recording was replaced before it stopped." },
          };
        }
        recording = null;
        const samples = generateMockSamples(session.seed, context.endedAt - context.durationMs, context.durationMs);
        finished.set(sessionId, samples);
        return { status: "stopped", samples };
      });
    },

    read: (sessionId) => finished.get(sessionId) ?? null,

    clear: () => {
      recording = null;
      finished.clear();
    },
  };
}
