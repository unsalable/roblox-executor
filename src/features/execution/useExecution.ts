import { useSyncExternalStore } from "react";
import { useAppServices } from "@/app/services";
import type { ExecutionProviderInfo } from "@/features/execution/executionController";
import type { ExecutionHistoryEntry, ExecutionSnapshot } from "@/features/execution/types";

export interface ExecutionView extends Omit<ExecutionSnapshot, "history"> {
  provider: ExecutionProviderInfo;
}

/** Current execution state. Re-renders only when the execution controller publishes a change. */
export function useExecution(): ExecutionView {
  const { execution } = useAppServices();
  const { phase, context, result, cancelling, rejection } = useSyncExternalStore(
    execution.subscribe,
    execution.getSnapshot,
  );
  return { phase, context, result, cancelling, rejection, provider: execution.provider };
}

/** Finished executions of this session, newest first. */
export function useExecutionHistory(): readonly ExecutionHistoryEntry[] {
  const { execution } = useAppServices();
  return useSyncExternalStore(execution.subscribe, () => execution.getSnapshot().history);
}
