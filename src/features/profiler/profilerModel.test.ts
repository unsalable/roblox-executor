import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  aggregateFrames,
  buildTimeline,
  formatDuration,
  formatPercentage,
  summarize,
  TIMELINE_BUCKETS,
} from "@/features/profiler/profilerModel";
import { generateMockSamples, MOCK_SAMPLE_RANGE } from "@/features/profiler/providers/MockProfilerProvider";
import type { ProfileSample } from "@/features/profiler/types";

const sample = (frame: string, category: ProfileSample["category"], durationMs: number, timestamp: number): ProfileSample => ({
  frame,
  category,
  durationMs,
  timestamp,
});

const SAMPLES: readonly ProfileSample[] = [
  sample("render()", "Render", 4, 1000),
  sample("render()", "Render", 6, 1016),
  sample("update()", "Update", 5, 1032),
  sample("idle()", "Idle", 5, 1048),
];

describe("aggregating samples", () => {
  test("one entry per function, busiest first", () => {
    const frames = aggregateFrames(SAMPLES);

    assert.equal(frames.length, 3);
    assert.equal(frames[0]?.name, "render()");
    assert.equal(frames[0]?.sampleCount, 2);
    assert.equal(frames[0]?.totalDurationMs, 10);
  });

  test("percentages are shares of the recorded work and add up", () => {
    const frames = aggregateFrames(SAMPLES);
    const total = frames.reduce((sum, frame) => sum + frame.percentage, 0);

    assert.equal(frames[0]?.percentage, 50);
    assert.ok(Math.abs(total - 100) < 0.01, `percentages add up to ${total}`);
  });

  test("a recording with no samples has nothing to divide", () => {
    assert.deepEqual(aggregateFrames([]), []);
    const zero = aggregateFrames([sample("a()", "Idle", 0, 0), sample("b()", "Idle", 0, 16)]);
    assert.deepEqual(
      zero.map((frame) => frame.percentage),
      [0, 0],
    );
  });

  test("the summary names the busiest function and counts what was collected", () => {
    const frames = aggregateFrames(SAMPLES);
    assert.deepEqual(summarize(SAMPLES, frames), {
      sampleCount: 4,
      frameCount: 3,
      sampledDurationMs: 20,
      busiestFrame: "render()",
    });
    assert.equal(summarize([], []).busiestFrame, null);
  });

  test("aggregating the same samples twice gives the same answer", () => {
    assert.deepEqual(aggregateFrames(SAMPLES), aggregateFrames(SAMPLES));
  });
});

describe("the timeline", () => {
  test("samples are bucketed across the recording, whatever their number", () => {
    const samples = generateMockSamples(1, 5000, 1600);
    const buckets = buildTimeline(samples, { startedAt: 5000, durationMs: 1600 });

    assert.equal(buckets.length, TIMELINE_BUCKETS);
    assert.equal(
      buckets.reduce((total, bucket) => total + bucket.sampleCount, 0),
      samples.length,
    );
    assert.ok(buckets.some((bucket) => bucket.intensity === 1), "the busiest bucket is the full height");
    assert.ok(buckets.every((bucket) => bucket.intensity >= 0 && bucket.intensity <= 1));
  });

  test("each bucket names the work most of its time went to", () => {
    const buckets = buildTimeline(SAMPLES, { startedAt: 1000, durationMs: 64 }, 2);
    assert.equal(buckets.length, 2);
    assert.equal(buckets[0]?.category, "Render");
    assert.equal(buckets[0]?.sampleCount, 2);
  });

  test("an empty recording is an empty chart, not a broken one", () => {
    const buckets = buildTimeline([], { startedAt: 0, durationMs: 0 }, 4);
    assert.equal(buckets.length, 4);
    assert.ok(buckets.every((bucket) => bucket.sampleCount === 0 && bucket.category === null));
  });
});

describe("the generated samples", () => {
  test("the same recording always produces the same samples", () => {
    assert.deepEqual(generateMockSamples(3, 1000, 2000), generateMockSamples(3, 1000, 2000));
  });

  test("a different recording produces different samples", () => {
    assert.notDeepEqual(generateMockSamples(1, 1000, 2000), generateMockSamples(2, 1000, 2000));
  });

  test("the number of samples follows the recording, within sane bounds", () => {
    assert.equal(generateMockSamples(1, 0, 10).length, MOCK_SAMPLE_RANGE.min);
    assert.equal(generateMockSamples(1, 0, 10_000_000).length, MOCK_SAMPLE_RANGE.max);
    assert.equal(generateMockSamples(1, 0, 1600).length, 100);
  });

  test("every sample lands in a frame with a category and a positive duration", () => {
    for (const entry of generateMockSamples(4, 100, 1000)) {
      assert.ok(entry.frame.endsWith("()"), entry.frame);
      assert.ok(entry.durationMs > 0);
      assert.ok(entry.timestamp >= 100);
    }
  });
});

describe("formatting", () => {
  test("durations read the way a developer scans them", () => {
    assert.equal(formatDuration(0.25), "0.25 ms");
    assert.equal(formatDuration(820), "820 ms");
    assert.equal(formatDuration(1400), "1.40 s");
    assert.equal(formatDuration(-1), "—");
  });

  test("percentages keep one decimal, so the column stays aligned", () => {
    assert.equal(formatPercentage(32.44), "32.4%");
    assert.equal(formatPercentage(100), "100.0%");
    assert.equal(formatPercentage(Number.NaN), "—");
  });
});
