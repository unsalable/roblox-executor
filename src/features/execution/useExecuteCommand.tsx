import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAppServices } from "@/app/services";
import { useAppStore } from "@/app/store";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { buildExecutionInput, type ExecuteCommand, type ExecuteTarget } from "@/features/execution/executionInput";
import { executionModeLabel, type ExecutionInput } from "@/features/execution/types";

interface ExecuteCommandOptions {
  /** Reads the active script and the editor selection at the moment a command runs. */
  readTarget: () => ExecuteTarget;
  clearConsole: () => void;
}

export interface ExecuteActions {
  /** Builds the request now, then confirms (per settings) and submits it to the execution controller. */
  execute: (command: ExecuteCommand, options?: { clearConsole?: boolean }) => void;
  cancel: () => void;
  /** Render once, outside hidden containers. */
  dialog: ReactNode;
  isConfirming: boolean;
}

interface PendingExecution {
  input: ExecutionInput;
  clearConsole: boolean;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * Connects the Execute UI to the execution controller: resolves a command into
 * an input, applies the Executor settings (confirmation, clearing the console,
 * timeout) and submits. Validation, state and reporting stay in the controller.
 */
export function useExecuteCommand({ readTarget, clearConsole }: ExecuteCommandOptions): ExecuteActions {
  const { execution } = useAppServices();
  const { settings } = useAppStore();
  const [pending, setPending] = useState<PendingExecution | null>(null);
  const latest = useRef({ executor: settings.executor, readTarget, clearConsole });

  useEffect(() => {
    latest.current = { executor: settings.executor, readTarget, clearConsole };
  });

  const submit = useCallback(
    ({ input, clearConsole: clear }: PendingExecution) => {
      const { executor, clearConsole: clearOutput } = latest.current;
      const options = { timeoutMs: executor.timeoutMs };
      // Cleared only for a request that will start, so a rejection stays visible.
      if (clear && execution.validate(input, options) === null) clearOutput();
      execution.execute(input, options);
    },
    [execution],
  );

  const execute = useCallback(
    (command: ExecuteCommand, options?: { clearConsole?: boolean }) => {
      const { executor, readTarget: read } = latest.current;
      const request: PendingExecution = {
        input: buildExecutionInput(command, read()),
        clearConsole: options?.clearConsole === true || executor.clearConsoleBeforeRun,
      };

      if (executor.confirmBeforeRun && execution.validate(request.input, { timeoutMs: executor.timeoutMs }) === null) {
        setPending(request);
        return;
      }
      submit(request);
    },
    [execution, submit],
  );

  const cancel = useCallback(() => {
    execution.cancel();
  }, [execution]);

  const dialog = useMemo((): ReactNode => {
    if (!pending) return null;
    const { input } = pending;
    const source = input.source ?? "";
    const mode =
      input.mode === "selection"
        ? `${executionModeLabel.selection} · ${plural(source.split("\n").length, "line")}`
        : executionModeLabel["full-script"];

    return (
      <ConfirmDialog
        open
        title="Execute script?"
        confirmLabel="Execute"
        onCancel={() => setPending(null)}
        onConfirm={() => {
          setPending(null);
          submit(pending);
        }}
      >
        <p className="font-mono text-[13px] text-foreground">{input.script?.name}</p>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
          <dt className="text-subtle">Mode</dt>
          <dd className="text-foreground">{mode}</dd>
          <dt className="text-subtle">Provider</dt>
          <dd className="text-foreground">{execution.provider.label}</dd>
          {pending.clearConsole ? (
            <>
              <dt className="text-subtle">Console</dt>
              <dd className="text-foreground">Cleared before executing</dd>
            </>
          ) : null}
        </dl>
        <p className="mt-3 text-[11px] text-subtle">
          You can turn this confirmation off in Settings › Executor.
        </p>
      </ConfirmDialog>
    );
  }, [pending, submit, execution]);

  return useMemo(
    () => ({ execute, cancel, dialog, isConfirming: pending !== null }),
    [execute, cancel, dialog, pending],
  );
}
