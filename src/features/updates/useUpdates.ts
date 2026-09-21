import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useAppServices } from "@/app/services";
import type { UpdateProviderInfo } from "@/features/updates/updateController";
import type { UpdateSnapshot } from "@/features/updates/types";

export interface UpdateView extends UpdateSnapshot {
  provider: UpdateProviderInfo;
  /** Asks the release source because the user pressed something. */
  check: () => void;
  /** Downloads, verifies and installs the offered release. */
  install: () => void;
  /** Restarts into the installed update. */
  restart: () => void;
  /** "Later". */
  dismiss: () => void;
}

/** Current update state. Re-renders only when the update controller publishes a change. */
export function useUpdates(): UpdateView {
  const { updates } = useAppServices();
  const snapshot = useSyncExternalStore(updates.subscribe, updates.getSnapshot);

  const check = useCallback(() => void updates.check({ manual: true }), [updates]);
  const install = useCallback(() => void updates.install(), [updates]);
  const restart = useCallback(() => void updates.restart(), [updates]);
  const dismiss = useCallback(() => updates.dismiss(), [updates]);

  return { ...snapshot, provider: updates.provider, check, install, restart, dismiss };
}

/** Settings › Updates › Check on startup, applied once per launch. */
export function useUpdateStartup(): void {
  const { updates } = useAppServices();

  useEffect(() => {
    updates.start();
  }, [updates]);
}
