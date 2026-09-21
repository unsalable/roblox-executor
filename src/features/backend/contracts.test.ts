import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createBackendController } from "@/features/backend/backendController";
import {
  createLocalMockDeveloperBackend,
  LOCAL_MOCK_BACKEND_ID,
  LOCAL_MOCK_BACKEND_LABEL,
} from "@/features/backend/backends/LocalMockDeveloperBackend";
import { deriveCapabilities } from "@/features/backend/capabilities";
import { DEVELOPER_TOOLS } from "@/features/backend/types";
import type { BackendProviders, DeveloperBackend } from "@/features/backend/types";
import { createDebuggerController, type DebuggerController } from "@/features/debugger/debuggerController";
import type { DebugTarget } from "@/features/debugger/types";
import { createProfilerController, type ProfilerController } from "@/features/profiler/profilerController";
import { createTargetController, type TargetController } from "@/features/target/targetController";
import { createFakeClock, type FakeClock } from "@/lib/testing/fakeClock";

/**
 * Contract tests for the providers a backend supplies.
 *
 * These are not the controller tests again: what is checked here is
 * that the providers reached *through a backend* still satisfy the contracts the
 * controllers were built against. Composition is the thing that can break, so the
 * real controllers are put on the real providers the backend handed over, and
 * every provider in the set is exercised end to end.
 *
 * One fake clock drives the backend, all three providers and all three
 * controllers, so their timers interleave deterministically.
 */

const START_MS = 40;
const SETTLE_MS = 1000;
const TARGET: DebugTarget = { scriptId: "script-1", scriptName: "Main.lua", lineCount: 40 };

const silent = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

interface Harness {
  clock: FakeClock;
  backend: DeveloperBackend;
  providers: BackendProviders;
  controller: ReturnType<typeof createBackendController>;
  target: TargetController;
  debug: DebuggerController;
  profiler: ProfilerController;
  /** Starts the backend and waits for it to be ready. */
  startBackend: () => Promise<void>;
  /** Runs a detection pass and waits for the target to settle. */
  detect: () => Promise<void>;
  /** Injects and waits for the result. */
  inject: () => Promise<void>;
  dispose: () => void;
}

function setup(): Harness {
  const clock = createFakeClock();
  const backend = createLocalMockDeveloperBackend({ clock, startMs: START_MS });
  const providers = backend.providers;

  const controller = createBackendController({
    backend,
    clock,
    log: silent,
    policy: () => ({ autoStartBackend: true }),
  });

  // The providers come out of the backend; the controllers know nothing else.
  const target = createTargetController({
    provider: providers.target!,
    clock,
    log: silent,
    policy: () => ({ autoDetect: true, autoInject: false, autoReconnect: false, injectTimeoutMs: 5000 }),
  });
  const debug = createDebuggerController({ provider: providers.debugger!, clock, log: silent });
  const profiler = createProfilerController({ provider: providers.profiler!, clock, log: silent });

  return {
    clock,
    backend,
    providers,
    controller,
    target,
    debug,
    profiler,
    startBackend: async () => {
      const submission = controller.start();
      assert.ok(submission.accepted);
      await clock.advance(START_MS);
      await submission.settled;
    },
    detect: async () => {
      const pass = target.detect();
      await clock.advance(SETTLE_MS);
      await pass;
    },
    inject: async () => {
      const submission = target.inject();
      assert.ok(submission.accepted, "the injection was refused");
      await clock.advance(SETTLE_MS);
      await submission.result;
    },
    dispose: () => {
      profiler.dispose();
      debug.dispose();
      target.dispose();
      controller.dispose();
    },
  };
}

describe("the backend contract", () => {
  test("the shipped backend names itself and declares that it is simulated", () => {
    const { backend, dispose } = setup();
    assert.equal(backend.descriptor.id, LOCAL_MOCK_BACKEND_ID);
    assert.equal(backend.descriptor.label, LOCAL_MOCK_BACKEND_LABEL);
    assert.equal(backend.descriptor.simulated, true);
    dispose();
  });

  test("it supplies all three tools, and derives the capabilities they declare", () => {
    const { providers, dispose } = setup();
    for (const tool of DEVELOPER_TOOLS) {
      assert.ok(providers[tool] !== null, `${tool} must be supplied`);
    }
    assert.deepEqual(deriveCapabilities(providers), {
      target: { canConnect: true, canCancelInject: true },
      debugger: { canDebug: true, canPause: true },
      profiler: { canProfile: true },
    });
    dispose();
  });

  test("a backend that has not started reports no target, so ready and available cannot disagree", async () => {
    const { detect, target, dispose } = setup();
    await detect();
    assert.equal(target.getSnapshot().status, "unavailable", "a stopped backend has no target to find");
    dispose();
  });

  test("starting the backend makes its target visible; detecting it is still Nova's decision", async () => {
    const { startBackend, detect, target, dispose } = setup();
    await startBackend();
    await detect();
    assert.equal(target.getSnapshot().status, "ready");
    dispose();
  });

  test("every provider it supplies reports itself as simulated", () => {
    const { providers, dispose } = setup();
    assert.equal(providers.target?.simulated, true);
    assert.equal(providers.debugger?.simulated, true);
    assert.equal(providers.profiler?.simulated, true);
    dispose();
  });

  test("its health says which tool is not usable, and why", async () => {
    const { backend, startBackend, dispose } = setup();
    await startBackend();
    const health = backend.getHealth();
    assert.equal(health.find((report) => report.tool === "target")?.health, "healthy");

    // The simulated target is switched off: the backend is still ready.
    const mock = createLocalMockDeveloperBackend({ clock: createFakeClock(), availability: "unavailable" });
    const report = mock.getHealth().find((entry) => entry.tool === "target");
    assert.equal(report?.health, "unavailable");
    assert.match(report?.reason ?? "", /switched off/);
    dispose();
  });
});

describe("the target provider contract, through the backend", () => {
  test("detection goes unavailable → detected → ready and reports a version", async () => {
    const { startBackend, target, detect, dispose } = setup();
    const states: string[] = [target.getSnapshot().status];
    target.subscribe(() => {
      const { status } = target.getSnapshot();
      if (states[states.length - 1] !== status) states.push(status);
    });

    await startBackend();
    await detect();

    assert.deepEqual(states, ["unavailable", "detected", "ready"]);
    assert.equal(target.getSnapshot().diagnostics.targetVersion, "Test Target v1");
    dispose();
  });

  test("an injection completes and opens a session", async () => {
    const { startBackend, detect, inject, target, dispose } = setup();
    await startBackend();
    await detect();
    await inject();

    const snapshot = target.getSnapshot();
    assert.equal(snapshot.status, "injected");
    assert.equal(snapshot.session, "active", "injected without a session");
    assert.equal(snapshot.result?.success, true);
    dispose();
  });

  test("a disconnect ends the session and leaves the target ready to inject again", async () => {
    const { clock, startBackend, detect, inject, target, dispose } = setup();
    await startBackend();
    await detect();
    await inject();

    const disconnecting = target.disconnect();
    await clock.advance(SETTLE_MS);
    await disconnecting;

    assert.equal(target.getSnapshot().status, "ready");
    assert.equal(target.getSnapshot().session, "inactive");
    dispose();
  });

  test("cancellation is real: the provider stops and the request settles as cancelled", async () => {
    const { clock, startBackend, detect, target, dispose } = setup();
    await startBackend();
    await detect();

    const submission = target.inject();
    assert.ok(submission.accepted);
    assert.equal(target.cancelInject(), "requested");
    await clock.advance(SETTLE_MS);
    const result = await submission.result;

    assert.equal(result.cancelled, true);
    assert.equal(target.getSnapshot().status, "cancelled");
    dispose();
  });

  test("a provider that never answers is abandoned by the timeout, and a late answer is ignored", async () => {
    const { clock, startBackend, detect, target, backend, dispose } = setup();
    await startBackend();
    await detect();

    const mock = backend as ReturnType<typeof createLocalMockDeveloperBackend>;
    mock.testSwitches.setScenario("timeout");

    const submission = target.inject({ timeoutMs: 200 });
    assert.ok(submission.accepted);
    await clock.advance(200);
    const result = await submission.result;

    assert.equal(result.error?.code, "INJECTION_TIMEOUT");
    await clock.advance(700_000);
    assert.notEqual(target.getSnapshot().status, "injected", "a timed-out request never becomes injected");
    dispose();
  });
});

describe("the debugger provider contract, through the backend", () => {
  async function paused(harness: Harness) {
    const { clock, startBackend, detect, debug } = harness;
    await startBackend();
    await detect();
    debug.setTargetPresent(true);

    const submission = debug.start({ target: TARGET });
    assert.ok(submission.accepted, "the session was refused");
    await clock.advance(SETTLE_MS);
    await submission.settled;
    assert.equal(debug.getSnapshot().state, "paused");
  }

  test("a session starts, stops on its first line and reports a stack", async () => {
    const harness = setup();
    await paused(harness);

    const snapshot = harness.debug.getSnapshot();
    assert.equal(snapshot.pauseReason, "entry");
    assert.ok(snapshot.stack.length > 0, "a stop must have a stack to inspect");
    assert.equal(snapshot.stack[0]?.scriptId, TARGET.scriptId);
    assert.ok(snapshot.locals.length > 0, "the innermost frame has variables");
    harness.dispose();
  });

  test("continue runs to the next enabled breakpoint", async () => {
    const harness = setup();
    const { clock, debug } = harness;
    assert.equal(debug.addBreakpoint(TARGET.scriptId, 20).status, "added");
    await paused(harness);

    const resumed = debug.resume("continue");
    assert.ok(resumed.accepted);
    await clock.advance(SETTLE_MS);
    await resumed.settled;

    const snapshot = debug.getSnapshot();
    assert.equal(snapshot.state, "paused");
    assert.equal(snapshot.pauseReason, "breakpoint");
    assert.equal(snapshot.stack[0]?.line, 20);
    assert.equal(snapshot.breakpoints[0]?.hitCount, 1, "the hit is counted on Nova's own record");
    harness.dispose();
  });

  test("each of the three steps moves forward and says it was a step", async () => {
    const harness = setup();
    const { clock, debug } = harness;
    await paused(harness);

    const lines: number[] = [debug.getSnapshot().stack[0]?.line ?? 0];
    for (const mode of ["step-into", "step-over", "step-out"] as const) {
      if (debug.getSnapshot().state !== "paused") break;
      const resumed = debug.resume(mode);
      assert.ok(resumed.accepted, mode);
      await clock.advance(SETTLE_MS);
      const result = await resumed.settled;
      // A step near the end of the script runs the session to completion, which
      // is a legitimate outcome and not a stop to inspect.
      if (result.status !== "paused") break;
      assert.equal(debug.getSnapshot().pauseReason, "step", mode);
      lines.push(debug.getSnapshot().stack[0]?.line ?? 0);
    }

    assert.ok(lines.length > 1, "no step produced a stop");
    for (let index = 1; index < lines.length; index += 1) {
      assert.ok(lines[index]! > lines[index - 1]!, `step ${index} did not move forward: ${lines.join(" → ")}`);
    }
    harness.dispose();
  });

  test("a pause request lands on the next execution point", async () => {
    const harness = setup();
    const { clock, debug } = harness;
    await paused(harness);

    const resumed = debug.resume("continue");
    assert.ok(resumed.accepted);
    assert.equal(debug.pause(), "requested");
    await clock.advance(SETTLE_MS);
    await resumed.settled;

    assert.equal(debug.getSnapshot().state, "paused");
    assert.equal(debug.getSnapshot().pauseReason, "pause");
    assert.equal(debug.getSnapshot().pausePending, false, "the pending flag is cleared once it stopped");
    harness.dispose();
  });

  test("stopping ends the session rather than leaving it claiming to be paused", async () => {
    const harness = setup();
    const { clock, debug } = harness;
    await paused(harness);

    const stopping = debug.stop();
    await clock.advance(SETTLE_MS);
    await stopping;

    assert.equal(debug.getSnapshot().state, "stopped");
    assert.equal(debug.getSnapshot().session?.stopReason, "stopped");
    assert.deepEqual(debug.getSnapshot().stack, []);
    harness.dispose();
  });

  test("a watch reads a name against the paused frame, and refuses anything that would run code", async () => {
    const harness = setup();
    const { debug } = harness;
    await paused(harness);

    const context = debug.addWatch("frame");
    assert.ok(context !== null);
    const call = debug.addWatch("doSomething()");
    assert.ok(call !== null);
    assert.ok(call.error !== null, "a call must never be evaluated");
    harness.dispose();
  });
});

describe("the profiler provider contract, through the backend", () => {
  test("a recording starts, stops and aggregates what it collected", async () => {
    const { clock, startBackend, detect, profiler, dispose } = setup();
    await startBackend();
    await detect();
    profiler.setTargetPresent(true);

    const started = profiler.start();
    assert.ok(started.accepted);
    await clock.advance(SETTLE_MS);
    assert.deepEqual(await started.settled, { status: "started" });
    assert.equal(profiler.getSnapshot().state, "recording");

    await clock.advance(2000);
    const stopped = profiler.stop();
    assert.ok(stopped.accepted);
    await clock.advance(SETTLE_MS);
    const result = await stopped.settled;

    assert.equal(result.status, "stopped");
    const session = profiler.getSnapshot().session;
    assert.ok(session !== null);
    assert.ok(session.samples.length > 0, "a recording produced no samples");
    assert.ok(session.frames.length > 0, "samples were not aggregated into frames");
    assert.equal(session.simulated, true, "the numbers must be labelled as generated");
    dispose();
  });

  test("the percentages of the aggregated frames add up", async () => {
    const { clock, startBackend, detect, profiler, dispose } = setup();
    await startBackend();
    await detect();
    profiler.setTargetPresent(true);

    const started = profiler.start();
    assert.ok(started.accepted);
    await clock.advance(SETTLE_MS);
    await started.settled;
    await clock.advance(2000);
    const stopped = profiler.stop();
    assert.ok(stopped.accepted);
    await clock.advance(SETTLE_MS);
    await stopped.settled;

    const frames = profiler.getSnapshot().session?.frames ?? [];
    const total = frames.reduce((sum, frame) => sum + frame.percentage, 0);
    assert.ok(Math.abs(total - 100) < 0.5, `percentages add up to ${total}`);
    dispose();
  });

  test("the same backend produces the same numbers twice, which is what makes it testable", async () => {
    const record = async () => {
      const harness = setup();
      await harness.startBackend();
      await harness.detect();
      harness.profiler.setTargetPresent(true);
      const started = harness.profiler.start();
      assert.ok(started.accepted);
      await harness.clock.advance(SETTLE_MS);
      await started.settled;
      await harness.clock.advance(2000);
      const stopped = harness.profiler.stop();
      assert.ok(stopped.accepted);
      await harness.clock.advance(SETTLE_MS);
      await stopped.settled;
      const frames = harness.profiler.getSnapshot().session?.frames ?? [];
      harness.dispose();
      return frames.map((frame) => `${frame.name}:${frame.sampleCount}`);
    };

    assert.deepEqual(await record(), await record());
  });

  test("a finished recording can be read again from the provider", async () => {
    const { clock, startBackend, detect, profiler, dispose } = setup();
    await startBackend();
    await detect();
    profiler.setTargetPresent(true);

    const started = profiler.start();
    assert.ok(started.accepted);
    await clock.advance(SETTLE_MS);
    await started.settled;
    await clock.advance(2000);
    const stopped = profiler.stop();
    assert.ok(stopped.accepted);
    await clock.advance(SETTLE_MS);
    await stopped.settled;

    const before = profiler.getSnapshot().session?.summary.sampleCount;
    assert.equal(profiler.refresh(), true, "the provider still holds the samples");
    assert.equal(profiler.getSnapshot().session?.summary.sampleCount, before);
    dispose();
  });
});

describe("the developer test switches", () => {
  test("switching the target on while the backend is stopped does not make one appear", async () => {
    const { backend, detect, target, dispose } = setup();
    const mock = backend as ReturnType<typeof createLocalMockDeveloperBackend>;

    mock.testSwitches.setAvailability("available");
    await detect();

    assert.equal(
      target.getSnapshot().status,
      "unavailable",
      "a backend that is not running has no target to show, whatever the switch says",
    );
    assert.equal(mock.testSwitches.getAvailability(), "available", "the developer's intent is remembered");
    dispose();
  });

  test("the intent is applied when the backend starts", async () => {
    const { backend, startBackend, detect, target, dispose } = setup();
    const mock = backend as ReturnType<typeof createLocalMockDeveloperBackend>;

    mock.testSwitches.setAvailability("unavailable");
    await startBackend();
    await detect();
    assert.equal(target.getSnapshot().status, "unavailable", "starting honours the switch instead of overriding it");

    mock.testSwitches.setAvailability("available");
    await detect();
    assert.equal(target.getSnapshot().status, "ready");
    dispose();
  });

  test("a restart keeps what the developer set rather than overwriting it", async () => {
    const { clock, backend, controller, startBackend, detect, target, dispose } = setup();
    const mock = backend as ReturnType<typeof createLocalMockDeveloperBackend>;

    await startBackend();
    mock.testSwitches.setAvailability("unavailable");
    await clock.advance(SETTLE_MS);
    assert.equal(target.getSnapshot().status, "unavailable");

    const restarting = controller.restart();
    await clock.advance(START_MS + SETTLE_MS);
    await restarting;
    await detect();

    assert.equal(
      target.getSnapshot().status,
      "unavailable",
      "a restart must not silently switch the simulated target back on",
    );
    dispose();
  });

  test("a stopped backend reports its target as unavailable however the switch is set", async () => {
    const { clock, backend, controller, startBackend, dispose } = setup();
    const mock = backend as ReturnType<typeof createLocalMockDeveloperBackend>;
    await startBackend();

    const stopping = controller.stop();
    await clock.advance(SETTLE_MS);
    await stopping;

    mock.testSwitches.setAvailability("available");
    const report = mock.getHealth().find((entry) => entry.tool === "target");
    assert.equal(report?.health, "unavailable", "health follows the backend, not just the switch");
    dispose();
  });
});
