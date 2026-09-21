import { useSyncExternalStore } from "react";
import { useAppServices } from "@/app/services";
import type { ProfilerController } from "@/features/profiler/profilerController";
import type { ProfilerSnapshot } from "@/features/profiler/types";

/**
 * React's view of the profiler controller. The panel reads state through this
 * hook and never holds a session itself, so the numbers on screen are always
 * the ones the controller aggregated.
 */

export interface ProfilerView extends ProfilerSnapshot {
  controller: ProfilerController;
}

export function useProfiler(): ProfilerView {
  const { profiler } = useAppServices();
  const snapshot = useSyncExternalStore(profiler.subscribe, profiler.getSnapshot);
  return { ...snapshot, controller: profiler };
}
