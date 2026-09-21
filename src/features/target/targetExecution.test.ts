import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createExecutionController } from "@/features/execution/executionController";
import { createLocalTestExecutionProvider } from "@/features/execution/providers/LocalTestExecutionProvider";
import type { ExecutionInput } from "@/features/execution/types";
import { createLocalTestTargetProvider } from "@/features/target/providers/LocalTestTargetProvider";
import { createTargetController } from "@/features/target/targetController";
import { isTargetInjected } from "@/features/target/targetState";
import { createFakeClock } from "@/lib/testing/fakeClock";

/**
 * The two controllers as `app/services.tsx` wires them: execution is gated on
 * an injected target, and an execution in flight cannot outlive the target it
 * runs on.
 */

const DETECT_MS = 20;
const INJECT_MS = 50;
const DISCONNECT_MS = 15;
const PREPARING_MS = 30;
const RUNNING_MS = 120;

const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const script: ExecutionInput = {
  mode: "full-script",
  script: { id: "script-1", name: "Main.lua" },
  source: 'print("hello")\n',
};

function setup() {
  const clock = createFakeClock();
  const targetProvider = createLocalTestTargetProvider({
    clock,
    detectMs: DETECT_MS,
    injectMs: INJECT_MS,
    disconnectMs: DISCONNECT_MS,
  });
  const executionProvider = createLocalTestExecutionProvider({
    clock,
    preparingMs: PREPARING_MS,
    runningMs: RUNNING_MS,
    slowRunningMs: 20_000,
  });

  const target = createTargetController({
    provider: targetProvider,
    clock,
    log: silentLog,
    policy: () => ({ autoDetect: true, autoInject: false, autoReconnect: false, injectTimeoutMs: 5000 }),
  });
  const execution = createExecutionController({
    provider: executionProvider,
    clock,
    log: silentLog,
    isTargetReady: () => isTargetInjected(target.getSnapshot().status),
  });

  let wasInjected = false;
  target.subscribe(() => {
    const injected = isTargetInjected(target.getSnapshot().status);
    if (wasInjected && !injected) {
      execution.interrupt({
        code: "TARGET_DISCONNECTED",
        message: "The target was lost while the script was running.",
      });
    }
    wasInjected = injected;
  });

  const inject = async () => {
    const pass = target.detect();
    await clock.advance(DETECT_MS);
    await pass;
    const submission = target.inject({ timeoutMs: 5000 });
    assert.ok(submission.accepted);
    await clock.advance(INJECT_MS);
    assert.equal(target.getSnapshot().status, "injected");
  };

  const disconnect = async () => {
    const done = target.disconnect();
    await clock.advance(DISCONNECT_MS);
    await done;
  };

  return { clock, target, targetProvider, executionProvider, execution, inject, disconnect };
}

const OPTIONS = { timeoutMs: 5000 };

describe("target and execution together", () => {
  test("a detected but uninjected target refuses execution", async () => {
    const { clock, target, execution } = setup();
    const pass = target.detect();
    await clock.advance(DETECT_MS);
    await pass;

    assert.equal(target.getSnapshot().status, "ready");
    const refused = execution.execute(script, OPTIONS);
    assert.equal(refused.accepted, false);
    assert.equal(refused.accepted ? null : refused.error.code, "TARGET_NOT_READY");
    assert.equal(execution.getSnapshot().phase, "idle");
  });

  test("injecting runs no script by itself", async () => {
    const { execution, inject } = setup();
    await inject();

    assert.equal(execution.getSnapshot().phase, "idle");
    assert.deepEqual(execution.getSnapshot().history, []);
  });

  test("an injected target executes", async () => {
    const { clock, execution, inject } = setup();
    await inject();

    const submission = execution.execute(script, OPTIONS);
    assert.ok(submission.accepted);
    await clock.advance(PREPARING_MS + RUNNING_MS);

    const result = await submission.result;
    assert.equal(result.success, true);
    assert.ok(result.output.some((line) => line.includes("Local Test Execution")));
    assert.equal(execution.getSnapshot().phase, "success");
  });

  test("a failing execution leaves the target injected", async () => {
    const { clock, execution, executionProvider, target, inject } = setup();
    await inject();
    executionProvider.setScenario("error");

    const submission = execution.execute(script, OPTIONS);
    assert.ok(submission.accepted);
    await clock.advance(PREPARING_MS + RUNNING_MS);

    assert.equal((await submission.result).error?.code, "PROVIDER_ERROR");
    assert.equal(target.getSnapshot().status, "injected", "a script failing is not the target failing");
  });

  test("losing the target during an execution ends it as disconnected", async () => {
    const { clock, execution, executionProvider, targetProvider, target, inject } = setup();
    await inject();
    executionProvider.setScenario("slow");

    const submission = execution.execute(script, OPTIONS);
    assert.ok(submission.accepted);
    await clock.advance(PREPARING_MS + 10);
    assert.equal(execution.getSnapshot().phase, "running");

    targetProvider.setAvailability("unavailable");
    await clock.flush();

    const result = await submission.result;
    assert.equal(result.success, false);
    assert.equal(result.error?.code, "TARGET_DISCONNECTED");
    assert.equal(execution.getSnapshot().phase, "error");
    assert.equal(execution.getSnapshot().history[0]?.error?.code, "TARGET_DISCONNECTED");
    assert.equal(target.getSnapshot().status, "unavailable");
  });

  test("a disconnected target refuses the next execution", async () => {
    const { clock, execution, inject, disconnect, target } = setup();
    await inject();

    const first = execution.execute(script, OPTIONS);
    assert.ok(first.accepted);
    await clock.advance(PREPARING_MS + RUNNING_MS);
    assert.equal((await first.result).success, true);

    await disconnect();
    assert.equal(target.getSnapshot().status, "ready");

    const refused = execution.execute(script, OPTIONS);
    assert.equal(refused.accepted ? null : refused.error.code, "TARGET_NOT_READY");
    assert.equal(execution.getSnapshot().history.length, 1, "a refusal is not recorded");
  });

  test("injecting again makes execution available once more", async () => {
    const { clock, execution, inject, disconnect } = setup();
    await inject();
    await disconnect();

    const submission = execution.execute(script, OPTIONS);
    assert.equal(submission.accepted, false);

    const again = execution.execute(script, OPTIONS);
    assert.equal(again.accepted, false);

    await inject();
    const accepted = execution.execute(script, OPTIONS);
    assert.ok(accepted.accepted);
    await clock.advance(PREPARING_MS + RUNNING_MS);
    assert.equal((await accepted.result).success, true);
  });
});
