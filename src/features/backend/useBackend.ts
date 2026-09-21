import { useEffect, useSyncExternalStore } from "react";
import { useAppServices } from "@/app/services";
import type { BackendController, BackendInfo } from "@/features/backend/backendController";
import type { BackendSnapshot } from "@/features/backend/types";

/**
 * React's view of the backend controller. Components read the backend's state
 * through this hook and never hold a copy, so the Developer Status panel, the
 * command palette and the status surfaces all read the same lifecycle.
 *
 * The UI never sees the backend implementation: it gets the descriptor the
 * controller froze, the capabilities it derived and the health it read.
 */

export interface BackendView extends BackendSnapshot {
  backend: BackendInfo;
  controller: BackendController;
}

export function useBackend(): BackendView {
  const { backend } = useAppServices();
  const snapshot = useSyncExternalStore(backend.subscribe, backend.getSnapshot);
  return { ...snapshot, backend: backend.backend, controller: backend };
}

/** Settings › Developer › Auto start backend, applied once per launch. */
export function useBackendStartup(): void {
  const { backend } = useAppServices();

  useEffect(() => {
    void backend.startup();
  }, [backend]);
}
