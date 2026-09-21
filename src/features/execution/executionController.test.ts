import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createExecutionController, type ExecutionLog } from "@/features/execution/executionController";
import { buildExecutionInput } from "@/features/execution/executionInput";
import { appendHistory, EXECUTION_HISTORY_LIMIT } from "@/features/execution/history";
import {
  createLocalTestExecutionProvider,
  type LocalTestExecutionScenario,
} from "@/features/execution/providers/LocalTestExecutionProvider";
import type {
  ExecutionHistoryEntry,
  ExecutionInput,
  ExecutionOutcome,
  ExecutionPhase,
  ExecutionProvider,
  ExecutionRequest,
} from "@/features/execution/types";
import { createFakeClock } from "@/lib/testing/fakeClock";

interface LogLine {
  level: keyof ExecutionLog;
  message: string;
  data: unknown;
}

function recordingLog(): ExecutionLog & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  const at = (level: keyof ExecutionLog) => (message: string, data?: unknown) => {
    lines.push({ level, message, data });
  };
  return { lines, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

const PREPARING_MS = 100;
const RUNNING_MS = 400;
const DEFAULT_OPTIONS = { timeoutMs: 5000 };

interface SetupOptions {
  scenario?: LocalTestExecutionScenario;
  historyLimit?: number;
  provider?: (mock: ReturnType<typeof createLocalTestExecutionProvider>) => ExecutionProvider;
  createId?: () => string;
  isTargetReady?: () => boolean;
}

function setup(options: SetupOptions = {}) {
  const clock = createFakeClock();
  const log = recordingLog();
  const mock = createLocalTestExecutionProvider({
    clock,
    preparingMs: PREPARING_MS,
    runningMs: RUNNING_MS,
    slowRunningMs: 20_000,
    scenario: options.scenario ?? "success",
  });
  const received: ExecutionRequest[] = [];
  const base = options.provider ? options.provider(mock) : mock;
  const provider: ExecutionProvider = {
    ...base,
    execute: (request, hooks) => {
      received.push(request);
      return base.execute(request, hooks);
    },
  };
  let count = 0;
  const controller = createExecutionController({
    provider,
    clock,
    log,
    createId: options.createId ?? (() => `exec-${++count}`),
    ...(options.historyLimit === undefined ? {} : { historyLimit: options.historyLimit }),
    isTargetReady: options.isTargetReady ?? (() => true),
  });

  /** Phase changes after the initial idle. */
  const phases: ExecutionPhase[] = [];
  let last = controller.getSnapshot().phase;
  controller.subscribe(() => {
    const { phase } = controller.getSnapshot();
    if (phase !== last) phases.push(phase);
    last = phase;
  });

  return { clock, log, mock, received, controller, phases };
}

const script = { id: "script-1", name: "Main.lua" };
const fullScript = (source = 'print("hello")\n'): ExecutionInput => ({ mode: "full-script", script, source });
const selection = (source: string): ExecutionInput => ({ mode: "selection", script, source });

/** A provider whose executions end only when the test says so; cancel requests are recorded and ignored. */
function manualProvider() {
  const pending = new Map<string, (outcome: ExecutionOutcome) => void>();
  const cancels: string[] = [];
  const provider: ExecutionProvider = {
    label: "Manual",
    requiresTarget: false,
    execute: (request, hooks) =>
      new Promise((resolve) => {
        hooks.onRunning();
        pending.set(request.executionId, resolve);
      }),
    cancel: (executionId) => {
      cancels.push(executionId);
    },
  };
  const finish = (executionId: string, outcome: ExecutionOutcome) => pending.get(executionId)?.(outcome);
  return { provider, cancels, finish };
}

describe("execution validation", () => {
  test("no active script is rejected without starting anything", async () => {
    const { controller, log, clock, mock, phases } = setup();
    const submission = controller.execute({ mode: "full-script", script: null, source: null }, DEFAULT_OPTIONS);

    assert.equal(submission.accepted, false);
    assert.equal(submission.accepted ? null : submission.error.code, "NO_ACTIVE_SCRIPT");
    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.phase, "idle");
    assert.equal(snapshot.rejection?.code, "NO_ACTIVE_SCRIPT");
    assert.deepEqual(snapshot.history, []);
    assert.deepEqual(phases, []);
    assert.equal(clock.pendingTimers(), 0);
    assert.equal(mock.activeCount(), 0);
    assert.ok(log.lines.some((line) => line.level === "error" && line.message === "Execution failed: No active script."));
  });

  test("an empty or whitespace-only selection is rejected", () => {
    const { controller } = setup();
    for (const text of ["", "   ", "\n\t  \n"]) {
      const submission = controller.execute(selection(text), DEFAULT_OPTIONS);
      assert.equal(submission.accepted ? null : submission.error.code, "EMPTY_SELECTION", JSON.stringify(text));
    }
    assert.equal(controller.getSnapshot().phase, "idle");
  });

  test("a second execution while one is running is rejected and does not disturb it", async () => {
    const { controller, clock, log } = setup();
    const first = controller.execute(fullScript(), DEFAULT_OPTIONS);
    assert.equal(first.accepted, true);

    await clock.advance(PREPARING_MS + 10);
    assert.equal(controller.getSnapshot().phase, "running");

    const second = controller.execute(fullScript("print(2)"), DEFAULT_OPTIONS);
    assert.equal(second.accepted ? null : second.error.code, "EXECUTION_ALREADY_RUNNING");
    assert.equal(controller.getSnapshot().phase, "running");
    assert.ok(log.lines.some((line) => line.level === "warn" && line.message.startsWith("Execution not started")));

    await clock.advance(RUNNING_MS);
    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.phase, "success");
    assert.equal(snapshot.history.length, 1);
    assert.equal(snapshot.rejection, null, "a finished execution clears the older rejection");
  });

  test("malformed requests are rejected as INVALID_REQUEST", () => {
    const { controller } = setup();
    const cases: [unknown, number][] = [
      [null, 5000],
      [{ mode: "everything", script, source: "x" }, 5000],
      [{ mode: "full-script", script, source: 42 }, 5000],
      [{ mode: "full-script", script: { id: "", name: "Main.lua" }, source: "x" }, 5000],
      [fullScript(), 0],
      [fullScript(), -1],
      [fullScript(), Number.NaN],
    ];
    for (const [input, timeoutMs] of cases) {
      const submission = controller.execute(input as ExecutionInput, { timeoutMs });
      assert.equal(submission.accepted ? null : submission.error.code, "INVALID_REQUEST", JSON.stringify(input));
    }
    assert.equal(controller.getSnapshot().phase, "idle");
  });

  test("validate() has no side effects", () => {
    const { controller, log } = setup();
    const before = controller.getSnapshot();
    assert.equal(controller.validate({ mode: "full-script", script: null, source: null }, DEFAULT_OPTIONS)?.code, "NO_ACTIVE_SCRIPT");
    assert.equal(controller.validate(fullScript(), DEFAULT_OPTIONS), null);
    assert.equal(controller.getSnapshot(), before);
    assert.equal(log.lines.length, 0);
  });

  test("a provider that requires a target is refused until the target is injected", async () => {
    let injected = false;
    const { controller, clock } = setup({ isTargetReady: () => injected });

    const refused = controller.execute(fullScript(), DEFAULT_OPTIONS);
    assert.equal(refused.accepted ? null : refused.error.code, "TARGET_NOT_READY");
    assert.equal(controller.provider.requiresTarget, true);

    injected = true;
    const accepted = controller.execute(fullScript(), DEFAULT_OPTIONS);
    assert.equal(accepted.accepted, true);
    assert.equal(controller.getSnapshot().rejection, null, "starting an execution clears the rejection");
    await clock.advance(PREPARING_MS + RUNNING_MS);
    assert.equal(controller.getSnapshot().phase, "success");
  });

  test("a target that goes away again refuses the next request", async () => {
    let injected = true;
    const { controller, clock } = setup({ isTargetReady: () => injected });

    assert.equal(controller.execute(fullScript(), DEFAULT_OPTIONS).accepted, true);
    await clock.advance(PREPARING_MS + RUNNING_MS);
    assert.equal(controller.getSnapshot().phase, "success");

    injected = false;
    const refused = controller.execute(fullScript(), DEFAULT_OPTIONS);
    assert.equal(refused.accepted ? null : refused.error.code, "TARGET_NOT_READY");
  });

  test("a provider that needs no target runs while there is none", () => {
    const { controller } = setup({
      provider: (mock) => ({ ...mock, requiresTarget: false }),
      isTargetReady: () => false,
    });
    assert.equal(controller.provider.requiresTarget, false);
    assert.equal(controller.execute(fullScript(), DEFAULT_OPTIONS).accepted, true);
  });
});

describe("execution lifecycle", () => {
  test("a normal script goes preparing → running → success", async () => {
    const { controller, clock, log, phases, mock } = setup();
    const submission = controller.execute(fullScript(), DEFAULT_OPTIONS);
    assert.ok(submission.accepted);

    assert.equal(controller.getSnapshot().phase, "preparing");
    assert.equal(controller.getSnapshot().context?.provider, "Local Test Execution");
    await clock.advance(PREPARING_MS - 1);
    assert.equal(controller.getSnapshot().phase, "preparing");
    await clock.advance(1);
    assert.equal(controller.getSnapshot().phase, "running");
    await clock.advance(RUNNING_MS);

    const result = await submission.result;
    assert.deepEqual(phases, ["preparing", "running", "success"]);
    assert.equal(result.success, true);
    assert.equal(result.cancelled, false);
    assert.equal(result.error, null);
    assert.equal(result.durationMs, PREPARING_MS + RUNNING_MS);
    assert.ok(result.output.some((line) => line.includes("received, not evaluated")));
    assert.equal(controller.getSnapshot().result, result);

    assert.deepEqual(
      log.lines.filter((line) => line.level !== "debug").map((line) => [line.level, line.message]),
      [
        ["info", "Execution started: Main.lua"],
        ["info", `Execution completed: Main.lua (${PREPARING_MS + RUNNING_MS} ms)`],
      ],
    );
    assert.equal(clock.pendingTimers(), 0, "the timeout timer is cleared");
    assert.equal(mock.activeCount(), 0);
  });

  test("an empty script fails with a structured error", async () => {
    const { controller, clock, log, phases } = setup();
    const submission = controller.execute(fullScript("  \n\n"), DEFAULT_OPTIONS);
    assert.ok(submission.accepted);
    await clock.advance(PREPARING_MS);

    const result = await submission.result;
    assert.deepEqual(phases, ["preparing", "error"]);
    assert.equal(result.success, false);
    assert.equal(result.error?.code, "EMPTY_SOURCE");
    assert.equal(result.error?.message, "Script is empty.");
    assert.equal(result.error?.stack, undefined, "no stack trace is invented");

    const [entry] = controller.getSnapshot().history;
    assert.equal(entry?.status, "error");
    assert.deepEqual(entry?.error, { code: "EMPTY_SOURCE", message: "Script is empty." });
    assert.ok(log.lines.some((line) => line.level === "error" && line.message === "Execution failed: Main.lua — Script is empty."));
  });

  test("the error scenario reports a provider error", async () => {
    const { controller, clock } = setup({ scenario: "error" });
    const submission = controller.execute(fullScript(), DEFAULT_OPTIONS);
    assert.ok(submission.accepted);
    await clock.advance(PREPARING_MS + RUNNING_MS);
    const result = await submission.result;
    assert.equal(result.error?.code, "PROVIDER_ERROR");
    assert.equal(controller.getSnapshot().phase, "error");
  });

  test("a provider that rejects or throws becomes a PROVIDER_ERROR", async () => {
    for (const failure of ["reject", "throw"] as const) {
      const { controller, clock } = setup({
        provider: (mock) => ({
          ...mock,
          execute: () => {
            if (failure === "throw") throw new Error("boom");
            return Promise.reject(new Error("boom"));
          },
        }),
      });
      const submission = controller.execute(fullScript(), DEFAULT_OPTIONS);
      assert.ok(submission.accepted);
      await clock.flush();
      const result = await submission.result;
      assert.equal(result.error?.code, "PROVIDER_ERROR", failure);
      assert.equal(result.error?.details, "boom");
      assert.equal(controller.getSnapshot().phase, "error");
      assert.equal(clock.pendingTimers(), 0);
    }
  });

  test("success without an explicit running signal still passes through running", async () => {
    const { controller, clock, phases } = setup({
      provider: (mock) => ({ ...mock, execute: () => Promise.resolve({ status: "success", output: [] }) }),
    });
    assert.ok(controller.execute(fullScript(), DEFAULT_OPTIONS).accepted);
    await clock.flush();
    assert.deepEqual(phases, ["preparing", "running", "success"]);
  });

  test("selection mode sends only the selected text and keeps the script identity", async () => {
    const { controller, clock, received, log } = setup();
    assert.ok(controller.execute(selection("print(1)"), DEFAULT_OPTIONS).accepted);
    await clock.advance(PREPARING_MS + RUNNING_MS);

    assert.equal(received.length, 1);
    assert.equal(received[0]?.source, "print(1)");
    assert.equal(received[0]?.mode, "selection");
    assert.equal(received[0]?.scriptId, "script-1");
    assert.equal(received[0]?.scriptName, "Main.lua");
    assert.equal(controller.getSnapshot().history[0]?.mode, "selection");
    assert.ok(log.lines.some((line) => line.message === "Execution started: Main.lua (selection)"));
  });

  test("source text never reaches the log", async () => {
    const { controller, clock, log } = setup();
    const marker = "UNIQUE_SOURCE_MARKER_7f3a";
    controller.execute(fullScript(`print("${marker}")`), DEFAULT_OPTIONS);
    await clock.advance(PREPARING_MS + RUNNING_MS);
    controller.execute(selection(`-- ${marker}`), { timeoutMs: 50 });
    await clock.advance(50);

    for (const line of log.lines) {
      assert.ok(!`${line.message} ${JSON.stringify(line.data) ?? ""}`.includes(marker), line.message);
    }
  });

  test("execution ids are unique, even when the id source repeats", async () => {
    const { controller, clock } = setup({ createId: () => "same-id" });
    const ids = new Set<string>();
    for (let index = 0; index < 5; index += 1) {
      const submission = controller.execute(fullScript(), DEFAULT_OPTIONS);
      assert.ok(submission.accepted);
      ids.add(submission.executionId);
      await clock.advance(PREPARING_MS + RUNNING_MS);
    }
    assert.equal(ids.size, 5);
  });

  test("the default id source generates distinct ids", async () => {
    const clock = createFakeClock();
    const controller = createExecutionController({
      provider: createLocalTestExecutionProvider({ clock, preparingMs: 1, runningMs: 1 }),
      clock,
      log: recordingLog(),
      isTargetReady: () => true,
    });
    const ids = new Set<string>();
    for (let index = 0; index < 20; index += 1) {
      const submission = controller.execute(fullScript(), DEFAULT_OPTIONS);
      assert.ok(submission.accepted);
      ids.add(submission.executionId);
      await clock.advance(2);
    }
    assert.equal(ids.size, 20);
  });
});

describe("execution interruption", () => {
  test("interrupt ends the execution in progress with the given error", async () => {
    const { controller, clock, log } = setup({ scenario: "slow" });
    const submission = controller.execute(fullScript(), DEFAULT_OPTIONS);
    assert.ok(submission.accepted);
    await clock.advance(PREPARING_MS + 10);

    assert.equal(
      controller.interrupt({ code: "TARGET_DISCONNECTED", message: "The target was lost." }),
      true,
    );
    const result = await submission.result;
    assert.equal(result.error?.code, "TARGET_DISCONNECTED");
    assert.equal(controller.getSnapshot().phase, "error");
    assert.equal(controller.getSnapshot().history[0]?.error?.code, "TARGET_DISCONNECTED");
    assert.ok(log.lines.some((line) => line.level === "error" && line.message.startsWith("Execution failed")));

    // The provider answering afterwards cannot revive the execution.
    await clock.advance(20_000);
    assert.equal(controller.getSnapshot().phase, "error");
  });

  test("interrupt does nothing when no execution is running", () => {
    const { controller } = setup();
    assert.equal(controller.interrupt({ code: "TARGET_DISCONNECTED", message: "The target was lost." }), false);
    assert.equal(controller.getSnapshot().phase, "idle");
    assert.deepEqual(controller.getSnapshot().history, []);
  });
});

describe("execution cancellation", () => {
  test("cancelling a running execution", async () => {
    const { controller, clock, log, mock, phases } = setup({ scenario: "slow" });
    const submission = controller.execute(fullScript(), DEFAULT_OPTIONS);
    assert.ok(submission.accepted);
    await clock.advance(PREPARING_MS + 150);
    assert.equal(controller.getSnapshot().phase, "running");

    assert.equal(controller.cancel(), "requested");
    assert.equal(controller.getSnapshot().cancelling, true);
    await clock.flush();

    const result = await submission.result;
    assert.deepEqual(phases, ["preparing", "running", "cancelled"]);
    assert.equal(result.cancelled, true);
    assert.equal(result.success, false);
    assert.equal(result.error, null);
    assert.equal(result.durationMs, PREPARING_MS + 150);
    assert.equal(controller.getSnapshot().cancelling, false);
    assert.equal(controller.getSnapshot().history[0]?.status, "cancelled");
    assert.ok(log.lines.some((line) => line.level === "warn" && line.message === `Execution cancelled: Main.lua (${PREPARING_MS + 150} ms)`));
    assert.equal(mock.activeCount(), 0);
    assert.equal(clock.pendingTimers(), 0);
  });

  test("cancelling while preparing", async () => {
    const { controller, clock, phases } = setup();
    assert.ok(controller.execute(fullScript(), DEFAULT_OPTIONS).accepted);
    assert.equal(controller.cancel(), "requested");
    await clock.flush();
    assert.deepEqual(phases, ["preparing", "cancelled"]);
    assert.equal(clock.pendingTimers(), 0);
  });

  test("cancel after completion does nothing", async () => {
    const { controller, clock, log } = setup();
    assert.ok(controller.execute(fullScript(), DEFAULT_OPTIONS).accepted);
    await clock.advance(PREPARING_MS + RUNNING_MS);
    const before = controller.getSnapshot();

    assert.equal(controller.cancel(), "not-running");
    assert.equal(controller.getSnapshot(), before);
    assert.equal(before.phase, "success");
    assert.equal(before.history.length, 1);
    assert.ok(!log.lines.some((line) => line.level === "warn"));
  });

  test("cancel with nothing started does nothing", () => {
    const { controller } = setup();
    assert.equal(controller.cancel(), "not-running");
    assert.equal(controller.getSnapshot().phase, "idle");
  });

  test("a duplicate cancel is ignored and records one history entry", async () => {
    const { controller, clock } = setup({ scenario: "slow" });
    assert.ok(controller.execute(fullScript(), DEFAULT_OPTIONS).accepted);
    await clock.advance(PREPARING_MS + 10);

    assert.equal(controller.cancel(), "requested");
    assert.equal(controller.cancel(), "already-requested");
    await clock.flush();
    assert.equal(controller.cancel(), "not-running");

    const { history, phase } = controller.getSnapshot();
    assert.equal(phase, "cancelled");
    assert.equal(history.length, 1);
  });

  test("an execution that completes despite a cancel request is reported as completed", async () => {
    const manual = manualProvider();
    const { controller, clock } = setup({ provider: () => manual.provider });
    const submission = controller.execute(fullScript(), DEFAULT_OPTIONS);
    assert.ok(submission.accepted);

    assert.equal(controller.cancel(), "requested");
    assert.deepEqual(manual.cancels, [submission.executionId]);
    manual.finish(submission.executionId, { status: "success", output: ["done"] });
    await clock.flush();

    assert.equal(controller.getSnapshot().phase, "success");
    assert.equal((await submission.result).cancelled, false);
  });

  test("a provider without cancel support reports unsupported", async () => {
    const { controller, clock } = setup({
      provider: (mock) => ({ label: mock.label, requiresTarget: false, execute: mock.execute }),
    });
    assert.equal(controller.provider.supportsCancel, false);
    assert.ok(controller.execute(fullScript(), DEFAULT_OPTIONS).accepted);
    assert.equal(controller.cancel(), "unsupported");
    await clock.advance(PREPARING_MS + RUNNING_MS);
    assert.equal(controller.getSnapshot().phase, "success");
  });

  test("the provider can stop an execution itself", async () => {
    const { controller, clock } = setup({ scenario: "cancel" });
    assert.ok(controller.execute(fullScript(), DEFAULT_OPTIONS).accepted);
    await clock.advance(PREPARING_MS + RUNNING_MS);
    assert.equal(controller.getSnapshot().phase, "cancelled");
  });
});

describe("execution timeout", () => {
  test("an execution that finishes within the timeout succeeds and clears the timer", async () => {
    const { controller, clock } = setup();
    assert.ok(controller.execute(fullScript(), { timeoutMs: 1000 }).accepted);
    await clock.advance(PREPARING_MS + RUNNING_MS);
    assert.equal(controller.getSnapshot().phase, "success");
    assert.equal(clock.pendingTimers(), 0);
    await clock.advance(5000);
    assert.equal(controller.getSnapshot().phase, "success");
    assert.equal(controller.getSnapshot().history.length, 1);
  });

  test("an execution that exceeds the timeout fails with EXECUTION_TIMEOUT and is stopped", async () => {
    const { controller, clock, log, mock, phases } = setup({ scenario: "slow" });
    const submission = controller.execute(fullScript(), { timeoutMs: 1000 });
    assert.ok(submission.accepted);

    await clock.advance(999);
    assert.equal(controller.getSnapshot().phase, "running");
    await clock.advance(1);

    const result = await submission.result;
    assert.deepEqual(phases, ["preparing", "running", "error"]);
    assert.equal(result.error?.code, "EXECUTION_TIMEOUT");
    assert.equal(result.error?.message, "Execution timed out after 1000 ms.");
    assert.equal(result.durationMs, 1000);
    assert.equal(controller.getSnapshot().history[0]?.error?.code, "EXECUTION_TIMEOUT");
    assert.ok(log.lines.some((line) => line.level === "error" && line.message.includes("timed out after 1000 ms")));
    assert.equal(mock.activeCount(), 0, "the provider was asked to stop");
    assert.equal(clock.pendingTimers(), 0);
  });

  test("after a timeout, a late provider result is ignored and a new execution can start", async () => {
    const manual = manualProvider();
    const { controller, clock, log } = setup({ provider: () => manual.provider });
    const timedOut = controller.execute(fullScript(), { timeoutMs: 300 });
    assert.ok(timedOut.accepted);
    await clock.advance(300);

    assert.equal(controller.getSnapshot().phase, "error");
    assert.deepEqual(manual.cancels, [timedOut.executionId]);

    manual.finish(timedOut.executionId, { status: "success", output: [] });
    await clock.flush();
    assert.equal(controller.getSnapshot().phase, "error");
    assert.equal(controller.getSnapshot().history.length, 1);
    assert.ok(log.lines.some((line) => line.level === "debug" && line.message.includes("late provider result")));

    const next = controller.execute(fullScript(), { timeoutMs: 300 });
    assert.ok(next.accepted);
    manual.finish(next.executionId, { status: "success", output: [] });
    await clock.flush();
    assert.equal(controller.getSnapshot().phase, "success");
    assert.equal(controller.getSnapshot().history.length, 2);
    assert.equal(clock.pendingTimers(), 0);
  });

  test("dispose stops the execution in progress and its timers", async () => {
    const { controller, clock, mock } = setup({ scenario: "slow" });
    const submission = controller.execute(fullScript(), DEFAULT_OPTIONS);
    assert.ok(submission.accepted);
    await clock.advance(PREPARING_MS + 10);

    controller.dispose();
    assert.equal((await submission.result).cancelled, true);
    assert.equal(mock.activeCount(), 0);
    assert.equal(clock.pendingTimers(), 0);
  });
});

describe("execution history", () => {
  test("records successful, failed and cancelled executions, newest first, without source", async () => {
    const { controller, clock, mock } = setup();
    const source = "print('history-marker')";

    controller.execute(fullScript(source), DEFAULT_OPTIONS);
    await clock.advance(PREPARING_MS + RUNNING_MS);
    controller.execute(fullScript(""), DEFAULT_OPTIONS);
    await clock.advance(PREPARING_MS);
    mock.setScenario("slow");
    controller.execute(selection(source), DEFAULT_OPTIONS);
    await clock.advance(PREPARING_MS + 50);
    controller.cancel();
    await clock.flush();

    const { history } = controller.getSnapshot();
    assert.deepEqual(
      history.map((entry) => [entry.executionId, entry.status, entry.mode, entry.durationMs]),
      [
        ["exec-3", "cancelled", "selection", PREPARING_MS + 50],
        ["exec-2", "error", "full-script", PREPARING_MS],
        ["exec-1", "success", "full-script", PREPARING_MS + RUNNING_MS],
      ],
    );

    const [cancelled] = history;
    assert.equal(cancelled?.scriptId, "script-1");
    assert.equal(cancelled?.scriptName, "Main.lua");
    assert.equal(cancelled?.provider, "Local Test Execution");
    assert.equal(typeof cancelled?.startedAt, "number");
    assert.equal(cancelled?.error, null);
    for (const entry of history) assert.ok(!("source" in entry));
    assert.ok(!JSON.stringify(history).includes("history-marker"));
  });

  test("rejected requests are not recorded", () => {
    const { controller } = setup();
    controller.execute({ mode: "full-script", script: null, source: null }, DEFAULT_OPTIONS);
    controller.execute(selection(" "), DEFAULT_OPTIONS);
    assert.equal(controller.getSnapshot().history.length, 0);
  });

  test("keeps only the newest entries beyond the limit", async () => {
    const { controller, clock } = setup({ historyLimit: 3 });
    for (let index = 0; index < 5; index += 1) {
      controller.execute(fullScript(), DEFAULT_OPTIONS);
      await clock.advance(PREPARING_MS + RUNNING_MS);
    }
    assert.deepEqual(
      controller.getSnapshot().history.map((entry) => entry.executionId),
      ["exec-5", "exec-4", "exec-3"],
    );
  });

  test("the default limit is 100 entries", () => {
    const entry = (index: number): ExecutionHistoryEntry => ({
      executionId: `e${index}`,
      scriptId: "s",
      scriptName: "Main.lua",
      mode: "full-script",
      provider: "Local Test Execution",
      status: "success",
      durationMs: 1,
      startedAt: index,
      error: null,
    });
    let history: readonly ExecutionHistoryEntry[] = [];
    for (let index = 1; index <= 105; index += 1) history = appendHistory(history, entry(index));

    assert.equal(EXECUTION_HISTORY_LIMIT, 100);
    assert.equal(history.length, 100);
    assert.equal(history[0]?.executionId, "e105");
    assert.equal(history[99]?.executionId, "e6");
  });
});

describe("execution source snapshot", () => {
  test("editor changes after the execution began do not reach the running request", async () => {
    const { controller, clock, received } = setup();
    const editor = { content: 'print("original")', selection: "" };

    const input = buildExecutionInput("auto", {
      script: { id: script.id, name: script.name, content: editor.content },
      selectedText: editor.selection,
    });
    const submission = controller.execute(input, DEFAULT_OPTIONS);
    assert.ok(submission.accepted);

    editor.content = 'print("typed while running")';
    input.source = "mutated input";
    input.script = { id: "other", name: "Other.lua" };

    await clock.advance(PREPARING_MS + RUNNING_MS);
    assert.equal(controller.getSnapshot().phase, "success");
    assert.equal(received[0]?.source, 'print("original")');
    assert.equal(received[0]?.scriptName, "Main.lua");
    assert.equal(controller.getSnapshot().history[0]?.scriptName, "Main.lua");
  });

  test("the request and its context are frozen", () => {
    const { controller, received } = setup();
    assert.ok(controller.execute(fullScript("print(1)"), DEFAULT_OPTIONS).accepted);
    const request = received[0]!;

    assert.ok(Object.isFrozen(request));
    assert.ok(Object.isFrozen(controller.getSnapshot().context));
    assert.throws(() => {
      (request as { source: string }).source = "changed";
    }, TypeError);
    assert.equal(request.source, "print(1)");
  });
});
