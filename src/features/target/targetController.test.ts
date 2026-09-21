import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { TARGET_HISTORY_LIMIT } from "@/features/target/history";
import {
  createLocalTestTargetProvider,
  type LocalTestAvailability,
  type LocalTestInjectScenario,
} from "@/features/target/providers/LocalTestTargetProvider";
import { createTargetController, type TargetLog, type TargetPolicy } from "@/features/target/targetController";
import {
  canTransitionTarget,
  InvalidTargetTransitionError,
  isTargetInjected,
  TARGET_STATUSES,
  transitionTarget,
} from "@/features/target/targetState";
import type { TargetProvider, TargetStatus } from "@/features/target/types";
import { createFakeClock } from "@/lib/testing/fakeClock";

const DETECT_MS = 20;
const INJECT_MS = 50;
const DISCONNECT_MS = 15;
const SLOW_MS = 5000;
const UNANSWERED_MS = 60_000;
const TIMEOUT_MS = 1000;

interface LogLine {
  level: keyof TargetLog;
  message: string;
  data: unknown;
}

function recordingLog(): TargetLog & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  const at = (level: keyof TargetLog) => (message: string, data?: unknown) => {
    lines.push({ level, message, data });
  };
  return { lines, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

interface SetupOptions {
  availability?: LocalTestAvailability;
  scenario?: LocalTestInjectScenario;
  policy?: Partial<TargetPolicy>;
  historyLimit?: number;
  provider?: (base: ReturnType<typeof createLocalTestTargetProvider>) => TargetProvider;
}

function setup(options: SetupOptions = {}) {
  const clock = createFakeClock();
  const log = recordingLog();
  const local = createLocalTestTargetProvider({
    clock,
    availability: options.availability ?? "available",
    scenario: options.scenario ?? "success",
    detectMs: DETECT_MS,
    injectMs: INJECT_MS,
    disconnectMs: DISCONNECT_MS,
    slowInjectMs: SLOW_MS,
    unansweredInjectMs: UNANSWERED_MS,
  });
  const provider = options.provider ? options.provider(local) : local;

  const policy: TargetPolicy = {
    autoDetect: false,
    autoInject: false,
    autoReconnect: false,
    injectTimeoutMs: TIMEOUT_MS,
    ...options.policy,
  };

  let count = 0;
  const controller = createTargetController({
    provider,
    clock,
    log,
    policy: () => policy,
    createId: () => `req-${++count}`,
    ...(options.historyLimit === undefined ? {} : { historyLimit: options.historyLimit }),
  });

  /** Status changes, starting from the initial unavailable state. */
  const statuses: TargetStatus[] = [];
  let last = controller.getSnapshot().status;
  controller.subscribe(() => {
    const { status } = controller.getSnapshot();
    if (status !== last) statuses.push(status);
    last = status;
  });

  /** A controller that says "injected" must be backed by an active session. */
  const assertConsistent = () => {
    const { status, session, diagnostics } = controller.getSnapshot();
    assert.equal(session, diagnostics.session, "the snapshot session must come from the provider");
    if (status === "injected") assert.equal(session, "active", "injected without a session");
    if (session === "active") {
      assert.ok(["injected", "disconnecting"].includes(status), `session active while ${status}`);
    }
  };

  /** Detects, then waits for the pass to finish. */
  const detect = async () => {
    const pass = controller.detect();
    await clock.advance(DETECT_MS);
    return pass;
  };

  /** Disconnects an injected target, letting the simulated delay elapse. */
  const disconnect = async () => {
    const done = controller.disconnect();
    await clock.advance(DISCONNECT_MS);
    await done;
  };

  /** Brings the target to ready through a detection pass. */
  const becomeReady = async () => {
    await detect();
    assert.equal(controller.getSnapshot().status, "ready");
  };

  return { clock, log, provider: local, controller, statuses, policy, detect, becomeReady, disconnect, assertConsistent };
}

describe("target state machine", () => {
  test("allows the documented lifecycle", () => {
    const path: TargetStatus[] = ["unavailable", "detected", "ready", "injecting", "injected", "disconnecting", "ready"];
    assert.equal(
      path.reduce((from, to) => transitionTarget(from, to)),
      "ready",
    );
    assert.equal(transitionTarget("injecting", "error"), "error");
    assert.equal(transitionTarget("injecting", "cancelled"), "cancelled");
    assert.equal(transitionTarget("error", "injecting"), "injecting", "retry");
    assert.equal(transitionTarget("cancelled", "injecting"), "injecting");
    assert.equal(transitionTarget("injected", "error"), "error", "an unexpected disconnect");
    assert.equal(transitionTarget("ready", "unavailable"), "unavailable");
    assert.equal(transitionTarget("disconnecting", "unavailable"), "unavailable");
  });

  test("rejects impossible transitions", () => {
    const invalid: [TargetStatus, TargetStatus][] = [
      ["unavailable", "ready"],
      ["unavailable", "injecting"],
      ["unavailable", "injected"],
      ["detected", "injecting"],
      ["detected", "injected"],
      ["ready", "injected"],
      ["ready", "error"],
      ["injecting", "ready"],
      ["injecting", "disconnecting"],
      ["injected", "ready"],
      ["injected", "injecting"],
      ["disconnecting", "injected"],
      ["disconnecting", "injecting"],
      ["error", "injected"],
      ["cancelled", "injected"],
    ];
    for (const [from, to] of invalid) {
      assert.throws(() => transitionTarget(from, to), InvalidTargetTransitionError, `${from} → ${to}`);
    }
    for (const status of TARGET_STATUSES) assert.equal(canTransitionTarget(status, status), false, status);
  });

  test("only injected means a target is attached", () => {
    for (const status of TARGET_STATUSES) assert.equal(isTargetInjected(status), status === "injected");
  });
});

describe("target detection", () => {
  test("starts with no target, as after every restart", () => {
    const { controller } = setup();
    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.status, "unavailable");
    assert.equal(snapshot.session, "inactive");
    assert.equal(snapshot.request, null);
    assert.equal(snapshot.result, null);
    assert.deepEqual(snapshot.history, []);
    assert.equal(controller.provider.label, "Local Test Target");
    assert.equal(controller.provider.simulated, true);
  });

  test("a detection pass goes checking → detected → ready", async () => {
    const { controller, clock, statuses, log } = setup();
    const pass = controller.detect();

    assert.equal(controller.getSnapshot().detecting, true, "checking");
    await clock.advance(DETECT_MS);
    assert.equal(await pass, "ready");

    assert.deepEqual(statuses, ["detected", "ready"]);
    assert.equal(controller.getSnapshot().detecting, false);
    assert.equal(controller.getSnapshot().diagnostics.targetVersion, "Test Target v1");
    assert.ok(log.lines.some((line) => line.message === "Target detected"));
    assert.ok(log.lines.some((line) => line.message === "Target ready"));
  });

  test("a detection pass that finds nothing leaves the target unavailable", async () => {
    const { controller, detect, statuses } = setup({ availability: "unavailable" });
    assert.equal(await detect(), "unavailable");
    assert.deepEqual(statuses, []);
    assert.equal(controller.getSnapshot().diagnostics.targetVersion, null);
  });

  test("Auto detect off does not look for a target at startup", async () => {
    const { controller, clock, statuses, log } = setup();
    await controller.start();
    await clock.advance(DETECT_MS);

    assert.equal(controller.getSnapshot().status, "unavailable");
    assert.deepEqual(statuses, []);
    assert.ok(log.lines.some((line) => line.message.startsWith("Auto detect is off")));
  });

  test("Auto detect on looks for the target at startup, once", async () => {
    const { controller, clock } = setup({ policy: { autoDetect: true } });
    const first = controller.start();
    await clock.advance(DETECT_MS);
    await first;
    assert.equal(controller.getSnapshot().status, "ready");

    await controller.start();
    assert.equal(controller.getSnapshot().status, "ready");
  });

  test("a target that appears is followed only while Auto detect is on", async () => {
    const off = setup({ availability: "unavailable" });
    off.provider.setAvailability("available");
    await off.clock.flush();
    assert.equal(off.controller.getSnapshot().status, "unavailable", "the user detects manually instead");
    assert.ok(off.log.lines.some((line) => line.level === "debug" && line.message.includes("Auto detect is off")));

    const on = setup({ availability: "unavailable", policy: { autoDetect: true } });
    on.provider.setAvailability("available");
    await on.clock.flush();
    assert.equal(on.controller.getSnapshot().status, "ready");
  });

  test("a target that disappears is always followed", async () => {
    const { controller, provider, becomeReady, clock, statuses } = setup();
    await becomeReady();

    provider.setAvailability("unavailable");
    await clock.flush();

    assert.equal(controller.getSnapshot().status, "unavailable");
    assert.deepEqual(statuses, ["detected", "ready", "unavailable"]);
  });
});

describe("inject controller", () => {
  test("a successful injection goes ready → injecting → injected", async () => {
    const { controller, clock, becomeReady, statuses, log, assertConsistent } = setup();
    await becomeReady();

    const submission = controller.inject();
    assert.ok(submission.accepted);
    assert.equal(submission.requestId, "req-1");
    assert.equal(controller.getSnapshot().status, "injecting");
    assert.equal(controller.getSnapshot().request?.providerType, "local-test");

    await clock.advance(INJECT_MS);
    const result = await submission.result;

    assert.equal(result.success, true);
    assert.equal(result.cancelled, false);
    assert.equal(result.error, null);
    assert.equal(result.durationMs, INJECT_MS);
    assert.equal(result.diagnostics.simulated, true);
    assert.deepEqual(statuses, ["detected", "ready", "injecting", "injected"]);
    assert.equal(controller.getSnapshot().session, "active");
    assertConsistent();
    assert.ok(log.lines.some((line) => line.message === "Injection started"));
    assert.ok(log.lines.some((line) => line.message.startsWith("Injection completed")));
  });

  test("the inject request models the workflow and nothing about a process", async () => {
    const { controller, clock, becomeReady } = setup();
    await becomeReady();

    const submission = controller.inject();
    assert.ok(submission.accepted);
    const request = controller.getSnapshot().request;
    assert.deepEqual(Object.keys(request ?? {}).sort(), ["createdAt", "providerType", "requestId"]);
    await clock.advance(INJECT_MS);
  });

  test("injecting again while injected is refused", async () => {
    const { controller, clock, becomeReady } = setup();
    await becomeReady();
    const first = controller.inject();
    assert.ok(first.accepted);
    await clock.advance(INJECT_MS);

    const second = controller.inject();
    assert.equal(second.accepted, false);
    assert.equal(second.accepted ? null : second.error.code, "ALREADY_INJECTED");
    assert.equal(controller.getSnapshot().status, "injected");
  });

  test("injecting without a target is refused", () => {
    const { controller } = setup({ availability: "unavailable" });
    const submission = controller.inject();
    assert.equal(submission.accepted ? null : submission.error.code, "TARGET_UNAVAILABLE");
    assert.equal(controller.getSnapshot().status, "unavailable");
  });

  test("injecting while one is in flight is refused without disturbing it", async () => {
    const { controller, clock, becomeReady } = setup();
    await becomeReady();
    const first = controller.inject();
    assert.ok(first.accepted);

    const second = controller.inject();
    assert.equal(second.accepted ? null : second.error.code, "TARGET_NOT_READY");

    await clock.advance(INJECT_MS);
    assert.equal((await first.result).success, true);
    assert.equal(controller.getSnapshot().history.length, 1);
  });

  test("a failed injection ends in error and can be retried", async () => {
    const { controller, clock, provider, becomeReady, log } = setup({ scenario: "failure" });
    await becomeReady();

    const failed = controller.inject();
    assert.ok(failed.accepted);
    await clock.advance(INJECT_MS);
    const result = await failed.result;

    assert.equal(result.success, false);
    assert.equal(result.error?.code, "INJECTION_FAILED");
    assert.equal(controller.getSnapshot().status, "error");
    assert.equal(controller.getSnapshot().session, "inactive");
    assert.ok(log.lines.some((line) => line.level === "error" && line.message.startsWith("Injection failed")));

    provider.setScenario("success");
    const retried = controller.inject();
    assert.ok(retried.accepted);
    await clock.advance(INJECT_MS);
    assert.equal((await retried.result).success, true);
    assert.equal(controller.getSnapshot().status, "injected");
  });

  test("an injection that outlives its timeout fails, and a late answer is ignored", async () => {
    const { controller, clock, becomeReady, log } = setup({ scenario: "timeout" });
    await becomeReady();

    const submission = controller.inject();
    assert.ok(submission.accepted);
    await clock.advance(TIMEOUT_MS);
    const result = await submission.result;

    assert.equal(result.error?.code, "INJECTION_TIMEOUT");
    assert.equal(controller.getSnapshot().status, "error");
    assert.equal(controller.getSnapshot().session, "inactive");

    // The provider answers long afterwards; nothing may promote it to injected.
    await clock.advance(UNANSWERED_MS);
    assert.equal(controller.getSnapshot().status, "error");
    assert.equal(controller.getSnapshot().history.length, 1);
    assert.ok(log.lines.some((line) => line.level === "debug" && line.message.includes("late provider result")));
  });

  test("a slow injection still succeeds when the timeout allows it", async () => {
    const { controller, clock, becomeReady, policy } = setup({ scenario: "slow" });
    policy.injectTimeoutMs = SLOW_MS + 1000;
    await becomeReady();

    const submission = controller.inject();
    assert.ok(submission.accepted);
    await clock.advance(SLOW_MS);
    assert.equal((await submission.result).success, true);
    assert.equal(controller.getSnapshot().status, "injected");
  });

  test("cancelling an injection is real and leaves a usable target", async () => {
    const { controller, clock, provider, becomeReady, statuses, assertConsistent } = setup({ scenario: "slow" });
    await becomeReady();

    const submission = controller.inject();
    assert.ok(submission.accepted);
    await clock.advance(INJECT_MS);
    assert.equal(controller.cancelInject(), "requested");
    assert.equal(controller.getSnapshot().cancelling, true);
    assert.equal(controller.cancelInject(), "already-requested");

    await clock.flush();
    const result = await submission.result;

    assert.equal(result.cancelled, true);
    assert.equal(result.success, false);
    assert.equal(controller.getSnapshot().status, "cancelled");
    assert.equal(controller.getSnapshot().session, "inactive");
    assert.deepEqual(statuses, ["detected", "ready", "injecting", "cancelled"]);
    assertConsistent();

    // The controller is in a valid state: injecting again is allowed.
    provider.setScenario("success");
    const again = controller.inject();
    assert.ok(again.accepted);
    await clock.advance(INJECT_MS);
    assert.equal(controller.getSnapshot().status, "injected");
  });

  test("the provider can stop an injection itself", async () => {
    const { controller, clock, becomeReady } = setup({ scenario: "cancelled" });
    await becomeReady();
    const submission = controller.inject();
    assert.ok(submission.accepted);
    await clock.advance(INJECT_MS);

    assert.equal((await submission.result).cancelled, true);
    assert.equal(controller.getSnapshot().status, "cancelled");
  });

  test("cancelling reports honestly when there is nothing to cancel or no support", async () => {
    const { controller, becomeReady } = setup();
    assert.equal(controller.cancelInject(), "not-injecting");
    await becomeReady();
    assert.equal(controller.cancelInject(), "not-injecting");

    const noCancel = setup({
      scenario: "slow",
      provider: (base) => ({ ...base, supportsCancel: false }),
    });
    await noCancel.becomeReady();
    assert.ok(noCancel.controller.inject().accepted);
    assert.equal(noCancel.controller.cancelInject(), "unsupported", "never claim a cancellation that did not happen");
    assert.equal(noCancel.controller.getSnapshot().status, "injecting");
    assert.equal(noCancel.controller.getSnapshot().cancelling, false);
  });

  test("disconnecting during an injection cancels it", async () => {
    const { controller, clock, becomeReady } = setup({ scenario: "slow" });
    await becomeReady();
    const submission = controller.inject();
    assert.ok(submission.accepted);

    await controller.disconnect();
    await clock.flush();

    assert.equal((await submission.result).cancelled, true);
    assert.equal(controller.getSnapshot().status, "cancelled");
  });

  test("losing the target during an injection fails it as disconnected", async () => {
    const { controller, clock, provider, becomeReady, statuses } = setup({ scenario: "slow" });
    await becomeReady();
    const submission = controller.inject();
    assert.ok(submission.accepted);

    provider.setAvailability("unavailable");
    await clock.flush();
    const result = await submission.result;

    assert.equal(result.error?.code, "TARGET_DISCONNECTED");
    assert.deepEqual(statuses, ["detected", "ready", "injecting", "error", "unavailable"]);
    assert.equal(controller.getSnapshot().session, "inactive");
  });
});

describe("target session", () => {
  test("disconnecting an injected target returns it to ready", async () => {
    const { controller, clock, becomeReady, statuses, log, assertConsistent } = setup();
    await becomeReady();
    assert.ok(controller.inject().accepted);
    await clock.advance(INJECT_MS);

    const done = controller.disconnect();
    assert.equal(controller.getSnapshot().status, "disconnecting");
    await clock.advance(DISCONNECT_MS);
    await done;

    assert.equal(controller.getSnapshot().status, "ready");
    assert.equal(controller.getSnapshot().session, "inactive");
    assert.equal(controller.getSnapshot().result, null);
    assert.deepEqual(statuses, ["detected", "ready", "injecting", "injected", "disconnecting", "ready"]);
    assert.ok(log.lines.some((line) => line.message === "Target disconnected"));
    assertConsistent();
  });

  test("a disconnected target can be injected again", async () => {
    const { controller, clock, becomeReady, disconnect } = setup();
    await becomeReady();
    assert.ok(controller.inject().accepted);
    await clock.advance(INJECT_MS);
    await disconnect();

    const again = controller.inject();
    assert.ok(again.accepted);
    await clock.advance(INJECT_MS);
    assert.equal(controller.getSnapshot().status, "injected");
    assert.equal(controller.getSnapshot().history.filter((entry) => entry.status === "injected").length, 2);
  });

  test("an unexpected disconnect is reported, never silently repaired", async () => {
    const { controller, clock, provider, becomeReady, log } = setup();
    await becomeReady();
    assert.ok(controller.inject().accepted);
    await clock.advance(INJECT_MS);

    provider.setAvailability("unavailable");
    await clock.flush();

    assert.equal(controller.getSnapshot().status, "unavailable");
    assert.equal(controller.getSnapshot().session, "inactive");
    assert.equal(controller.getSnapshot().error?.code, "TARGET_DISCONNECTED");
    assert.ok(log.lines.some((line) => line.level === "warn" && line.message.includes("unexpectedly")));

    // Auto reconnect is off: the target coming back does not inject again.
    provider.setAvailability("available");
    await clock.flush();
    assert.equal(controller.getSnapshot().status, "unavailable", "Auto detect is off in this setup");
  });

  test("dismissing a failure returns the target to its resting state", async () => {
    const { controller, clock, becomeReady } = setup({ scenario: "failure" });
    await becomeReady();
    assert.ok(controller.inject().accepted);
    await clock.advance(INJECT_MS);
    assert.equal(controller.getSnapshot().status, "error");

    await controller.disconnect();
    assert.equal(controller.getSnapshot().status, "ready");
    assert.equal(controller.getSnapshot().error, null);
  });
});

describe("auto inject", () => {
  test("injects once the target becomes ready", async () => {
    const { controller, clock, statuses, log } = setup({ policy: { autoDetect: true, autoInject: true } });
    const started = controller.start();
    await clock.advance(DETECT_MS);
    await started;
    await clock.advance(INJECT_MS);

    assert.deepEqual(statuses, ["detected", "ready", "injecting", "injected"]);
    assert.ok(log.lines.some((line) => line.message === "Auto inject: injecting"));
  });

  test("does nothing while it is off", async () => {
    const { controller, clock } = setup({ policy: { autoDetect: true } });
    const started = controller.start();
    await clock.advance(DETECT_MS);
    await started;
    await clock.advance(INJECT_MS);

    assert.equal(controller.getSnapshot().status, "ready");
    assert.equal(controller.getSnapshot().history.length, 0);
  });

  test("a simulated failure is reported and not retried", async () => {
    const { controller, clock } = setup({
      scenario: "failure",
      policy: { autoDetect: true, autoInject: true },
    });
    const started = controller.start();
    await clock.advance(DETECT_MS);
    await started;
    await clock.advance(INJECT_MS);

    assert.equal(controller.getSnapshot().status, "error");
    await clock.advance(INJECT_MS * 10);
    assert.equal(controller.getSnapshot().history.length, 1, "no retry loop");
  });

  test("does not undo a disconnect the user asked for", async () => {
    const { controller, clock, policy, becomeReady, disconnect } = setup({ policy: { autoDetect: true } });
    await becomeReady();
    assert.ok(controller.inject().accepted);
    await clock.advance(INJECT_MS);

    policy.autoInject = true;
    await disconnect();
    await clock.advance(INJECT_MS);

    assert.equal(controller.getSnapshot().status, "ready");
    assert.equal(controller.getSnapshot().history.filter((entry) => entry.status === "injected").length, 1);
  });

  test("Auto reconnect injects again after an unexpected disconnect, and only then", async () => {
    const { controller, clock, provider, becomeReady, disconnect } = setup({
      policy: { autoDetect: true, autoReconnect: true },
    });
    await becomeReady();
    assert.ok(controller.inject().accepted);
    await clock.advance(INJECT_MS);
    assert.equal(controller.getSnapshot().status, "injected");

    provider.setAvailability("unavailable");
    await clock.flush();
    assert.equal(controller.getSnapshot().status, "unavailable");

    provider.setAvailability("available");
    await clock.flush();
    await clock.advance(INJECT_MS);
    assert.equal(controller.getSnapshot().status, "injected", "the session is restored");

    // A disconnect the user asked for is not undone by Auto reconnect.
    await disconnect();
    await clock.advance(INJECT_MS);
    assert.equal(controller.getSnapshot().status, "ready");
  });
});

describe("target history", () => {
  test("records every outcome with its code, newest first", async () => {
    const { controller, clock, provider, becomeReady, disconnect } = setup();
    await becomeReady();

    // Success, then a disconnect.
    assert.ok(controller.inject().accepted);
    await clock.advance(INJECT_MS);
    await disconnect();

    // Failure.
    provider.setScenario("failure");
    assert.ok(controller.inject().accepted);
    await clock.advance(INJECT_MS);

    // Timeout.
    provider.setScenario("timeout");
    assert.ok(controller.inject().accepted);
    await clock.advance(TIMEOUT_MS);

    // Cancellation.
    provider.setScenario("slow");
    assert.ok(controller.inject().accepted);
    controller.cancelInject();
    await clock.flush();

    const history = controller.getSnapshot().history;
    assert.deepEqual(
      history.map((entry) => entry.status),
      ["cancelled", "timeout", "failed", "disconnected", "injected"],
    );
    assert.equal(history[1]?.error?.code, "INJECTION_TIMEOUT");
    assert.equal(history[2]?.error?.code, "INJECTION_FAILED");
    assert.equal(history[3]?.durationMs, null, "a disconnect measures nothing");
    assert.equal(history[4]?.durationMs, INJECT_MS);
    for (const entry of history) assert.equal(entry.provider, "Local Test Target");
  });

  test("entries carry workflow metadata only", async () => {
    const { controller, clock, becomeReady } = setup();
    await becomeReady();
    assert.ok(controller.inject().accepted);
    await clock.advance(INJECT_MS);

    const entry = controller.getSnapshot().history[0];
    assert.deepEqual(Object.keys(entry ?? {}).sort(), [
      "durationMs",
      "error",
      "provider",
      "requestId",
      "startedAt",
      "status",
    ]);
  });

  test("is bounded, dropping the oldest entries", async () => {
    const limit = 3;
    const { controller, clock, becomeReady, disconnect } = setup({ historyLimit: limit });
    await becomeReady();

    for (let index = 0; index < limit + 2; index += 1) {
      assert.ok(controller.inject().accepted);
      await clock.advance(INJECT_MS);
      await disconnect();
    }

    const history = controller.getSnapshot().history;
    assert.equal(history.length, limit);
    assert.equal(history[0]?.status, "disconnected");
    assert.ok(TARGET_HISTORY_LIMIT >= limit);
  });

  test("the shipped limit keeps the history small", () => {
    assert.equal(TARGET_HISTORY_LIMIT, 50);
  });
});

describe("target disposal", () => {
  test("dispose abandons an injection and stops following the provider", async () => {
    const { controller, clock, provider, becomeReady } = setup({ scenario: "slow" });
    await becomeReady();
    const submission = controller.inject();
    assert.ok(submission.accepted);

    controller.dispose();
    const result = await submission.result;
    assert.equal(result.success, false);

    const before = controller.getSnapshot();
    provider.setAvailability("unavailable");
    await clock.flush();
    assert.equal(controller.getSnapshot(), before, "a disposed controller publishes nothing further");
  });
});
