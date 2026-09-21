import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createUnsupportedDebuggerProvider,
  createUnsupportedProfilerProvider,
  createUnsupportedTargetProvider,
  UNSUPPORTED_PROVIDER_TYPE,
} from "@/features/backend/providers/unsupported";
import { createDebuggerController } from "@/features/debugger/debuggerController";
import type { DebugTarget } from "@/features/debugger/types";
import { createProfilerController } from "@/features/profiler/profilerController";
import { createTargetController } from "@/features/target/targetController";
import { createFakeClock } from "@/lib/testing/fakeClock";

/**
 * The stand-ins for a tool a backend does not supply.
 *
 * The one thing being checked here is that they refuse in the open: every
 * operation answers with the tool's own structured error code and nothing reports
 * a success that did not happen. A provider that quietly answered "fine" would be
 * worse than no provider at all, because the UI would believe it.
 */

const BACKEND = "Test Backend";
const TARGET: DebugTarget = { scriptId: "script-1", scriptName: "Main.lua", lineCount: 12 };

const silent = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

describe("an unsupported target provider", () => {
  test("it never reports a target, so nothing can ask to inject", async () => {
    const provider = createUnsupportedTargetProvider(BACKEND);
    assert.deepEqual(await provider.detect(), { available: false, ready: false, targetVersion: null });
  });

  test("it declares itself unsupported rather than simulated", () => {
    const provider = createUnsupportedTargetProvider(BACKEND);
    assert.equal(provider.providerType, UNSUPPORTED_PROVIDER_TYPE);
    assert.equal(provider.simulated, false, "a refusal is not test data");
    assert.equal(provider.supportsCancel, false);
  });

  test("an injection is refused with PROVIDER_UNAVAILABLE and names the backend", async () => {
    const provider = createUnsupportedTargetProvider(BACKEND);
    const outcome = await provider.inject(
      { requestId: "r1", createdAt: 0, providerType: UNSUPPORTED_PROVIDER_TYPE },
      { signal: new AbortController().signal },
    );
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.status === "failed" ? outcome.error.code : null, "PROVIDER_UNAVAILABLE");
    assert.match(outcome.status === "failed" ? (outcome.error.details ?? "") : "", /Test Backend/);
  });

  test("its diagnostics claim no transport, no session and no version", () => {
    const diagnostics = createUnsupportedTargetProvider(BACKEND).getDiagnostics();
    assert.equal(diagnostics.transport, "None");
    assert.equal(diagnostics.session, "inactive");
    assert.equal(diagnostics.latency, null);
    assert.equal(diagnostics.targetVersion, null);
  });

  test("the real target controller on top of it stays unavailable and refuses an inject", async () => {
    const clock = createFakeClock();
    const controller = createTargetController({
      provider: createUnsupportedTargetProvider(BACKEND),
      clock,
      log: silent,
      policy: () => ({ autoDetect: true, autoInject: true, autoReconnect: false, injectTimeoutMs: 5000 }),
    });

    const pass = controller.detect();
    await clock.advance(50);
    assert.equal(await pass, "unavailable");

    const submission = controller.inject();
    assert.equal(submission.accepted, false, "nothing may be started against a provider that has nothing");
    assert.equal(submission.accepted === false ? submission.error.code : null, "TARGET_UNAVAILABLE");
    controller.dispose();
  });
});

describe("an unsupported debugger provider", () => {
  test("starting a session is refused with DEBUGGER_UNAVAILABLE", async () => {
    const provider = createUnsupportedDebuggerProvider(BACKEND);
    const outcome = await provider.start(
      { sessionId: "s1", target: TARGET, context: null, createdAt: 0 },
      [],
      { signal: new AbortController().signal },
    );
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.status === "failed" ? outcome.error.code : null, "DEBUGGER_UNAVAILABLE");
  });

  test("resuming is refused the same way, not answered with a fabricated stop", async () => {
    const provider = createUnsupportedDebuggerProvider(BACKEND);
    const outcome = await provider.resume("s1", "continue", [], { signal: new AbortController().signal });
    assert.equal(outcome.status, "failed", "a step that cannot happen must not report a pause");
  });

  test("it reports no variables and evaluates nothing", () => {
    const provider = createUnsupportedDebuggerProvider(BACKEND);
    assert.deepEqual(provider.getVariables("s1", "f1"), []);
    const evaluation = provider.evaluate("s1", "f1", "count");
    assert.equal(evaluation.status, "error");
    assert.equal(evaluation.status === "error" ? evaluation.error.code : null, "WATCH_EVALUATION_FAILED");
  });

  test("its description says what is missing, for the surfaces that show it", () => {
    const provider = createUnsupportedDebuggerProvider(BACKEND);
    assert.match(provider.description, /no debugger/i);
    assert.equal(provider.simulated, false);
    assert.equal(provider.supportsCancel, false);
  });

  test("the real debugger controller on top of it never claims to be paused", async () => {
    const clock = createFakeClock();
    const controller = createDebuggerController({
      provider: createUnsupportedDebuggerProvider(BACKEND),
      clock,
      log: silent,
    });

    // A backend without a debugger is never marked present by the devtools
    // binding, so this is the belt-and-braces path: even told it has a target,
    // nothing is fabricated.
    controller.setTargetPresent(true);
    const submission = controller.start({ target: TARGET });
    assert.ok(submission.accepted, "the controller accepts it and the provider refuses it");

    await clock.advance(200);
    const result = await submission.settled;
    assert.equal(result.status, "failed");
    assert.equal(result.status === "failed" ? result.error.code : null, "DEBUGGER_UNAVAILABLE");
    assert.equal(controller.getSnapshot().state, "error");
    assert.deepEqual(controller.getSnapshot().stack, [], "no stack is invented for a session that never ran");
    assert.equal(controller.getSnapshot().busy, false, "the UI is not left waiting");
    controller.dispose();
  });

  test("breakpoints still work, because they are Nova's own configuration", () => {
    const clock = createFakeClock();
    const controller = createDebuggerController({
      provider: createUnsupportedDebuggerProvider(BACKEND),
      clock,
      log: silent,
    });

    const added = controller.addBreakpoint("script-1", 4);
    assert.equal(added.status, "added", "a breakpoint does not need a provider to exist");
    assert.equal(controller.getSnapshot().breakpoints.length, 1);
    controller.dispose();
  });
});

describe("an unsupported profiler provider", () => {
  test("starting and stopping a recording are both refused with PROFILER_UNAVAILABLE", async () => {
    const provider = createUnsupportedProfilerProvider(BACKEND);
    const started = await provider.start(
      { sessionId: "s1", startedAt: 0 },
      { signal: new AbortController().signal },
    );
    assert.equal(started.status, "failed");
    assert.equal(started.status === "failed" ? started.error.code : null, "PROFILER_UNAVAILABLE");

    const stopped = await provider.stop(
      "s1",
      { endedAt: 1, durationMs: 1 },
      { signal: new AbortController().signal },
    );
    assert.equal(stopped.status, "failed", "a recording that never ran must not hand back samples");
  });

  test("it holds no samples to read back", () => {
    assert.equal(createUnsupportedProfilerProvider(BACKEND).read("s1"), null);
  });

  test("the real profiler controller on top of it reports the failure and records nothing", async () => {
    const clock = createFakeClock();
    const controller = createProfilerController({
      provider: createUnsupportedProfilerProvider(BACKEND),
      clock,
      log: silent,
    });

    controller.setTargetPresent(true);
    const submission = controller.start();
    assert.ok(submission.accepted);

    await clock.advance(200);
    const result = await submission.settled;
    assert.equal(result.status, "failed");
    assert.equal(controller.getSnapshot().state, "error");
    assert.equal(controller.getSnapshot().session, null, "no session is invented");
    assert.equal(controller.getSnapshot().busy, false);
    controller.dispose();
  });
});
