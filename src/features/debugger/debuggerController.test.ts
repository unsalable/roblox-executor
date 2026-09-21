import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createDebuggerController,
  type DebuggerController,
  type DebuggerLog,
} from "@/features/debugger/debuggerController";
import { createMockDebuggerProvider } from "@/features/debugger/providers/MockDebuggerProvider";
import type {
  Breakpoint,
  DebugRunOutcome,
  DebugTarget,
  DebuggerProvider,
} from "@/features/debugger/types";
import { createFakeClock, type FakeClock } from "@/lib/testing/fakeClock";

/**
 * The debugger controller against the mock provider, with a fake clock: every
 * timing below is a timer the test moves, so nothing waits in real time and the
 * same sequence always produces the same stops.
 */

const TARGET: DebugTarget = { scriptId: "s1", scriptName: "Main.lua", lineCount: 20 };

/**
 * For a 20-line script the mock program is:
 * lines 1–5 `main`, 6–9 `update`, 10–14 `calculate`, 15–20 `main` again.
 */
const START_MS = 180;
const RESUME_MS = 90;
const STOP_MS = 120;

interface Recorded {
  level: string;
  message: string;
}

function createLog(): DebuggerLog & { entries: Recorded[] } {
  const entries: Recorded[] = [];
  const write = (level: string) => (message: string) => {
    entries.push({ level, message });
  };
  return { entries, debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") };
}

interface Setup {
  controller: DebuggerController;
  clock: FakeClock;
  log: DebuggerLog & { entries: Recorded[] };
  persisted: () => readonly Breakpoint[] | null;
  writes: () => number;
}

function setup(options: { provider?: DebuggerProvider; targetPresent?: boolean } = {}): Setup {
  const clock = createFakeClock();
  const log = createLog();
  let persisted: readonly Breakpoint[] | null = null;
  let writes = 0;
  let ids = 0;

  const controller = createDebuggerController({
    provider: options.provider ?? createMockDebuggerProvider({ clock }),
    clock,
    createId: () => `id-${++ids}`,
    onBreakpointsChanged: (breakpoints) => {
      persisted = breakpoints;
      writes += 1;
    },
    log,
  });

  if (options.targetPresent !== false) controller.setTargetPresent(true);
  return { controller, clock, log, persisted: () => persisted, writes: () => writes };
}

/** Starts a session and settles it on its first stop. */
async function startPaused(setupResult: Setup) {
  const submission = setupResult.controller.start({ target: TARGET });
  assert.ok(submission.accepted);
  await setupResult.clock.advance(START_MS);
  return submission;
}

/** Leaves a stop and settles wherever it lands. */
async function resume(
  setupResult: Setup,
  mode: "continue" | "step-over" | "step-into" | "step-out",
) {
  const submission = setupResult.controller.resume(mode);
  assert.ok(submission.accepted);
  await setupResult.clock.advance(RESUME_MS);
  return submission.settled;
}

/** Ends a session and lets the provider's own cleanup timer run. */
async function stopSession(fixture: Setup) {
  const done = fixture.controller.stop();
  await fixture.clock.advance(STOP_MS);
  await done;
}

const line = (controller: DebuggerController) => controller.getSnapshot().stack[0]?.line ?? null;

describe("debugger initial state", () => {
  test("a launch has no target, no session and no breakpoints", () => {
    const { controller } = setup({ targetPresent: false });
    const snapshot = controller.getSnapshot();

    assert.equal(snapshot.state, "unavailable");
    assert.equal(snapshot.session, null);
    assert.deepEqual(snapshot.stack, []);
    assert.deepEqual(snapshot.breakpoints, []);
    assert.deepEqual(snapshot.watches, []);
    assert.equal(snapshot.error, null);
  });

  test("a target appearing makes the debugger ready", () => {
    const { controller } = setup();
    assert.equal(controller.getSnapshot().state, "ready");
  });

  test("the provider's metadata is exposed without the provider itself", () => {
    const { controller } = setup();
    assert.equal(controller.provider.simulated, true);
    assert.equal(controller.provider.supportsCancel, true);
    assert.ok(controller.provider.description.length > 0);
  });

  test("a session cannot be started without a target", () => {
    const { controller } = setup({ targetPresent: false });
    const submission = controller.start({ target: TARGET });

    assert.equal(submission.accepted, false);
    assert.equal(submission.accepted === false && submission.error.code, "DEBUGGER_UNAVAILABLE");
  });
});

describe("starting and stopping a session", () => {
  test("a session stops at the first line, with a stack and variables", async () => {
    const fixture = setup();
    const submission = await startPaused(fixture);
    const result = await submission.settled;

    assert.deepEqual(result, { status: "paused", reason: "entry" });
    const snapshot = fixture.controller.getSnapshot();
    assert.equal(snapshot.state, "paused");
    assert.equal(snapshot.pauseReason, "entry");
    assert.equal(snapshot.stack.length, 1);
    assert.equal(snapshot.stack[0]?.functionName, "main()");
    assert.equal(snapshot.stack[0]?.line, 1);
    assert.equal(snapshot.currentFrameId, snapshot.stack[0]?.id);
    assert.ok(snapshot.locals.some((variable) => variable.name === "player"));
    assert.equal(snapshot.session?.target.scriptName, "Main.lua");
    assert.equal(snapshot.session?.endedAt, null);
  });

  test("a second session is refused while one is running", async () => {
    const fixture = setup();
    await startPaused(fixture);
    const second = fixture.controller.start({ target: TARGET });

    assert.equal(second.accepted, false);
    assert.equal(second.accepted === false && second.error.code, "DEBUGGER_NOT_READY");
  });

  test("a script with no lines has nothing to step through", () => {
    const { controller } = setup();
    const submission = controller.start({ target: { ...TARGET, lineCount: 0 } });

    assert.equal(submission.accepted, false);
    assert.equal(submission.accepted === false && submission.error.code, "DEBUGGER_NOT_READY");
  });

  test("stopping ends the session and leaves it readable", async () => {
    const fixture = setup();
    await startPaused(fixture);
    await stopSession(fixture);

    const snapshot = fixture.controller.getSnapshot();
    assert.equal(snapshot.state, "stopped");
    assert.equal(snapshot.session?.stopReason, "stopped");
    assert.notEqual(snapshot.session?.endedAt, null);
    assert.deepEqual(snapshot.stack, []);
    assert.equal(snapshot.currentFrameId, null);
  });

  test("a finished session is cleared back to ready, and another can be started", async () => {
    const fixture = setup();
    await startPaused(fixture);
    await stopSession(fixture);
    await stopSession(fixture);

    assert.equal(fixture.controller.getSnapshot().state, "ready");
    await startPaused(fixture);
    assert.equal(fixture.controller.getSnapshot().state, "paused");
  });

  test("a run with nothing to stop at ends as completed", async () => {
    const fixture = setup();
    await startPaused(fixture);
    const result = await resume(fixture, "continue");

    assert.deepEqual(result, { status: "completed" });
    const snapshot = fixture.controller.getSnapshot();
    assert.equal(snapshot.state, "stopped");
    assert.equal(snapshot.session?.stopReason, "completed");
  });
});

describe("stepping", () => {
  test("Step Into goes to the next line, whatever its depth", async () => {
    const fixture = setup();
    await startPaused(fixture);

    await resume(fixture, "step-into");
    assert.equal(line(fixture.controller), 2);
    assert.equal(fixture.controller.getSnapshot().pauseReason, "step");
  });

  test("Step Over skips the lines of a deeper call", async () => {
    const fixture = setup();
    await startPaused(fixture);
    // Walk to the last line of `main` before it calls `update`.
    for (let step = 0; step < 4; step += 1) await resume(fixture, "step-into");
    assert.equal(line(fixture.controller), 5);
    assert.equal(fixture.controller.getSnapshot().stack.length, 1);

    await resume(fixture, "step-over");
    // 6–14 are inside update() and calculate(); the next line at main's depth is 15.
    assert.equal(line(fixture.controller), 15);
    assert.equal(fixture.controller.getSnapshot().stack.length, 1);
  });

  test("Step Into descends into the call, and the stack grows with it", async () => {
    const fixture = setup();
    await startPaused(fixture);
    for (let step = 0; step < 5; step += 1) await resume(fixture, "step-into");

    assert.equal(line(fixture.controller), 6);
    const stack = fixture.controller.getSnapshot().stack;
    assert.deepEqual(
      stack.map((frame) => frame.functionName),
      ["update()", "main()"],
    );
    assert.equal(stack[0]?.depth, 0);
    assert.equal(stack[1]?.line, 5, "the caller shows the line it called from");
  });

  test("Step Out returns to the caller's depth", async () => {
    const fixture = setup();
    await startPaused(fixture);
    for (let step = 0; step < 5; step += 1) await resume(fixture, "step-into");
    assert.equal(fixture.controller.getSnapshot().stack.length, 2);

    await resume(fixture, "step-out");
    assert.equal(line(fixture.controller), 15);
    assert.equal(fixture.controller.getSnapshot().stack.length, 1);
  });

  test("stepping past the end of the program completes the session", async () => {
    const fixture = setup();
    await startPaused(fixture);
    let result = await resume(fixture, "step-out");
    // main() is the outermost frame, so there is nothing to step out to.
    assert.deepEqual(result, { status: "completed" });

    await startPaused(fixture);
    result = await resume(fixture, "step-over");
    assert.equal(result.status, "paused");
  });

  test("continuing is refused while the session is already running", async () => {
    const fixture = setup();
    await startPaused(fixture);
    const first = fixture.controller.resume("continue");
    assert.ok(first.accepted);

    const second = fixture.controller.resume("continue");
    assert.equal(second.accepted, false);
    assert.equal(second.accepted === false && second.error.code, "DEBUGGER_BUSY");
    await fixture.clock.advance(RESUME_MS);
  });

  test("continuing without a session is refused", () => {
    const { controller } = setup();
    const submission = controller.resume("continue");
    assert.equal(submission.accepted, false);
    assert.equal(submission.accepted === false && submission.error.code, "DEBUGGER_NO_SESSION");
  });
});

describe("breakpoints", () => {
  test("adding, removing and toggling act on the same line once", () => {
    const fixture = setup();
    const added = fixture.controller.addBreakpoint("s1", 12);
    assert.equal(added.status, "added");
    assert.equal(fixture.controller.getSnapshot().breakpoints.length, 1);

    assert.equal(fixture.controller.addBreakpoint("s1", 12).status, "exists");
    assert.equal(fixture.controller.getSnapshot().breakpoints.length, 1);

    assert.equal(fixture.controller.toggleBreakpoint("s1", 12).status, "removed");
    assert.equal(fixture.controller.getSnapshot().breakpoints.length, 0);
    assert.equal(fixture.controller.toggleBreakpoint("s1", 12).status, "added");
    assert.equal(fixture.controller.removeBreakpointAt("s1", 99).status, "missing");
  });

  test("a line that cannot hold a breakpoint is refused and reported", () => {
    const fixture = setup();
    const result = fixture.controller.addBreakpoint("s1", 0);

    assert.equal(result.status, "invalid");
    assert.equal(result.status === "invalid" && result.error.code, "BREAKPOINT_INVALID");
    assert.equal(fixture.controller.getSnapshot().breakpoints.length, 0);
    assert.ok(fixture.log.entries.some((entry) => entry.level === "warn"));
  });

  test("every change is handed to persistence, and nothing else is", async () => {
    const fixture = setup();
    fixture.controller.addBreakpoint("s1", 4);
    assert.equal(fixture.persisted()?.length, 1);

    const before = fixture.writes();
    await startPaused(fixture);
    // Starting a session resets hit counts, which are already zero: no write.
    assert.equal(fixture.writes(), before);
  });

  test("execution stops on an enabled breakpoint and counts the hit", async () => {
    const fixture = setup();
    fixture.controller.addBreakpoint("s1", 12);
    await startPaused(fixture);

    const result = await resume(fixture, "continue");
    assert.deepEqual(result, { status: "paused", reason: "breakpoint" });

    const snapshot = fixture.controller.getSnapshot();
    assert.equal(snapshot.stack[0]?.line, 12);
    assert.deepEqual(
      snapshot.stack.map((frame) => frame.functionName),
      ["calculate()", "update()", "main()"],
    );
    assert.equal(snapshot.breakpoints[0]?.hitCount, 1);
  });

  test("a disabled breakpoint does not stop execution", async () => {
    const fixture = setup();
    const added = fixture.controller.addBreakpoint("s1", 12);
    assert.ok(added.status === "added");
    fixture.controller.setBreakpointEnabled(added.breakpoint.id, false);

    await startPaused(fixture);
    const result = await resume(fixture, "continue");
    assert.deepEqual(result, { status: "completed" });
    assert.equal(fixture.controller.getSnapshot().breakpoints[0]?.hitCount, 0);
  });

  test("a new session starts the hit counts again", async () => {
    const fixture = setup();
    fixture.controller.addBreakpoint("s1", 12);
    await startPaused(fixture);
    await resume(fixture, "continue");
    assert.equal(fixture.controller.getSnapshot().breakpoints[0]?.hitCount, 1);

    await stopSession(fixture);
    await startPaused(fixture);
    assert.equal(fixture.controller.getSnapshot().breakpoints[0]?.hitCount, 0);
  });

  test("clearing reports how many were removed", () => {
    const fixture = setup();
    fixture.controller.addBreakpoint("s1", 3);
    fixture.controller.addBreakpoint("s1", 9);
    fixture.controller.addBreakpoint("s2", 2);

    assert.equal(fixture.controller.clearBreakpoints("s1"), 2);
    assert.equal(fixture.controller.getSnapshot().breakpoints.length, 1);
    assert.equal(fixture.controller.clearBreakpoints(), 1);
    assert.equal(fixture.controller.clearBreakpoints(), 0);
  });

  test("restored breakpoints are there before the first session", () => {
    const clock = createFakeClock();
    const controller = createDebuggerController({
      provider: createMockDebuggerProvider({ clock }),
      clock,
      breakpoints: [{ id: "kept", scriptId: "s1", line: 8, enabled: true, hitCount: 0 }],
      log: createLog(),
    });

    assert.equal(controller.getSnapshot().breakpoints.length, 1);
    assert.equal(controller.getSnapshot().breakpoints[0]?.line, 8);
  });
});

describe("pausing a run", () => {
  test("a pause request stops at the next line", async () => {
    const fixture = setup();
    fixture.controller.addBreakpoint("s1", 20);
    await startPaused(fixture);

    const submission = fixture.controller.resume("continue");
    assert.ok(submission.accepted);
    assert.equal(fixture.controller.getSnapshot().state, "running");

    assert.equal(fixture.controller.pause(), "requested");
    assert.equal(fixture.controller.pause(), "already-requested");
    assert.equal(fixture.controller.getSnapshot().pausePending, true);

    await fixture.clock.advance(RESUME_MS);
    const snapshot = fixture.controller.getSnapshot();
    assert.equal(snapshot.state, "paused");
    assert.equal(snapshot.pauseReason, "pause");
    assert.equal(snapshot.stack[0]?.line, 2);
    assert.equal(snapshot.pausePending, false);
  });

  test("pausing is only offered while something is running", async () => {
    const fixture = setup();
    assert.equal(fixture.controller.pause(), "not-running");
    await startPaused(fixture);
    assert.equal(fixture.controller.pause(), "not-running");
  });
});

describe("frames, variables and watches", () => {
  test("selecting an outer frame shows that frame's variables", async () => {
    const fixture = setup();
    fixture.controller.addBreakpoint("s1", 12);
    await startPaused(fixture);
    await resume(fixture, "continue");

    const stack = fixture.controller.getSnapshot().stack;
    assert.ok(fixture.controller.getSnapshot().locals.some((variable) => variable.name === "position"));

    const outer = stack[2];
    assert.ok(outer);
    fixture.controller.selectFrame(outer.id);

    const snapshot = fixture.controller.getSnapshot();
    assert.equal(snapshot.currentFrameId, outer.id);
    assert.ok(snapshot.locals.some((variable) => variable.name === "startTime"));
    assert.equal(
      snapshot.locals.some((variable) => variable.name === "position"),
      false,
    );
  });

  test("a frame that is not in the stack is ignored", async () => {
    const fixture = setup();
    await startPaused(fixture);
    const before = fixture.controller.getSnapshot();
    fixture.controller.selectFrame("ghost");
    assert.equal(fixture.controller.getSnapshot(), before);
  });

  test("a watch reads a name the paused frame holds", async () => {
    const fixture = setup();
    fixture.controller.addBreakpoint("s1", 12);
    await startPaused(fixture);
    await resume(fixture, "continue");

    const watch = fixture.controller.addWatch("speed");
    assert.ok(watch);
    assert.equal(watch.error, null);
    assert.equal(watch.type, "number");
    assert.ok(watch.value !== null);
  });

  test("a name the frame does not hold is reported, not invented", async () => {
    const fixture = setup();
    await startPaused(fixture);

    const watch = fixture.controller.addWatch("nothingHere");
    assert.equal(watch?.error?.code, "WATCH_EVALUATION_FAILED");
    assert.equal(watch?.value, null);
  });

  test("a watch is a name, never something to run", async () => {
    const fixture = setup();
    await startPaused(fixture);

    for (const expression of ["speed()", "1 + 1", "os.time()", "print('x')", "a = 2"]) {
      const watch = fixture.controller.addWatch(expression);
      assert.equal(watch?.error?.code, "WATCH_EVALUATION_FAILED", expression);
    }
  });

  test("watches follow the selected frame and empty out when the session ends", async () => {
    const fixture = setup();
    fixture.controller.addBreakpoint("s1", 12);
    await startPaused(fixture);
    await resume(fixture, "continue");

    fixture.controller.addWatch("position");
    assert.equal(fixture.controller.getSnapshot().watches[0]?.error, null);

    const outer = fixture.controller.getSnapshot().stack[2];
    assert.ok(outer);
    fixture.controller.selectFrame(outer.id);
    assert.equal(fixture.controller.getSnapshot().watches[0]?.error?.code, "WATCH_EVALUATION_FAILED");

    await stopSession(fixture);
    const watch = fixture.controller.getSnapshot().watches[0];
    assert.equal(watch?.value, null);
    assert.equal(watch?.error, null);
  });

  test("the same expression is only watched once, and empty ones are ignored", async () => {
    const fixture = setup();
    await startPaused(fixture);

    assert.ok(fixture.controller.addWatch("player"));
    assert.equal(fixture.controller.addWatch("player"), null);
    assert.equal(fixture.controller.addWatch("   "), null);
    assert.equal(fixture.controller.getSnapshot().watches.length, 1);

    const id = fixture.controller.getSnapshot().watches[0]?.id ?? "";
    fixture.controller.removeWatch(id);
    assert.equal(fixture.controller.getSnapshot().watches.length, 0);
  });

  test("the shared developer selection is visible as the session's context", async () => {
    const fixture = setup();
    const submission = fixture.controller.start({
      target: TARGET,
      context: { objectId: "camera", name: "Camera", className: "Camera", path: "Workspace / Camera" },
    });
    assert.ok(submission.accepted);
    await fixture.clock.advance(START_MS);

    const snapshot = fixture.controller.getSnapshot();
    assert.equal(snapshot.session?.context?.name, "Camera");
    const context = snapshot.locals.find((variable) => variable.name === "context");
    assert.equal(context?.value, "Workspace / Camera");
    assert.equal(context?.type, "Camera");
  });
});

/** A provider the test drives by hand, for the cases the mock cannot produce. */
function createStubProvider(): DebuggerProvider & {
  settle: (outcome: DebugRunOutcome) => void;
  pending: () => number;
  stops: () => number;
} {
  const waiting: ((outcome: DebugRunOutcome) => void)[] = [];
  let stops = 0;

  const wait = (signal: AbortSignal) =>
    new Promise<DebugRunOutcome>((resolve) => {
      waiting.push(resolve);
      signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
    });

  return {
    label: "Stub Debugger",
    providerType: "stub",
    simulated: true,
    supportsCancel: true,
    description: "A provider the test settles by hand.",
    start: (_request, _breakpoints, { signal }) => wait(signal),
    resume: (_sessionId, _mode, _breakpoints, { signal }) => wait(signal),
    requestPause: () => undefined,
    stop: () => {
      stops += 1;
      return Promise.resolve();
    },
    getVariables: () => [],
    evaluate: () => ({ status: "error", error: { code: "WATCH_EVALUATION_FAILED", message: "no frame" } }),
    settle: (outcome) => waiting.shift()?.(outcome),
    pending: () => waiting.length,
    stops: () => stops,
  };
}

describe("timeouts, cancellation and late answers", () => {
  test("a provider that never answers is abandoned and reported", async () => {
    const provider = createStubProvider();
    const fixture = setup({ provider });

    const submission = fixture.controller.start({ target: TARGET });
    assert.ok(submission.accepted);
    await fixture.clock.advance(5000);

    const result = await submission.settled;
    assert.equal(result.status, "failed");
    assert.equal(result.status === "failed" && result.error.code, "DEBUGGER_TIMEOUT");

    const snapshot = fixture.controller.getSnapshot();
    assert.equal(snapshot.state, "error");
    assert.equal(snapshot.error?.code, "DEBUGGER_TIMEOUT");
    assert.equal(snapshot.session?.stopReason, "failed");
  });

  test("an answer that arrives after the timeout is ignored", async () => {
    const provider = createStubProvider();
    const fixture = setup({ provider });

    const submission = fixture.controller.start({ target: TARGET });
    assert.ok(submission.accepted);
    await fixture.clock.advance(5000);

    provider.settle({
      status: "paused",
      stop: {
        line: 3,
        reason: "breakpoint",
        stack: [{ id: "late", functionName: "late()", scriptId: "s1", line: 3, depth: 0 }],
      },
    });
    await fixture.clock.flush();

    const snapshot = fixture.controller.getSnapshot();
    assert.equal(snapshot.state, "error", "a timed-out session never becomes paused");
    assert.deepEqual(snapshot.stack, []);
  });

  test("stopping a run in flight cancels it, and its late answer changes nothing", async () => {
    const provider = createStubProvider();
    const fixture = setup({ provider });

    const submission = fixture.controller.start({ target: TARGET });
    assert.ok(submission.accepted);
    await stopSession(fixture);

    assert.equal(fixture.controller.getSnapshot().state, "stopped");
    assert.deepEqual(await submission.settled, { status: "cancelled" });

    provider.settle({
      status: "paused",
      stop: {
        line: 9,
        reason: "step",
        stack: [{ id: "late", functionName: "late()", scriptId: "s1", line: 9, depth: 0 }],
      },
    });
    await fixture.clock.flush();

    assert.equal(fixture.controller.getSnapshot().state, "stopped");
    assert.deepEqual(fixture.controller.getSnapshot().stack, []);
  });

  test("a provider that throws is reported as a session failure", async () => {
    const clock = createFakeClock();
    const provider = createStubProvider();
    const controller = createDebuggerController({
      provider: {
        ...provider,
        start: () => {
          throw new Error("no debugger here");
        },
      },
      clock,
      log: createLog(),
    });
    controller.setTargetPresent(true);

    const submission = controller.start({ target: TARGET });
    assert.ok(submission.accepted);
    const result = await submission.settled;

    assert.equal(result.status, "failed");
    assert.equal(result.status === "failed" && result.error.code, "DEBUGGER_SESSION_FAILED");
    assert.equal(controller.getSnapshot().state, "error");
  });
});

describe("the target going away", () => {
  test("a paused session is stopped and the debugger becomes unavailable", async () => {
    const fixture = setup();
    await startPaused(fixture);

    fixture.controller.setTargetPresent(false);
    const snapshot = fixture.controller.getSnapshot();

    assert.equal(snapshot.state, "unavailable");
    assert.equal(snapshot.session?.stopReason, "target-lost");
    assert.equal(snapshot.error?.code, "TARGET_DISCONNECTED");
    assert.deepEqual(snapshot.stack, []);
  });

  test("a run in flight is ended rather than left waiting", async () => {
    const provider = createStubProvider();
    const fixture = setup({ provider });

    const submission = fixture.controller.start({ target: TARGET });
    assert.ok(submission.accepted);
    fixture.controller.setTargetPresent(false);

    const result = await submission.settled;
    assert.equal(result.status, "failed");
    assert.equal(result.status === "failed" && result.error.code, "TARGET_DISCONNECTED");
    assert.equal(provider.stops(), 1, "the provider is told to release the session");
  });

  test("breakpoints survive the target going away: they are configuration", async () => {
    const fixture = setup();
    fixture.controller.addBreakpoint("s1", 6);
    await startPaused(fixture);

    fixture.controller.setTargetPresent(false);
    assert.equal(fixture.controller.getSnapshot().breakpoints.length, 1);

    fixture.controller.setTargetPresent(true);
    assert.equal(fixture.controller.getSnapshot().state, "ready");
    assert.equal(fixture.controller.getSnapshot().breakpoints.length, 1);
  });
});

describe("subscribers and disposal", () => {
  test("subscribers are told once per change", async () => {
    const fixture = setup();
    let published = 0;
    const stop = fixture.controller.subscribe(() => (published += 1));

    fixture.controller.addBreakpoint("s1", 2);
    assert.equal(published, 1);

    stop();
    fixture.controller.addBreakpoint("s1", 3);
    assert.equal(published, 1);
  });

  test("disposing releases the session and stops publishing", async () => {
    const provider = createStubProvider();
    const fixture = setup({ provider });
    await startPaused(fixture);

    let published = 0;
    fixture.controller.subscribe(() => (published += 1));
    fixture.controller.dispose();

    assert.equal(provider.stops(), 1);
    fixture.controller.addBreakpoint("s1", 5);
    assert.equal(published, 0);
  });
});
