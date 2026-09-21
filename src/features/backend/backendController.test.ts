import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createBackendController,
  type BackendController,
  type BackendLog,
  type BackendPolicy,
} from "@/features/backend/backendController";
import { BACKEND_STATES } from "@/features/backend/backendState";
import {
  createDelayedProvider,
  createFailingProvider,
  createMockBackend,
  createPartialBackend,
  type HarnessBackend,
} from "@/features/backend/testing/backendHarness";
import type { BackendState, DeveloperBackend } from "@/features/backend/types";
import { createFakeClock, type FakeClock } from "@/lib/testing/fakeClock";

/**
 * The backend controller: the lifecycle, its timeouts, cancellation, idempotency
 * and what it publishes. The real controller is put on top of a harness backend,
 * so everything under test is production code and only the backend's edge is a
 * double.
 */

const START_MS = 50;
const STOP_MS = 30;
const START_TIMEOUT_MS = 500;
const STOP_TIMEOUT_MS = 500;

interface LogLine {
  level: keyof BackendLog;
  message: string;
  data: unknown;
}

function recordingLog(): BackendLog & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  const at = (level: keyof BackendLog) => (message: string, data?: unknown) => {
    lines.push({ level, message, data });
  };
  return { lines, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

interface SetupOptions {
  backend?: (clock: FakeClock) => HarnessBackend;
  policy?: Partial<BackendPolicy>;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
}

function setup(options: SetupOptions = {}) {
  const clock = createFakeClock();
  const backend = (options.backend ?? ((c) => createMockBackend({ clock: c, startMs: START_MS, stopMs: STOP_MS })))(
    clock,
  );
  const log = recordingLog();
  const policy: BackendPolicy = { autoStartBackend: true, ...options.policy };

  const controller = createBackendController({
    backend,
    clock,
    log,
    policy: () => policy,
    startTimeoutMs: options.startTimeoutMs ?? START_TIMEOUT_MS,
    stopTimeoutMs: options.stopTimeoutMs ?? STOP_TIMEOUT_MS,
  });

  /** Starts and waits for the backend to settle. */
  const becomeReady = async () => {
    const submission = controller.start();
    assert.ok(submission.accepted, "the backend refused to start");
    await clock.advance(START_MS);
    return submission.settled;
  };

  /** Every state the controller published, in order, without repeats. */
  const track = (target: BackendController = controller) => {
    const states: BackendState[] = [target.getSnapshot().state];
    target.subscribe(() => {
      const { state } = target.getSnapshot();
      if (states[states.length - 1] !== state) states.push(state);
    });
    return states;
  };

  return { clock, backend, controller, log, policy, becomeReady, track };
}

describe("the backend controller at rest", () => {
  test("a fresh controller has not been started and supports what its providers declare", () => {
    const { controller } = setup();
    const snapshot = controller.getSnapshot();

    assert.equal(snapshot.state, "created");
    assert.equal(snapshot.busy, false);
    assert.equal(snapshot.readySince, null);
    assert.equal(snapshot.error, null);
    assert.deepEqual(snapshot.capabilities, {
      target: { canConnect: true, canCancelInject: true },
      debugger: { canDebug: true, canPause: true },
      profiler: { canProfile: true },
    });
  });

  test("nothing is usable before it starts, and it says why for every tool", () => {
    const { controller } = setup();
    for (const report of controller.getSnapshot().health) {
      assert.equal(report.health, "unavailable", report.tool);
      assert.equal(report.reason, "The backend has not been started.", report.tool);
    }
  });

  test("the UI is given the backend's identity, never the backend itself", () => {
    const { controller } = setup();
    assert.deepEqual(Object.keys(controller.backend).sort(), ["description", "id", "label", "simulated"]);
    assert.equal(controller.backend.simulated, true);
    assert.throws(() => {
      (controller.backend as { label: string }).label = "Something else";
    });
  });

  test("the providers it supplies are described once each, with the tool they serve", () => {
    const { controller } = setup();
    assert.deepEqual(
      controller.getSnapshot().providers.map((provider) => provider.tool),
      ["target", "debugger", "profiler"],
    );
  });
});

describe("starting the backend", () => {
  test("a start goes created → starting → ready", async () => {
    const { controller, becomeReady, track } = setup();
    const states = track();

    const result = await becomeReady();

    assert.deepEqual(result, { status: "started" });
    assert.deepEqual(states, ["created", "starting", "ready"]);
    assert.equal(controller.getSnapshot().busy, false);
  });

  test("a ready backend reports when it became ready", async () => {
    const { clock, controller, becomeReady } = setup();
    const before = clock.now();
    await becomeReady();
    const { readySince } = controller.getSnapshot();
    assert.ok(readySince !== null && readySince >= before, "the moment it became ready is recorded");
  });

  test("the backend's own health is read once it is running", async () => {
    const { controller, becomeReady } = setup();
    await becomeReady();
    for (const report of controller.getSnapshot().health) {
      assert.equal(report.health, "healthy", report.tool);
      assert.equal(report.reason, null, report.tool);
    }
  });

  test("it is busy while it starts, and busy is not ready", async () => {
    const { clock, controller } = setup();
    const submission = controller.start();
    assert.ok(submission.accepted);

    assert.equal(controller.getSnapshot().state, "starting");
    assert.equal(controller.getSnapshot().busy, true);

    await clock.advance(START_MS);
    await submission.settled;
    assert.equal(controller.getSnapshot().busy, false);
  });

  test("start() start() starts one backend, not two", async () => {
    const { clock, backend, controller } = setup();
    const first = controller.start();
    const second = controller.start();
    assert.ok(first.accepted && second.accepted);

    await clock.advance(START_MS);
    assert.deepEqual(await first.settled, { status: "started" });
    assert.deepEqual(await second.settled, { status: "started" }, "the second call joined the first");
    assert.equal(backend.starts(), 1, "the backend was asked to start exactly once");
  });

  test("starting an already ready backend succeeds without touching the backend again", async () => {
    const { backend, controller, becomeReady } = setup();
    await becomeReady();

    const again = controller.start();
    assert.ok(again.accepted, "an idempotent start is accepted, not refused");
    assert.deepEqual(await again.settled, { status: "started" });
    assert.equal(backend.starts(), 1);
    assert.equal(controller.getSnapshot().state, "ready");
  });

  test("a start is refused while the backend is stopping, with a reason", async () => {
    const { clock, controller, becomeReady } = setup();
    await becomeReady();
    const stopping = controller.stop();
    assert.equal(controller.getSnapshot().state, "stopping");

    const submission = controller.start();
    assert.equal(submission.accepted, false);
    assert.equal(submission.accepted === false ? submission.error.code : null, "PROVIDER_INVALID_STATE");

    await clock.advance(STOP_MS + 400);
    await stopping;
  });
});

describe("stopping the backend", () => {
  test("a stop goes ready → stopping → stopped", async () => {
    const { clock, controller, becomeReady, track } = setup();
    await becomeReady();
    const states = track();

    const stopping = controller.stop();
    await clock.advance(STOP_MS + 400);
    await stopping;

    assert.deepEqual(states, ["ready", "stopping", "stopped"]);
    assert.equal(controller.getSnapshot().readySince, null, "a stopped backend has no readiness to report");
  });

  test("stop() stop() does not produce an error, and stops once", async () => {
    const { clock, backend, controller, becomeReady } = setup();
    await becomeReady();

    const first = controller.stop();
    const second = controller.stop();
    await clock.advance(STOP_MS + 400);
    await Promise.all([first, second]);

    assert.equal(controller.getSnapshot().state, "stopped");
    assert.equal(controller.getSnapshot().error, null);
    assert.equal(backend.stops(), 1, "the second stop joined the first");
  });

  test("stopping a backend that was never started does nothing at all", async () => {
    const { backend, controller } = setup();
    await controller.stop();
    assert.equal(controller.getSnapshot().state, "created");
    assert.equal(backend.stops(), 0);
  });

  test("a stop while it is starting abandons the start rather than waiting for it", async () => {
    const { clock, controller, track } = setup({ backend: (clock) => createDelayedProvider({ clock }) });
    const states = track();

    const submission = controller.start();
    assert.ok(submission.accepted);
    const stopping = controller.stop();
    await clock.advance(100);
    await stopping;

    assert.deepEqual(await submission.settled, { status: "cancelled" }, "the abandoned start reports itself");
    assert.deepEqual(states, ["created", "starting", "stopped"]);
    assert.equal(controller.getSnapshot().error, null, "an abandoned start is not a failure");
  });

  test("a late start answer cannot revive a backend that was stopped in the meantime", async () => {
    const { clock, controller, log } = setup({ backend: (clock) => createMockBackend({ clock, startMs: 400 }) });

    const submission = controller.start();
    assert.ok(submission.accepted);
    const stopping = controller.stop();
    await clock.advance(50);
    await stopping;
    assert.equal(controller.getSnapshot().state, "stopped");

    // The backend answers long after the controller gave up on it.
    await clock.advance(1000);
    assert.equal(controller.getSnapshot().state, "stopped", "the stale answer was not applied");
    assert.ok(
      log.lines.some((line) => line.level === "debug" && /late|stale/.test(line.message)),
      "the ignored answer is recorded",
    );
  });
});

describe("a backend that does not start", () => {
  test("a reported failure lands in error, with the backend's own code", async () => {
    const { clock, controller } = setup({ backend: (clock) => createFailingProvider({ clock, startMs: START_MS }) });

    const submission = controller.start();
    assert.ok(submission.accepted);
    await clock.advance(START_MS);
    const result = await submission.settled;

    assert.equal(result.status, "failed");
    assert.equal(result.status === "failed" ? result.error.code : null, "PROVIDER_START_FAILED");
    assert.equal(controller.getSnapshot().state, "error");
    assert.equal(controller.getSnapshot().error?.code, "PROVIDER_START_FAILED");
    assert.equal(controller.getSnapshot().readySince, null);
  });

  test("a thrown error is turned into the same structured failure, never left raw", async () => {
    const { clock, controller, log } = setup({
      backend: (clock) => createFailingProvider({ clock, startMs: START_MS, mode: "thrown" }),
    });

    const submission = controller.start();
    assert.ok(submission.accepted);
    await clock.advance(START_MS);
    const result = await submission.settled;

    assert.equal(result.status, "failed");
    assert.equal(result.status === "failed" ? result.error.code : null, "PROVIDER_START_FAILED");
    assert.match(controller.getSnapshot().error?.details ?? "", /threw while starting/);
    assert.ok(log.lines.some((line) => line.level === "error"), "the failure reaches the console");
  });

  test("a backend that never answers is abandoned by the timeout and reported as one", async () => {
    const { clock, controller } = setup({ backend: (clock) => createDelayedProvider({ clock }) });

    const submission = controller.start();
    assert.ok(submission.accepted);
    await clock.advance(START_TIMEOUT_MS);
    const result = await submission.settled;

    assert.equal(result.status, "failed");
    assert.equal(result.status === "failed" ? result.error.code : null, "PROVIDER_TIMEOUT");
    assert.equal(controller.getSnapshot().state, "error");
  });

  test("a timed-out backend that answers afterwards never becomes ready", async () => {
    const { clock, controller } = setup({
      backend: (clock) => createMockBackend({ clock, startMs: START_TIMEOUT_MS * 2 }),
    });

    const submission = controller.start();
    assert.ok(submission.accepted);
    await clock.advance(START_TIMEOUT_MS);
    await submission.settled;
    assert.equal(controller.getSnapshot().state, "error");

    await clock.advance(START_TIMEOUT_MS * 3);
    assert.equal(controller.getSnapshot().state, "error", "a late answer is ignored, not applied");
  });

  test("a failure does not leave the UI waiting: busy clears and an error is shown", async () => {
    const { clock, controller } = setup({ backend: (clock) => createDelayedProvider({ clock }) });
    const submission = controller.start();
    assert.ok(submission.accepted);
    await clock.advance(START_TIMEOUT_MS);
    await submission.settled;

    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.busy, false, "nothing may be left spinning");
    assert.ok(snapshot.error !== null, "the reason is available to show");
  });

  test("a backend that timed out can be started again from error, and succeeds", async () => {
    const clock = createFakeClock();
    const inner = createMockBackend({ clock, startMs: START_MS, stopMs: STOP_MS });
    let attempts = 0;
    // Too slow to answer the first time, ordinary the second time.
    const slowOnce: DeveloperBackend = {
      ...inner,
      start: async (options) => {
        attempts += 1;
        if (attempts > 1) return inner.start(options);
        await new Promise<void>((resolve) => {
          clock.setTimeout(resolve, START_TIMEOUT_MS * 4);
        });
        return { status: "started" };
      },
    };
    const controller = createBackendController({
      backend: slowOnce,
      clock,
      log: recordingLog(),
      policy: () => ({ autoStartBackend: true }),
      startTimeoutMs: START_TIMEOUT_MS,
      stopTimeoutMs: STOP_TIMEOUT_MS,
    });

    const first = controller.start();
    assert.ok(first.accepted);
    await clock.advance(START_TIMEOUT_MS);
    const failure = await first.settled;
    assert.equal(failure.status, "failed");
    assert.equal(failure.status === "failed" ? failure.error.code : null, "PROVIDER_TIMEOUT");
    assert.equal(controller.getSnapshot().state, "error");

    const again = controller.start();
    assert.ok(again.accepted, "a failed backend may be started again");
    await clock.advance(START_MS);
    assert.deepEqual(await again.settled, { status: "started" });
    assert.equal(controller.getSnapshot().state, "ready");
    assert.equal(controller.getSnapshot().error, null, "a successful start clears the old failure");
    assert.equal(attempts, 2);

    controller.dispose();
  });

  test("a backend that throws while stopping settles at error instead of staying stopping", async () => {
    const { clock, controller } = setup({
      backend: (clock) => createFailingProvider({ clock, startMs: START_MS, mode: "stop" }),
    });

    const submission = controller.start();
    assert.ok(submission.accepted);
    await clock.advance(START_MS);
    await submission.settled;
    assert.equal(controller.getSnapshot().state, "ready");

    const stopping = controller.stop();
    await clock.advance(200);
    await stopping;

    assert.equal(controller.getSnapshot().state, "error", "it is never left in stopping");
    assert.equal(controller.getSnapshot().error?.code, "PROVIDER_STOP_FAILED");
  });
});

describe("restarting the backend", () => {
  test("a restart stops and starts once each, and ends ready", async () => {
    const { clock, backend, controller, becomeReady } = setup();
    await becomeReady();

    const restarting = controller.restart();
    await clock.advance(STOP_MS + START_MS + 500);
    assert.deepEqual(await restarting, { status: "started" });

    assert.equal(controller.getSnapshot().state, "ready");
    assert.equal(backend.starts(), 2);
    assert.equal(backend.stops(), 1);
  });

  test("a restart recovers a backend that had failed", async () => {
    const clock = createFakeClock();
    let fail = true;
    const inner = createMockBackend({ clock, startMs: START_MS, stopMs: STOP_MS });
    // A backend that refuses the first start and accepts the next one.
    const flaky: DeveloperBackend = {
      ...inner,
      start: async (options) => {
        if (fail) {
          fail = false;
          return {
            status: "failed",
            error: { code: "PROVIDER_START_FAILED", message: "Not this time." },
          };
        }
        return inner.start(options);
      },
    };
    const controller = createBackendController({
      backend: flaky,
      clock,
      policy: () => ({ autoStartBackend: true }),
      startTimeoutMs: START_TIMEOUT_MS,
      stopTimeoutMs: STOP_TIMEOUT_MS,
      log: recordingLog(),
    });

    const first = controller.start();
    assert.ok(first.accepted);
    await clock.advance(START_MS);
    assert.equal((await first.settled).status, "failed");
    assert.equal(controller.getSnapshot().state, "error");

    const restarting = controller.restart();
    await clock.advance(STOP_MS + START_MS + 500);
    assert.deepEqual(await restarting, { status: "started" });
    assert.equal(controller.getSnapshot().state, "ready");
    assert.equal(controller.getSnapshot().error, null, "the old failure is cleared once it works again");
  });

  test("a restart never throws, whatever the backend does", async () => {
    const { clock, controller, becomeReady } = setup({
      backend: (clock) => createFailingProvider({ clock, startMs: START_MS, mode: "stop" }),
    });
    await becomeReady();

    const restarting = controller.restart();
    await clock.advance(START_MS + 600);
    const result = await restarting;
    assert.ok(["started", "failed", "cancelled"].includes(result.status), result.status);
  });
});

describe("capabilities and health over the lifecycle", () => {
  test("capabilities do not move with the lifecycle, because they are a property of the providers", async () => {
    const { clock, controller, becomeReady } = setup();
    const before = controller.getSnapshot().capabilities;
    await becomeReady();
    assert.deepEqual(controller.getSnapshot().capabilities, before);

    const stopping = controller.stop();
    await clock.advance(STOP_MS + 400);
    await stopping;
    assert.deepEqual(controller.getSnapshot().capabilities, before, "stopping does not remove a capability");
  });

  test("a partial backend supports its target and nothing else", async () => {
    const { controller, becomeReady } = setup({ backend: (clock) => createPartialBackend({ clock }) });
    await becomeReady();
    const snapshot = controller.getSnapshot();

    assert.equal(snapshot.state, "ready");
    assert.equal(snapshot.capabilities.target.canConnect, true);
    assert.equal(snapshot.capabilities.debugger.canDebug, false);
    assert.equal(snapshot.capabilities.profiler.canProfile, false);
    assert.deepEqual(
      snapshot.providers.map((provider) => provider.tool),
      ["target"],
    );
  });

  test("a ready backend with an unsupported tool still says why that tool is unavailable", async () => {
    const { controller, becomeReady } = setup({ backend: (clock) => createPartialBackend({ clock }) });
    await becomeReady();
    const debuggerHealth = controller.getSnapshot().health.find((report) => report.tool === "debugger");
    assert.equal(debuggerHealth?.health, "unavailable");
    assert.match(debuggerHealth?.reason ?? "", /supplies no provider/);
  });

  test("refreshing re-reads what the backend reports right now", async () => {
    const { backend, controller, becomeReady } = setup();
    await becomeReady();
    assert.equal(controller.getSnapshot().health[1]?.health, "healthy");

    backend.setHealth("debugger", "degraded", "Stepping is slower than usual.");
    assert.equal(controller.getSnapshot().health[1]?.health, "healthy", "nothing is re-read until it is asked");

    controller.refreshCapabilities();
    const report = controller.getSnapshot().health.find((entry) => entry.tool === "debugger");
    assert.equal(report?.health, "degraded");
    assert.equal(report?.reason, "Stepping is slower than usual.");
  });

  test("a backend that cannot answer about its health is reported as an error, not as healthy", async () => {
    const clock = createFakeClock();
    const inner = createMockBackend({ clock, startMs: START_MS, stopMs: STOP_MS });
    const broken: DeveloperBackend = {
      ...inner,
      getHealth: () => {
        throw new Error("The health probe failed");
      },
    };
    const log = recordingLog();
    const controller = createBackendController({
      backend: broken,
      clock,
      log,
      policy: () => ({ autoStartBackend: true }),
      startTimeoutMs: START_TIMEOUT_MS,
    });

    const submission = controller.start();
    assert.ok(submission.accepted);
    await clock.advance(START_MS);
    await submission.settled;

    assert.equal(controller.getSnapshot().state, "ready", "a health probe failing is not a lifecycle failure");
    for (const report of controller.getSnapshot().health) {
      assert.equal(report.health, "error", report.tool);
    }
    assert.ok(log.lines.some((line) => line.level === "error"));
  });

  test("health while stopped explains the lifecycle, not the providers", async () => {
    const { clock, controller, becomeReady } = setup();
    await becomeReady();
    const stopping = controller.stop();
    await clock.advance(STOP_MS + 400);
    await stopping;

    for (const report of controller.getSnapshot().health) {
      assert.equal(report.reason, "The backend is stopped.", report.tool);
    }
  });
});

describe("auto start", () => {
  test("the launch pass starts the backend when auto start is on", async () => {
    const { clock, backend, controller } = setup();
    const startup = controller.startup();
    await clock.advance(START_MS);
    await startup;

    assert.equal(controller.getSnapshot().state, "ready");
    assert.equal(backend.starts(), 1);
  });

  test("with auto start off nothing is started, and it says so", async () => {
    const { backend, controller, log } = setup({ policy: { autoStartBackend: false } });
    await controller.startup();

    assert.equal(controller.getSnapshot().state, "created");
    assert.equal(backend.starts(), 0);
    assert.ok(log.lines.some((line) => /Auto start is off/.test(line.message)));
  });

  test("only the first launch pass has any effect", async () => {
    const { clock, backend, controller } = setup();
    const first = controller.startup();
    await clock.advance(START_MS);
    await first;
    await controller.startup();
    await clock.advance(START_MS);

    assert.equal(backend.starts(), 1);
  });

  test("auto start off still allows starting by hand afterwards", async () => {
    const { clock, controller, policy } = setup({ policy: { autoStartBackend: false } });
    await controller.startup();
    policy.autoStartBackend = true;

    const submission = controller.start();
    assert.ok(submission.accepted);
    await clock.advance(START_MS);
    assert.deepEqual(await submission.settled, { status: "started" });
  });
});

describe("releasing the controller", () => {
  test("dispose stops listening and abandons what was in flight", async () => {
    const { clock, controller } = setup({ backend: (clock) => createDelayedProvider({ clock }) });
    let notified = 0;
    controller.subscribe(() => {
      notified += 1;
    });

    const submission = controller.start();
    assert.ok(submission.accepted);
    const before = notified;
    controller.dispose();

    assert.deepEqual(await submission.settled, { status: "cancelled" });
    await clock.advance(1000);
    assert.equal(notified, before, "nothing is published after dispose");
  });

  test("everything is inert after dispose, and refuses rather than pretending", async () => {
    const { controller, becomeReady } = setup();
    await becomeReady();
    controller.dispose();

    const submission = controller.start();
    assert.equal(submission.accepted, false);
    assert.equal(submission.accepted === false ? submission.error.code : null, "PROVIDER_INVALID_STATE");
    assert.equal((await controller.restart()).status, "failed");
    await controller.stop();
    controller.refreshCapabilities();
  });

  test("dispose twice is harmless", async () => {
    const { controller, becomeReady } = setup();
    await becomeReady();
    controller.dispose();
    controller.dispose();
  });

  test("no timer is left behind once a lifecycle operation has settled", async () => {
    const { clock, controller, becomeReady } = setup();
    await becomeReady();
    const stopping = controller.stop();
    await clock.advance(STOP_MS + 500);
    await stopping;
    controller.dispose();
    await clock.advance(1000);

    assert.equal(clock.pendingTimers(), 0, "a settled operation leaves no timer armed");
  });
});

describe("what reaches the console", () => {
  test("every lifecycle step is reported once, and names the backend", async () => {
    const { clock, controller, log, becomeReady } = setup();
    await becomeReady();
    const stopping = controller.stop();
    await clock.advance(STOP_MS + 400);
    await stopping;

    const messages = log.lines.filter((line) => line.level === "info").map((line) => line.message);
    assert.deepEqual(messages, [
      "Starting the developer backend",
      "Developer backend ready",
      "Stopping the developer backend",
      "Developer backend stopped",
    ]);
    for (const line of log.lines.filter((entry) => entry.level === "info")) {
      assert.equal(line.data, "Backend: Harness Mock");
    }
  });

  test("a refusal is a warning with its code, never a silent no-op", async () => {
    const { clock, controller, log, becomeReady } = setup();
    await becomeReady();
    const stopping = controller.stop();
    controller.start();

    const warning = log.lines.find((line) => line.level === "warn");
    assert.ok(warning, "the refusal was logged");
    assert.match(String(warning?.data), /PROVIDER_INVALID_STATE/);

    await clock.advance(STOP_MS + 400);
    await stopping;
  });

  test("no diagnostic carries anything but Nova's own state", async () => {
    const { clock, controller, log, becomeReady } = setup();
    await becomeReady();
    const stopping = controller.stop();
    await clock.advance(STOP_MS + 400);
    await stopping;

    const text = log.lines.map((line) => `${line.message} ${String(line.data ?? "")}`).join("\n");
    for (const forbidden of [/\bpid\b/i, /0x[0-9a-f]{4,}/i, /\.exe\b/i, /ReadProcessMemory/i]) {
      assert.ok(!forbidden.test(text), `a diagnostic must not mention ${forbidden}`);
    }
  });
});

describe("the state machine seen from the controller", () => {
  test("no snapshot ever reports a state outside the machine", async () => {
    const { clock, controller, becomeReady } = setup();
    const seen = new Set<BackendState>();
    controller.subscribe(() => seen.add(controller.getSnapshot().state));

    await becomeReady();
    const stopping = controller.stop();
    await clock.advance(STOP_MS + 400);
    await stopping;

    for (const state of seen) assert.ok(BACKEND_STATES.includes(state), state);
  });
});

describe("a subscriber that acts on what it is told", () => {
  test("stopping the backend from inside the starting notification does not break the state machine", async () => {
    const { clock, controller, backend } = setup({ backend: (clock) => createDelayedProvider({ clock }) });

    // The operation has to be registered before "starting" is published, or this
    // stop finds a state machine that has moved with nothing to abandon — and the
    // start that follows it throws an invalid transition.
    let stopped = false;
    controller.subscribe(() => {
      if (stopped || controller.getSnapshot().state !== "starting") return;
      stopped = true;
      void controller.stop();
    });

    const submission = controller.start();
    assert.ok(submission.accepted);
    await clock.advance(2000);

    assert.deepEqual(await submission.settled, { status: "cancelled" });
    assert.equal(controller.getSnapshot().state, "stopped");
    assert.equal(controller.getSnapshot().error, null, "an abandoned start is not a failure");
    assert.equal(backend.starts(), 0, "the backend was never asked to start at all, because the stop landed first");
    controller.dispose();
  });

  test("a backend is never asked to start after a subscriber has stopped it", async () => {
    const clock = createFakeClock();
    const inner = createMockBackend({ clock, startMs: START_MS, stopMs: STOP_MS });
    let asked = 0;
    const counted: DeveloperBackend = {
      ...inner,
      start: (options) => {
        asked += 1;
        return inner.start(options);
      },
    };
    const controller = createBackendController({
      backend: counted,
      clock,
      log: recordingLog(),
      policy: () => ({ autoStartBackend: true }),
      startTimeoutMs: START_TIMEOUT_MS,
    });

    let stopped = false;
    controller.subscribe(() => {
      if (stopped || controller.getSnapshot().state !== "starting") return;
      stopped = true;
      void controller.stop();
    });

    const submission = controller.start();
    assert.ok(submission.accepted);
    await clock.advance(1000);

    assert.equal(asked, 0, "the body is skipped once the operation is no longer live");
    assert.equal(controller.getSnapshot().state, "stopped");
    controller.dispose();
  });
});

describe("a backend that will not let go", () => {
  test("a stop that never answers cannot hang the caller once the start was abandoned", async () => {
    const clock = createFakeClock();
    const inner = createMockBackend({ clock, startMs: 600_000 });
    const neverStops: DeveloperBackend = { ...inner, stop: () => new Promise<void>(() => undefined) };
    const controller = createBackendController({
      backend: neverStops,
      clock,
      log: recordingLog(),
      policy: () => ({ autoStartBackend: true }),
      startTimeoutMs: START_TIMEOUT_MS,
      stopTimeoutMs: STOP_TIMEOUT_MS,
    });

    const submission = controller.start();
    assert.ok(submission.accepted);
    // Abandoning the start must not wait for a cleanup that never finishes.
    await controller.stop();

    assert.equal(controller.getSnapshot().state, "stopped");
    assert.deepEqual(await submission.settled, { status: "cancelled" });
    controller.dispose();
  });

  test("a stop that never answers is ended by the stop timeout, not left stopping", async () => {
    const clock = createFakeClock();
    const inner = createMockBackend({ clock, startMs: START_MS });
    let block = false;
    const stubborn: DeveloperBackend = {
      ...inner,
      stop: () => (block ? new Promise<void>(() => undefined) : inner.stop()),
    };
    const controller = createBackendController({
      backend: stubborn,
      clock,
      log: recordingLog(),
      policy: () => ({ autoStartBackend: true }),
      startTimeoutMs: START_TIMEOUT_MS,
      stopTimeoutMs: STOP_TIMEOUT_MS,
    });

    const started = controller.start();
    assert.ok(started.accepted);
    await clock.advance(START_MS);
    await started.settled;

    block = true;
    const stopping = controller.stop();
    await clock.advance(STOP_TIMEOUT_MS);
    await stopping;

    assert.equal(controller.getSnapshot().state, "error", "it is never left in stopping");
    assert.equal(controller.getSnapshot().error?.code, "PROVIDER_TIMEOUT");
    assert.equal(controller.getSnapshot().busy, false, "nothing is left spinning");
    controller.dispose();
  });

  test("a start that timed out releases the backend rather than leaving it half started", async () => {
    const clock = createFakeClock();
    const inner = createMockBackend({ clock, startMs: START_TIMEOUT_MS * 2 });
    let released = 0;
    const watched: DeveloperBackend = {
      ...inner,
      stop: async () => {
        released += 1;
        await inner.stop();
      },
    };
    const controller = createBackendController({
      backend: watched,
      clock,
      log: recordingLog(),
      policy: () => ({ autoStartBackend: true }),
      startTimeoutMs: START_TIMEOUT_MS,
    });

    const submission = controller.start();
    assert.ok(submission.accepted);
    await clock.advance(START_TIMEOUT_MS);
    await submission.settled;

    assert.equal(controller.getSnapshot().error?.code, "PROVIDER_TIMEOUT");
    assert.ok(released >= 1, "a timed-out start must not leave the backend running");
    controller.dispose();
  });

  test("dispose survives a backend that throws synchronously while stopping", async () => {
    const clock = createFakeClock();
    const inner = createMockBackend({ clock, startMs: START_MS });
    const throwing: DeveloperBackend = {
      ...inner,
      stop: () => {
        throw new Error("the backend threw on the spot");
      },
    };
    const controller = createBackendController({
      backend: throwing,
      clock,
      log: recordingLog(),
      policy: () => ({ autoStartBackend: true }),
    });

    const started = controller.start();
    assert.ok(started.accepted);
    await clock.advance(START_MS);
    await started.settled;

    // A synchronous throw happens before any promise wraps it, so dispose has to
    // catch it itself or shutdown fails.
    controller.dispose();
  });
});
