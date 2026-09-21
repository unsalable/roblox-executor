import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createProfilerController,
  type ProfilerController,
  type ProfilerLog,
} from "@/features/profiler/profilerController";
import { createMockProfilerProvider } from "@/features/profiler/providers/MockProfilerProvider";
import { InvalidProfilerTransitionError, transitionProfiler } from "@/features/profiler/profilerState";
import type { ProfilerProvider, ProfileStopOutcome } from "@/features/profiler/types";
import { createFakeClock, type FakeClock } from "@/lib/testing/fakeClock";

/** The provider's own simulated timings, which the fake clock steps through. */
const START_MS = 80;
const STOP_MS = 120;

function createLog(): ProfilerLog {
  const ignore = () => undefined;
  return { debug: ignore, info: ignore, warn: ignore, error: ignore };
}

interface Setup {
  controller: ProfilerController;
  clock: FakeClock;
}

function setup(options: { provider?: ProfilerProvider; targetPresent?: boolean } = {}): Setup {
  const clock = createFakeClock();
  let ids = 0;

  const controller = createProfilerController({
    provider: options.provider ?? createMockProfilerProvider({ clock }),
    clock,
    createId: () => `session-${++ids}`,
    log: createLog(),
  });

  if (options.targetPresent !== false) controller.setTargetPresent(true);
  return { controller, clock };
}

/**
 * Records for `durationMs` of simulated time and returns the finished session.
 * The window opens when Start is pressed, so the provider's own start delay is
 * part of it, exactly as it is for a user holding the button.
 */
async function record(fixture: Setup, durationMs = 1600) {
  const started = fixture.controller.start();
  assert.ok(started.accepted);
  await fixture.clock.advance(START_MS);
  await fixture.clock.advance(durationMs - START_MS);

  const stopped = fixture.controller.stop();
  assert.ok(stopped.accepted);
  await fixture.clock.advance(STOP_MS);
  return stopped.settled;
}

describe("profiler initial state", () => {
  test("a launch has no target, no recording and no history", () => {
    const { controller } = setup({ targetPresent: false });
    const snapshot = controller.getSnapshot();

    assert.equal(snapshot.state, "unavailable");
    assert.equal(snapshot.session, null);
    assert.equal(snapshot.recordingSince, null);
    assert.deepEqual(snapshot.history, []);
    assert.equal(snapshot.error, null);
  });

  test("a target appearing makes the profiler ready", () => {
    const { controller } = setup();
    assert.equal(controller.getSnapshot().state, "ready");
    assert.equal(controller.provider.simulated, true);
  });

  test("recording is refused without a target", () => {
    const { controller } = setup({ targetPresent: false });
    const submission = controller.start();

    assert.equal(submission.accepted, false);
    assert.equal(submission.accepted === false && submission.error.code, "PROFILER_UNAVAILABLE");
  });
});

describe("recording", () => {
  test("starting puts the profiler in recording and remembers when", async () => {
    const fixture = setup();
    const submission = fixture.controller.start();
    assert.ok(submission.accepted);

    assert.equal(fixture.controller.getSnapshot().state, "recording");
    await fixture.clock.advance(START_MS);
    assert.deepEqual(await submission.settled, { status: "started" });
    assert.equal(fixture.controller.getSnapshot().busy, false);
    assert.notEqual(fixture.controller.getSnapshot().recordingSince, null);
  });

  test("a second recording is refused while one is running", async () => {
    const fixture = setup();
    fixture.controller.start();
    await fixture.clock.advance(START_MS);

    const second = fixture.controller.start();
    assert.equal(second.accepted, false);
    assert.equal(second.accepted === false && second.error.code, "PROFILER_NOT_READY");
  });

  test("stopping aggregates the samples into a session", async () => {
    const fixture = setup();
    const result = await record(fixture, 1600);

    assert.equal(result.status, "stopped");
    const snapshot = fixture.controller.getSnapshot();
    assert.equal(snapshot.state, "ready");
    assert.equal(snapshot.recordingSince, null);

    const session = snapshot.session;
    assert.ok(session);
    assert.equal(session.durationMs, 1600);
    assert.equal(session.simulated, true);
    assert.equal(session.summary.sampleCount, session.samples.length);
    assert.ok(session.frames.length > 0);
    assert.equal(session.frames[0]?.name, session.summary.busiestFrame);
  });

  test("the frames of a session are sorted and add up to the whole", async () => {
    const fixture = setup();
    await record(fixture);
    const session = fixture.controller.getSnapshot().session;
    assert.ok(session);

    const total = session.frames.reduce((sum, frame) => sum + frame.percentage, 0);
    assert.ok(Math.abs(total - 100) < 0.05, `percentages add up to ${total}`);
    for (let index = 1; index < session.frames.length; index += 1) {
      assert.ok((session.frames[index - 1]?.totalDurationMs ?? 0) >= (session.frames[index]?.totalDurationMs ?? 0));
    }
  });

  test("stopping without a recording is refused", () => {
    const { controller } = setup();
    const submission = controller.stop();

    assert.equal(submission.accepted, false);
    assert.equal(submission.accepted === false && submission.error.code, "PROFILER_NO_SESSION");
  });

  test("the same recording length always produces the same profile", async () => {
    const first = setup();
    await record(first, 1600);
    const second = setup();
    await record(second, 1600);

    assert.deepEqual(
      first.controller.getSnapshot().session?.frames,
      second.controller.getSnapshot().session?.frames,
    );
  });
});

describe("history, clear and refresh", () => {
  test("each finished recording is kept, newest first", async () => {
    const fixture = setup();
    await record(fixture, 1600);
    await record(fixture, 3200);

    const { history, session } = fixture.controller.getSnapshot();
    assert.equal(history.length, 2);
    assert.equal(history[0]?.id, session?.id);
    assert.equal(history[0]?.durationMs, 3200);
    assert.equal(history[1]?.durationMs, 1600);
  });

  test("only the most recent recordings are kept", async () => {
    const clock = createFakeClock();
    const controller = createProfilerController({
      provider: createMockProfilerProvider({ clock }),
      clock,
      historyLimit: 2,
      log: createLog(),
    });
    controller.setTargetPresent(true);
    const fixture = { controller, clock };

    await record(fixture, 800);
    await record(fixture, 800);
    await record(fixture, 800);
    assert.equal(controller.getSnapshot().history.length, 2);
  });

  test("clearing forgets the session and the history", async () => {
    const fixture = setup();
    await record(fixture);
    fixture.controller.clear();

    const snapshot = fixture.controller.getSnapshot();
    assert.equal(snapshot.session, null);
    assert.deepEqual(snapshot.history, []);
    assert.equal(snapshot.state, "ready");
  });

  test("clearing is ignored while a recording is running", async () => {
    const fixture = setup();
    fixture.controller.start();
    await fixture.clock.advance(START_MS);

    fixture.controller.clear();
    assert.equal(fixture.controller.getSnapshot().state, "recording");
  });

  test("refresh reads the session again and reaches the same numbers", async () => {
    const fixture = setup();
    await record(fixture);
    const before = fixture.controller.getSnapshot().session;

    assert.equal(fixture.controller.refresh(), true);
    const after = fixture.controller.getSnapshot().session;
    assert.notEqual(after, before, "the session object is rebuilt");
    assert.deepEqual(after?.frames, before?.frames);
    assert.deepEqual(after?.summary, before?.summary);
  });

  test("refresh with nothing recorded does nothing", () => {
    const { controller } = setup();
    assert.equal(controller.refresh(), false);
  });

  test("a session the provider no longer holds is left as it is", async () => {
    const clock = createFakeClock();
    const provider = createMockProfilerProvider({ clock });
    const controller = createProfilerController({ provider, clock, log: createLog() });
    controller.setTargetPresent(true);

    await record({ controller, clock });
    const before = controller.getSnapshot().session;
    provider.clear();

    assert.equal(controller.refresh(), false);
    assert.equal(controller.getSnapshot().session, before);
  });
});

/** A provider the test settles by hand, for timeouts and failures. */
function createStubProvider(): ProfilerProvider & { settleStop: (outcome: ProfileStopOutcome) => void } {
  const waiting: ((outcome: ProfileStopOutcome) => void)[] = [];

  return {
    label: "Stub Profiler",
    providerType: "stub",
    simulated: true,
    description: "A provider the test settles by hand.",
    start: () => Promise.resolve({ status: "started" }),
    stop: (_sessionId, _context, { signal }) =>
      new Promise<ProfileStopOutcome>((resolve) => {
        waiting.push(resolve);
        signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
      }),
    read: () => null,
    clear: () => undefined,
    settleStop: (outcome) => waiting.shift()?.(outcome),
  };
}

describe("timeouts and failures", () => {
  test("a provider that never answers is abandoned and reported", async () => {
    const fixture = setup({ provider: createStubProvider() });
    fixture.controller.start();
    await fixture.clock.advance(1);

    const stopped = fixture.controller.stop();
    assert.ok(stopped.accepted);
    await fixture.clock.advance(5000);

    const result = await stopped.settled;
    assert.equal(result.status, "failed");
    assert.equal(result.status === "failed" && result.error.code, "PROFILER_TIMEOUT");
    assert.equal(fixture.controller.getSnapshot().state, "error");
    assert.equal(fixture.controller.getSnapshot().error?.code, "PROFILER_TIMEOUT");
  });

  test("an answer that arrives after the timeout is ignored", async () => {
    const provider = createStubProvider();
    const fixture = setup({ provider });
    fixture.controller.start();
    await fixture.clock.advance(1);
    fixture.controller.stop();
    await fixture.clock.advance(5000);

    provider.settleStop({
      status: "stopped",
      samples: [{ timestamp: 0, frame: "late()", category: "Script", durationMs: 1 }],
    });
    await fixture.clock.flush();

    assert.equal(fixture.controller.getSnapshot().session, null, "a timed-out recording produces nothing");
    assert.equal(fixture.controller.getSnapshot().state, "error");
  });

  test("a failed recording can be started again", async () => {
    const fixture = setup({ provider: createStubProvider() });
    fixture.controller.start();
    await fixture.clock.advance(1);
    fixture.controller.stop();
    await fixture.clock.advance(5000);

    assert.equal(fixture.controller.getSnapshot().state, "error");
    const again = fixture.controller.start();
    assert.equal(again.accepted, true);
  });
});

describe("the target going away", () => {
  test("a recording is stopped and the profiler becomes unavailable", async () => {
    const fixture = setup();
    fixture.controller.start();
    await fixture.clock.advance(START_MS);

    fixture.controller.setTargetPresent(false);
    const snapshot = fixture.controller.getSnapshot();

    assert.equal(snapshot.state, "unavailable");
    assert.equal(snapshot.recordingSince, null);
    assert.equal(snapshot.error?.code, "TARGET_DISCONNECTED");
    assert.equal(snapshot.session, null);
  });

  test("a finished session survives the target going away", async () => {
    const fixture = setup();
    await record(fixture);
    fixture.controller.setTargetPresent(false);

    assert.equal(fixture.controller.getSnapshot().state, "unavailable");
    assert.notEqual(fixture.controller.getSnapshot().session, null);

    fixture.controller.setTargetPresent(true);
    assert.equal(fixture.controller.getSnapshot().state, "ready");
  });
});

describe("the profiler state machine", () => {
  test("an impossible transition throws rather than being applied silently", () => {
    assert.throws(() => transitionProfiler("unavailable", "recording"), InvalidProfilerTransitionError);
    assert.throws(() => transitionProfiler("recording", "recording"), InvalidProfilerTransitionError);
    assert.equal(transitionProfiler("recording", "ready"), "ready");
  });
});

describe("subscribers and disposal", () => {
  test("disposing stops publishing", async () => {
    const fixture = setup();
    let published = 0;
    fixture.controller.subscribe(() => (published += 1));

    fixture.controller.start();
    const seen = published;
    assert.ok(seen > 0);

    fixture.controller.dispose();
    fixture.controller.setTargetPresent(false);
    assert.equal(published, seen);
  });
});
