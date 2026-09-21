import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useAppServices } from "@/app/services";
import { useAppStore } from "@/app/store";
import type { TargetProviderInfo } from "@/features/target/targetController";
import type { TargetHistoryEntry, TargetSnapshot } from "@/features/target/types";

export interface TargetView extends Omit<TargetSnapshot, "history"> {
  provider: TargetProviderInfo;
  /** Starts an injection with the configured timeout. */
  inject: () => void;
  /** Cancels the injection in progress. */
  cancelInject: () => void;
  /** Ends the session, or dismisses a finished failure. */
  disconnect: () => void;
  /** Runs one detection pass. */
  detect: () => void;
}

/** Current target state. Re-renders only when the target controller publishes a change. */
export function useTarget(): TargetView {
  const { target } = useAppServices();
  const { settings } = useAppStore();
  const { status, detecting, session, request, result, cancelling, error, diagnostics } = useSyncExternalStore(
    target.subscribe,
    target.getSnapshot,
  );
  const { injectTimeoutMs } = settings.target;

  const inject = useCallback(() => void target.inject({ timeoutMs: injectTimeoutMs }), [target, injectTimeoutMs]);
  const cancelInject = useCallback(() => void target.cancelInject(), [target]);
  const disconnect = useCallback(() => void target.disconnect(), [target]);
  const detect = useCallback(() => void target.detect(), [target]);

  return {
    status,
    detecting,
    session,
    request,
    result,
    cancelling,
    error,
    diagnostics,
    provider: target.provider,
    inject,
    cancelInject,
    disconnect,
    detect,
  };
}

/** Target operations of this session, newest first. */
export function useTargetHistory(): readonly TargetHistoryEntry[] {
  const { target } = useAppServices();
  return useSyncExternalStore(target.subscribe, () => target.getSnapshot().history);
}

/** Settings › Target › Auto detect target and Auto inject, applied once per launch. */
export function useTargetStartup(): void {
  const { target } = useAppServices();

  useEffect(() => {
    void target.start();
  }, [target]);
}
