import { isExecutionBusy, transitionExecution } from "@/features/execution/executionState";
import { appendHistory, createHistoryEntry, EXECUTION_HISTORY_LIMIT } from "@/features/execution/history";
import type {
  ExecutionContext,
  ExecutionError,
  ExecutionInput,
  ExecutionOutcome,
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
  ExecutionSnapshot,
} from "@/features/execution/types";
import { validateExecutionInput } from "@/features/execution/validation";
import { systemClock, type Clock, type TimerId } from "@/lib/clock";
import { createId } from "@/lib/id";
import { logger } from "@/lib/logger";

export type ExecutionLog = Pick<typeof logger, "debug" | "info" | "warn" | "error">;

export interface ExecutionControllerOptions {
  provider: ExecutionProvider;
  /** Whether the target is injected; only consulted when the provider requires a target. */
  isTargetReady?: () => boolean;
  clock?: Clock;
  createId?: () => string;
  historyLimit?: number;
  log?: ExecutionLog;
}

export interface ExecuteOptions {
  timeoutMs: number;
}

export type ExecutionSubmission =
  | { accepted: false; error: ExecutionError }
  | { accepted: true; executionId: string; result: Promise<ExecutionResult> };

export type CancelResult = "requested" | "already-requested" | "not-running" | "unsupported";

/** What the UI may know about the provider. */
export interface ExecutionProviderInfo {
  label: string;
  providerType?: string;
  requiresTarget: boolean;
  supportsCancel: boolean;
}

export interface ExecutionController {
  readonly provider: ExecutionProviderInfo;
  getSnapshot: () => ExecutionSnapshot;
  subscribe: (listener: () => void) => () => void;
  /** Validates without side effects. */
  validate: (input: ExecutionInput, options: ExecuteOptions) => ExecutionError | null;
  /** Validates and starts an execution. Never throws; the result promise never rejects. */
  execute: (input: ExecutionInput, options: ExecuteOptions) => ExecutionSubmission;
  /** Requests cancellation of the execution in progress. */
  cancel: () => CancelResult;
  /**
   * Ends the execution in progress as a failure, for a reason outside the
   * provider — the target going away, for example. Returns false when there is
   * nothing to interrupt.
   */
  interrupt: (error: ExecutionError) => boolean;
  /** Stops timers and any execution in progress without recording it. */
  dispose: () => void;
}

interface ActiveRun {
  context: ExecutionContext;
  timer: TimerId | null;
  cancelRequested: boolean;
  settled: boolean;
  resolve: (result: ExecutionResult) => void;
}

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

function errorData(error: ExecutionError): string {
  return error.details === undefined ? error.code : `${error.code}: ${error.details}`;
}

/**
 * The execution pipeline: validates each request independently of the UI,
 * snapshots it, runs it on the provider, enforces the timeout, handles
 * cancellation, records history and reports to the logger. Its snapshot is the
 * single source of truth for execution state.
 */
export function createExecutionController(options: ExecutionControllerOptions): ExecutionController {
  const { provider } = options;
  const clock = options.clock ?? systemClock;
  const newId = options.createId ?? createId;
  const isTargetReady = options.isTargetReady ?? (() => false);
  const historyLimit = options.historyLimit ?? EXECUTION_HISTORY_LIMIT;
  const log = options.log ?? logger;

  const listeners = new Set<() => void>();
  const issuedIds = new Set<string>();
  let active: ActiveRun | null = null;
  let snapshot: ExecutionSnapshot = {
    phase: "idle",
    context: null,
    result: null,
    cancelling: false,
    rejection: null,
    history: [],
  };

  const setSnapshot = (patch: Partial<ExecutionSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of [...listeners]) listener();
  };

  const validate = (input: ExecutionInput, { timeoutMs }: ExecuteOptions) =>
    validateExecutionInput(input, {
      phase: snapshot.phase,
      timeoutMs,
      providerLabel: provider.label,
      requiresTarget: provider.requiresTarget,
      targetReady: provider.requiresTarget && isTargetReady(),
    });

  const uniqueId = () => {
    let id = newId();
    for (let attempt = 1; issuedIds.has(id); attempt += 1) id = `${newId()}-${attempt}`;
    issuedIds.add(id);
    return id;
  };

  const requestProviderStop = (run: ActiveRun) => {
    if (!provider.cancel) return;
    const failed = (error: unknown) =>
      log.error(`Cancellation request failed: ${run.context.scriptName}`, describeError(error));
    try {
      void Promise.resolve(provider.cancel(run.context.executionId)).catch(failed);
    } catch (error) {
      failed(error);
    }
  };

  const markRunning = (run: ActiveRun) => {
    if (active !== run || run.settled || snapshot.phase !== "preparing") return;
    setSnapshot({ phase: transitionExecution(snapshot.phase, "running") });
  };

  const finish = (run: ActiveRun, outcome: ExecutionOutcome) => {
    // A provider may finish without announcing that it started running; success still means it ran.
    if (outcome.status === "success" && snapshot.phase === "preparing") {
      setSnapshot({ phase: transitionExecution(snapshot.phase, "running") });
    }

    run.settled = true;
    clock.clearTimeout(run.timer);
    run.timer = null;
    if (active === run) active = null;

    const { context } = run;
    const durationMs = Math.max(0, clock.now() - context.startedAt);
    const error = outcome.status === "error" ? outcome.error : null;
    const output = outcome.status === "cancelled" ? [] : (outcome.output ?? []);
    const result: ExecutionResult = Object.freeze({
      executionId: context.executionId,
      success: outcome.status === "success",
      cancelled: outcome.status === "cancelled",
      durationMs,
      output: Object.freeze([...output]),
      error,
    });

    setSnapshot({
      phase: transitionExecution(snapshot.phase, outcome.status),
      result,
      cancelling: false,
      rejection: null,
      history: appendHistory(snapshot.history, createHistoryEntry(context, result), historyLimit),
    });

    const name = context.scriptName;
    if (outcome.status === "success") {
      const summary = result.output.join(" ");
      log.info(`Execution completed: ${name} (${durationMs} ms)`, summary === "" ? undefined : summary);
    } else if (outcome.status === "cancelled") {
      log.warn(`Execution cancelled: ${name} (${durationMs} ms)`);
    } else {
      log.error(`Execution failed: ${name} — ${outcome.error.message}`, errorData(outcome.error));
    }

    run.resolve(result);
  };

  const settle = (run: ActiveRun, outcome: ExecutionOutcome) => {
    if (run.settled) {
      log.debug(`Ignored a late provider result for execution ${run.context.executionId}`);
      return;
    }
    finish(run, outcome);
  };

  const onTimeout = (run: ActiveRun) => {
    if (run.settled) return;
    run.timer = null;
    const { timeoutMs } = run.context;
    requestProviderStop(run);
    finish(run, {
      status: "error",
      error: {
        code: "EXECUTION_TIMEOUT",
        message: `Execution timed out after ${timeoutMs} ms.`,
        details: run.cancelRequested
          ? "Cancellation had been requested, but the provider did not stop in time."
          : "The provider did not finish in time; cancellation was requested.",
      },
    });
  };

  const execute = (input: ExecutionInput, executeOptions: ExecuteOptions): ExecutionSubmission => {
    const rejection = validate(input, executeOptions);
    if (rejection) {
      setSnapshot({ rejection });
      if (rejection.code === "EXECUTION_ALREADY_RUNNING") log.warn(`Execution not started: ${rejection.message}`);
      else log.error(`Execution failed: ${rejection.message}`, errorData(rejection));
      return { accepted: false, error: rejection };
    }

    // Validation guarantees these; the checks narrow the types.
    if (input.script === null || input.source === null) throw new Error("Unreachable: validated input is incomplete");

    const executionId = uniqueId();
    const startedAt = clock.now();
    const request: ExecutionRequest = Object.freeze({
      executionId,
      scriptId: input.script.id,
      scriptName: input.script.name,
      source: input.source,
      mode: input.mode,
      createdAt: startedAt,
    });
    const context: ExecutionContext = Object.freeze({
      executionId,
      provider: provider.label,
      mode: request.mode,
      scriptId: request.scriptId,
      scriptName: request.scriptName,
      startedAt,
      timeoutMs: executeOptions.timeoutMs,
    });

    let resolve!: (result: ExecutionResult) => void;
    const result = new Promise<ExecutionResult>((done) => {
      resolve = done;
    });
    const run: ActiveRun = { context, timer: null, cancelRequested: false, settled: false, resolve };
    active = run;

    setSnapshot({
      phase: transitionExecution(snapshot.phase, "preparing"),
      context,
      result: null,
      cancelling: false,
      rejection: null,
    });
    log.info(`Execution started: ${request.scriptName}${request.mode === "selection" ? " (selection)" : ""}`);

    run.timer = clock.setTimeout(() => onTimeout(run), context.timeoutMs);

    let pending: Promise<ExecutionOutcome>;
    try {
      pending = provider.execute(request, { onRunning: () => markRunning(run) });
    } catch (error) {
      pending = Promise.reject(error);
    }
    Promise.resolve(pending).then(
      (outcome) => settle(run, outcome),
      (error: unknown) =>
        settle(run, {
          status: "error",
          error: {
            code: "PROVIDER_ERROR",
            message: "The execution provider failed.",
            details: describeError(error),
            ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
          },
        }),
    );

    return { accepted: true, executionId, result };
  };

  const cancel = (): CancelResult => {
    const run = active;
    if (!run || run.settled || !isExecutionBusy(snapshot.phase)) return "not-running";
    if (!provider.cancel) return "unsupported";
    if (run.cancelRequested) return "already-requested";

    run.cancelRequested = true;
    setSnapshot({ cancelling: true });
    requestProviderStop(run);
    return "requested";
  };

  const interrupt = (error: ExecutionError): boolean => {
    const run = active;
    if (!run || run.settled || !isExecutionBusy(snapshot.phase)) return false;
    requestProviderStop(run);
    finish(run, { status: "error", error });
    return true;
  };

  const dispose = () => {
    listeners.clear();
    const run = active;
    active = null;
    if (!run || run.settled) return;

    run.settled = true;
    clock.clearTimeout(run.timer);
    run.timer = null;
    requestProviderStop(run);
    run.resolve(
      Object.freeze({
        executionId: run.context.executionId,
        success: false,
        cancelled: true,
        durationMs: Math.max(0, clock.now() - run.context.startedAt),
        output: [],
        error: null,
      }),
    );
  };

  return {
    provider: Object.freeze({
      label: provider.label,
      requiresTarget: provider.requiresTarget,
      supportsCancel: typeof provider.cancel === "function",
      ...(provider.providerType === undefined ? {} : { providerType: provider.providerType }),
    }),
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    validate,
    execute,
    cancel,
    interrupt,
    dispose,
  };
}
