import { useMemo } from "react";
import { buildTimeline, formatDuration } from "@/features/profiler/profilerModel";
import { PROFILE_CATEGORIES, type ProfileCategory, type ProfileSession } from "@/features/profiler/types";

/**
 * The recording as a timeline: one bar per slice of the session, as tall as
 * that slice was busy and coloured by the work most of it went to.
 *
 * It is drawn as one inline SVG — no chart dependency, no canvas — and the
 * samples are bucketed first, so a session of six hundred samples costs the
 * same to render as one of sixty.
 */

/** Category colours, taken from the design tokens rather than written here. */
export const CATEGORY_COLOR: Record<ProfileCategory, string> = {
  Render: "var(--accent)",
  Update: "var(--success)",
  Physics: "var(--warning)",
  Script: "var(--code-keyword)",
  Network: "var(--code-function)",
  Idle: "var(--subtle)",
};

const VIEW_WIDTH = 600;
const VIEW_HEIGHT = 96;

export function ProfilerTimeline({ session }: { session: ProfileSession }) {
  const buckets = useMemo(
    () => buildTimeline(session.samples, { startedAt: session.startedAt, durationMs: session.durationMs }),
    [session],
  );

  const width = VIEW_WIDTH / Math.max(1, buckets.length);
  const used = new Set(buckets.map((bucket) => bucket.category).filter((value): value is ProfileCategory => value !== null));

  return (
    <div className="px-3 py-3">
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Simulated activity over ${formatDuration(session.durationMs)}, in ${buckets.length} slices`}
        className="h-24 w-full"
      >
        <line x1={0} y1={VIEW_HEIGHT} x2={VIEW_WIDTH} y2={VIEW_HEIGHT} stroke="var(--border)" strokeWidth={1} />
        {buckets.map((bucket, index) => {
          const height = Math.max(bucket.sampleCount === 0 ? 0 : 2, bucket.intensity * (VIEW_HEIGHT - 6));
          return (
            <rect
              key={bucket.offsetMs * buckets.length + index}
              x={index * width}
              y={VIEW_HEIGHT - height}
              width={Math.max(1, width - 1)}
              height={height}
              fill={bucket.category === null ? "var(--border)" : CATEGORY_COLOR[bucket.category]}
              opacity={bucket.category === null ? 0.5 : 0.85}
            >
              <title>
                {`+${bucket.offsetMs} ms · ${bucket.sampleCount} samples · ${formatDuration(bucket.durationMs)}${
                  bucket.category === null ? "" : ` · mostly ${bucket.category}`
                }`}
              </title>
            </rect>
          );
        })}
      </svg>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        {PROFILE_CATEGORIES.filter((category) => used.has(category)).map((category) => (
          <span key={category} className="flex items-center gap-1.5 text-[10px] text-subtle">
            <span
              aria-hidden="true"
              className="size-2 rounded-sm"
              style={{ backgroundColor: CATEGORY_COLOR[category] }}
            />
            {category}
          </span>
        ))}
        <span className="ml-auto font-mono text-[10px] text-subtle">
          0 ms → {formatDuration(session.durationMs)}
        </span>
      </div>
    </div>
  );
}
