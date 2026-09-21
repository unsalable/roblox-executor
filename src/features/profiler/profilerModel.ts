import type {
  ProfileCategory,
  ProfileFrame,
  ProfileSample,
  ProfileSummary,
} from "@/features/profiler/types";

/**
 * Turning samples into what the panel shows: per-function totals, a summary and
 * the timeline buckets. All pure, so the numbers can be checked without a
 * provider, a controller or a view — and so aggregating a session twice always
 * gives the same answer.
 */

/** How many buckets the timeline is drawn with. Enough to read, cheap to render. */
export const TIMELINE_BUCKETS = 60;

const round = (value: number, digits = 3): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/**
 * One entry per function, busiest first. Percentages are shares of the sampled
 * work, so they add up to 100 for a non-empty session.
 */
export function aggregateFrames(samples: readonly ProfileSample[]): readonly ProfileFrame[] {
  if (samples.length === 0) return [];

  const totals = new Map<string, { category: ProfileCategory; totalDurationMs: number; sampleCount: number }>();
  let total = 0;

  for (const sample of samples) {
    total += sample.durationMs;
    const entry = totals.get(sample.frame);
    if (entry === undefined) {
      totals.set(sample.frame, {
        category: sample.category,
        totalDurationMs: sample.durationMs,
        sampleCount: 1,
      });
      continue;
    }
    entry.totalDurationMs += sample.durationMs;
    entry.sampleCount += 1;
  }

  return [...totals.entries()]
    .map(([name, entry]) => ({
      name,
      category: entry.category,
      totalDurationMs: round(entry.totalDurationMs),
      sampleCount: entry.sampleCount,
      // A session whose samples all measured zero has no share to divide.
      percentage: total === 0 ? 0 : round((entry.totalDurationMs / total) * 100, 2),
    }))
    .sort((a, b) => b.totalDurationMs - a.totalDurationMs || a.name.localeCompare(b.name));
}

export function summarize(
  samples: readonly ProfileSample[],
  frames: readonly ProfileFrame[],
): ProfileSummary {
  const sampledDurationMs = round(samples.reduce((total, sample) => total + sample.durationMs, 0));
  return {
    sampleCount: samples.length,
    frameCount: frames.length,
    sampledDurationMs,
    busiestFrame: frames[0]?.name ?? null,
  };
}

export interface TimelineBucket {
  /** Milliseconds from the start of the recording. */
  readonly offsetMs: number;
  readonly sampleCount: number;
  readonly durationMs: number;
  /** The category most of this bucket's time went to, or null when it is empty. */
  readonly category: ProfileCategory | null;
  /** This bucket's time as a share of the busiest bucket, 0–1. */
  readonly intensity: number;
}

/**
 * The samples grouped into equal slices of the recording, for the timeline.
 * Bucketing rather than drawing every sample keeps the chart the same size
 * whether a session holds sixty samples or six hundred.
 */
export function buildTimeline(
  samples: readonly ProfileSample[],
  window: { startedAt: number; durationMs: number },
  bucketCount: number = TIMELINE_BUCKETS,
): readonly TimelineBucket[] {
  const buckets = Math.max(1, Math.floor(bucketCount));
  const span = Math.max(1, window.durationMs);
  const width = span / buckets;

  const totals = Array.from({ length: buckets }, () => ({
    sampleCount: 0,
    durationMs: 0,
    byCategory: new Map<ProfileCategory, number>(),
  }));

  for (const sample of samples) {
    const offset = sample.timestamp - window.startedAt;
    const index = Math.min(buckets - 1, Math.max(0, Math.floor(offset / width)));
    const bucket = totals[index];
    if (!bucket) continue;

    bucket.sampleCount += 1;
    bucket.durationMs += sample.durationMs;
    bucket.byCategory.set(sample.category, (bucket.byCategory.get(sample.category) ?? 0) + sample.durationMs);
  }

  const peak = totals.reduce((max, bucket) => Math.max(max, bucket.durationMs), 0);

  return totals.map((bucket, index) => {
    let category: ProfileCategory | null = null;
    let best = -1;
    for (const [name, duration] of bucket.byCategory) {
      if (duration > best) {
        best = duration;
        category = name;
      }
    }

    return {
      offsetMs: Math.round(index * width),
      sampleCount: bucket.sampleCount,
      durationMs: round(bucket.durationMs),
      category,
      intensity: peak === 0 ? 0 : round(bucket.durationMs / peak, 4),
    };
  });
}

/** "1.4 s", "820 ms" — durations as a developer reads them at a glance. */
export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "—";
  if (durationMs < 1) return `${durationMs.toFixed(2)} ms`;
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 2 : 1)} s`;
}

/** "32.4%" with one decimal, so the top-frame column stays aligned. */
export function formatPercentage(percentage: number): string {
  if (!Number.isFinite(percentage)) return "—";
  return `${percentage.toFixed(1)}%`;
}
