import { useEffect, useState } from "react";

/** Sampling window; long enough to be stable, short enough to feel live. */
const WINDOW_MS = 500;

/**
 * Frame rate of this UI, measured with requestAnimationFrame.
 *
 * It reports what the interface actually renders — it is not a game or engine
 * metric. The loop only runs while `enabled` is true and the window is visible,
 * so the app never keeps a permanent animation frame callback, and a throttled
 * background window does not report a misleading near-zero rate.
 */
export function useFrameRate(enabled: boolean): number | null {
  const [fps, setFps] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      setFps(null);
      return;
    }

    let frames = 0;
    let windowStart = performance.now();
    let handle = 0;

    const tick = (now: number) => {
      handle = requestAnimationFrame(tick);

      frames += 1;
      const elapsed = now - windowStart;
      if (elapsed < WINDOW_MS) return;

      // A single frame in a long window means the browser throttled rendering
      // (hidden or occluded window); reporting that as the frame rate would be
      // misleading, so the previous reading is kept instead.
      if (frames > 1) setFps(Math.round((frames * 1000) / elapsed));
      frames = 0;
      windowStart = now;
    };

    const start = () => {
      if (handle !== 0) return;
      frames = 0;
      windowStart = performance.now();
      handle = requestAnimationFrame(tick);
    };

    const stop = () => {
      cancelAnimationFrame(handle);
      handle = 0;
    };

    const onVisibilityChange = () => {
      if (document.hidden) stop();
      else start();
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled]);

  return fps;
}
