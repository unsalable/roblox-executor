import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bindDevToolsToTarget } from "@/app/devTools";
import { createBackendController, type BackendController } from "@/features/backend/backendController";
import { createLocalMockDeveloperBackend } from "@/features/backend/backends/LocalMockDeveloperBackend";
import {
  createUnsupportedDebuggerProvider,
  createUnsupportedProfilerProvider,
} from "@/features/backend/providers/unsupported";
import { isBackendReady } from "@/features/backend/backendState";
import { createDebuggerController, type DebuggerController } from "@/features/debugger/debuggerController";
import type { DebugTarget } from "@/features/debugger/types";
import { createProfilerController, type ProfilerController } from "@/features/profiler/profilerController";
import { createTargetController, type TargetController } from "@/features/target/targetController";
import { createFakeClock, type FakeClock } from "@/lib/testing/fakeClock";

/**
 * Backend → Target → Debugger / Profiler: the whole chain, with the real
 * controllers and the real providers a backend supplies, driven by hand.
 *
 * The point of these tests is that the three lifecycles stay separate while
 * still propagating correctly. A backend stopping and a target going away are
 * different events with different sources, and the tools have to end their work
 * safely for either — without ever being left mid-operation and without touching
 * anything that belongs to the workspace.
 */

const START_MS = 40;
const SETTLE_MS = 1000;
const TARGET: DebugTarget = { scriptId: "script-1", scriptName: "Main.lua", lineCount: 40 };

const silent = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

interface SetupOptions {
  /** Wire the tools the backend does not supply, as the composition root would. */
  tools?: { debugger: boolean; profiler: boolean };
}

interface Chain {
  clock: FakeClock;
  backend: BackendController;
  switches: ReturnType<typeof createLocalMockDeveloperBackend>["testSwitches"];
  target: TargetController;
  debug: DebuggerController;
  profiler: ProfilerController;
  startBackend: () => Promise<void>;
  stopBackend: () => Promise<void>;
  becomeReady: () => Promise<void>;
  startDebugSession: () => Promise<void>;
  startRecording: () => Promise<void>;
  /** The invariant every state of the chain has to satisfy. */
  assertConsistent: (note: string) => void;
  unbind: () => void;
  dispose: () => void;
}

function setup(options: SetupOptions = {}): Chain {
  const clock = createFakeClock();
  const tools = options.tools ?? { debugger: true, profiler: true };
  const developerBackend = createLocalMockDeveloperBackend({ clock, startMs: START_MS });

  const backend = createBackendController({
    backend: developerBackend,
    clock,
    log: silent,
    policy: () => ({ autoStartBackend: true }),
  });

  const target = createTargetController({
    provider: developerBackend.providers.target!,
    clock,
    log: silent,
    policy: () => ({ autoDetect: true, autoInject: false, autoReconnect: false, injectTimeoutMs: 5000 }),
  });

  // Exactly what the composition root does for a tool the backend does not supply.
  const debug = createDebuggerController({
    provider: tools.debugger ? developerBackend.providers.debugger! : createUnsupportedDebuggerProvider("Local Mock"),
    clock,
    log: silent,
  });
  const profiler = createProfilerController({
    provider: tools.profiler ? developerBackend.providers.profiler! : createUnsupportedProfilerProvider("Local Mock"),
    clock,
    log: silent,
  });

  const unbind = bindDevToolsToTarget({
    target: { getStatus: () => target.getSnapshot().status, subscribe: target.subscribe },
    backend: { isReady: () => isBackendReady(backend.getSnapshot().state), subscribe: backend.subscribe },
    supports: tools,
    debug,
    profiler,
  });

  const startBackend = async () => {
    const submission = backend.start();
    assert.ok(submission.accepted);
    await clock.advance(START_MS);
    await submission.settled;
  };

  const stopBackend = async () => {
    const stopping = backend.stop();
    await clock.advance(SETTLE_MS);
    await stopping;
  };

  const becomeReady = async () => {
    await startBackend();
    const pass = target.detect();
    await clock.advance(SETTLE_MS);
    await pass;
    assert.equal(target.getSnapshot().status, "ready");
  };

  const startDebugSession = async () => {
    const submission = debug.start({ target: TARGET });
    assert.ok(submission.accepted, "the debug session was refused");
    await clock.advance(SETTLE_MS);
    await submission.settled;
  };

  const startRecording = async () => {
    const submission = profiler.start();
    assert.ok(submission.accepted, "the recording was refused");
    await clock.advance(SETTLE_MS);
    await submission.settled;
  };

  const assertConsistent = (note: string) => {
    const backendReady = isBackendReady(backend.getSnapshot().state);
    const debugState = debug.getSnapshot().state;
    const profilerState = profiler.getSnapshot().state;

    if (!backendReady) {
      assert.equal(debugState, "unavailable", `${note}: the debugger outlived the backend`);
      assert.equal(profilerState, "unavailable", `${note}: the profiler outlived the backend`);
    }
    assert.equal(debug.getSnapshot().busy, false, `${note}: the debugger was left busy`);
    assert.equal(profiler.getSnapshot().busy, false, `${note}: the profiler was left busy`);
  };

  return {
    clock,
    backend,
    switches: developerBackend.testSwitches,
    target,
    debug,
    profiler,
    startBackend,
    stopBackend,
    becomeReady,
    startDebugSession,
    startRecording,
    assertConsistent,
    unbind,
    dispose: () => {
      unbind();
      profiler.dispose();
      debug.dispose();
      target.dispose();
      backend.dispose();
    },
  };
}

describe("three lifecycles, never collapsed into one", () => {
  test("a stopped backend means no tool is available, whatever the target says", () => {
    const chain = setup();
    assert.equal(chain.debug.getSnapshot().state, "unavailable");
    assert.equal(chain.profiler.getSnapshot().state, "unavailable");
    chain.dispose();
  });

  test("backend ready with no target is an ordinary state, not an error", async () => {
    const chain = setup();
    await chain.startBackend();
    chain.switches.setAvailability("unavailable");

    assert.equal(chain.backend.getSnapshot().state, "ready");
    assert.equal(chain.target.getSnapshot().status, "unavailable");
    assert.equal(chain.debug.getSnapshot().state, "unavailable");
    assert.equal(chain.backend.getSnapshot().error, null, "no target is not a backend failure");
    chain.dispose();
  });

  test("backend ready and target ready make the tools ready", async () => {
    const chain = setup();
    await chain.becomeReady();

    assert.equal(chain.debug.getSnapshot().state, "ready");
    assert.equal(chain.profiler.getSnapshot().state, "ready");
    chain.assertConsistent("both ready");
    chain.dispose();
  });

  test("backend ready, target ready, debugger unsupported is a state Nova can be in", async () => {
    const chain = setup({ tools: { debugger: false, profiler: true } });
    await chain.becomeReady();

    assert.equal(chain.target.getSnapshot().status, "ready");
    assert.equal(chain.profiler.getSnapshot().state, "ready", "the profiler is unaffected");
    assert.equal(chain.debug.getSnapshot().state, "unavailable", "an unsupported tool is never marked ready");
    chain.dispose();
  });

  test("one tool being unsupported never brings the other down", async () => {
    const chain = setup({ tools: { debugger: true, profiler: false } });
    await chain.becomeReady();
    await chain.startDebugSession();

    assert.equal(chain.debug.getSnapshot().state, "paused", "the debugger works while the profiler is missing");
    assert.equal(chain.profiler.getSnapshot().state, "unavailable");
    chain.dispose();
  });
});

describe("the target going away", () => {
  test("a debug session is stopped rather than left claiming to be paused", async () => {
    const chain = setup();
    await chain.becomeReady();
    await chain.startDebugSession();
    assert.equal(chain.debug.getSnapshot().state, "paused");

    chain.switches.setAvailability("unavailable");
    await chain.clock.advance(SETTLE_MS);

    assert.equal(chain.debug.getSnapshot().state, "unavailable");
    assert.deepEqual(chain.debug.getSnapshot().stack, [], "no stack survives the target");
    chain.assertConsistent("target lost while paused");
    chain.dispose();
  });

  test("a recording in progress is stopped, and nothing is left recording", async () => {
    const chain = setup();
    await chain.becomeReady();
    await chain.startRecording();
    assert.equal(chain.profiler.getSnapshot().state, "recording");

    chain.switches.setAvailability("unavailable");
    await chain.clock.advance(SETTLE_MS);

    assert.equal(chain.profiler.getSnapshot().state, "unavailable");
    assert.equal(chain.profiler.getSnapshot().recordingSince, null);
    chain.assertConsistent("target lost while recording");
    chain.dispose();
  });

  test("both tools are stopped by the same loss, and neither waits for the other", async () => {
    const chain = setup();
    await chain.becomeReady();
    await chain.startDebugSession();
    await chain.startRecording();

    chain.switches.setAvailability("unavailable");
    await chain.clock.advance(SETTLE_MS);

    assert.equal(chain.debug.getSnapshot().state, "unavailable");
    assert.equal(chain.profiler.getSnapshot().state, "unavailable");
    chain.assertConsistent("target lost with both running");
    chain.dispose();
  });

  test("the backend stays ready when only the target went away", async () => {
    const chain = setup();
    await chain.becomeReady();
    await chain.startDebugSession();

    chain.switches.setAvailability("unavailable");
    await chain.clock.advance(SETTLE_MS);

    assert.equal(chain.backend.getSnapshot().state, "ready", "losing a target does not stop a backend");
    chain.dispose();
  });

  test("the target coming back makes the tools ready again", async () => {
    const chain = setup();
    await chain.becomeReady();
    chain.switches.setAvailability("unavailable");
    await chain.clock.advance(SETTLE_MS);
    assert.equal(chain.debug.getSnapshot().state, "unavailable");

    chain.switches.setAvailability("available");
    await chain.clock.advance(SETTLE_MS);

    assert.equal(chain.debug.getSnapshot().state, "ready");
    assert.equal(chain.profiler.getSnapshot().state, "ready");
    chain.dispose();
  });
});

describe("the backend stopping", () => {
  test("stopping the backend takes the target with it, and then both tools", async () => {
    const chain = setup();
    await chain.becomeReady();
    await chain.stopBackend();

    assert.equal(chain.backend.getSnapshot().state, "stopped");
    assert.equal(chain.target.getSnapshot().status, "unavailable");
    assert.equal(chain.debug.getSnapshot().state, "unavailable");
    assert.equal(chain.profiler.getSnapshot().state, "unavailable");
    chain.assertConsistent("backend stopped");
    chain.dispose();
  });

  test("a debug session is ended safely when the backend stops under it", async () => {
    const chain = setup();
    await chain.becomeReady();
    await chain.startDebugSession();
    assert.equal(chain.debug.getSnapshot().state, "paused");

    await chain.stopBackend();

    assert.equal(chain.debug.getSnapshot().state, "unavailable");
    assert.equal(chain.debug.getSnapshot().busy, false, "the debugger is not left mid-operation");
    chain.dispose();
  });

  test("a recording is ended safely when the backend stops under it", async () => {
    const chain = setup();
    await chain.becomeReady();
    await chain.startRecording();

    await chain.stopBackend();

    assert.equal(chain.profiler.getSnapshot().state, "unavailable");
    assert.equal(chain.profiler.getSnapshot().recordingSince, null);
    chain.dispose();
  });

  test("an active target does not stop the backend from stopping", async () => {
    const chain = setup();
    await chain.becomeReady();
    const injecting = chain.target.inject();
    assert.ok(injecting.accepted);
    await chain.clock.advance(SETTLE_MS);
    await injecting.result;
    assert.equal(chain.target.getSnapshot().status, "injected");

    await chain.stopBackend();

    assert.equal(chain.backend.getSnapshot().state, "stopped");
    assert.notEqual(chain.target.getSnapshot().status, "injected", "nothing may still claim to be injected");
    assert.equal(chain.target.getSnapshot().session, "inactive");
    chain.dispose();
  });

  test("a tool cannot be started while the backend is stopped, and says nothing is there", async () => {
    const chain = setup();
    await chain.becomeReady();
    await chain.stopBackend();

    const submission = chain.debug.start({ target: TARGET });
    assert.equal(submission.accepted, false);
    assert.equal(submission.accepted === false ? submission.error.code : null, "DEBUGGER_UNAVAILABLE");

    const recording = chain.profiler.start();
    assert.equal(recording.accepted, false);
    chain.dispose();
  });
});

describe("restarting the backend", () => {
  test("a restart brings the target and both tools back", async () => {
    const chain = setup();
    await chain.becomeReady();
    await chain.stopBackend();

    const restarting = chain.backend.restart();
    await chain.clock.advance(START_MS + SETTLE_MS);
    await restarting;
    const pass = chain.target.detect();
    await chain.clock.advance(SETTLE_MS);
    await pass;

    assert.equal(chain.backend.getSnapshot().state, "ready");
    assert.equal(chain.target.getSnapshot().status, "ready");
    assert.equal(chain.debug.getSnapshot().state, "ready");
    assert.equal(chain.profiler.getSnapshot().state, "ready");
    chain.dispose();
  });

  test("breakpoints survive a restart, because they are configuration and not session state", async () => {
    const chain = setup();
    await chain.becomeReady();
    assert.equal(chain.debug.addBreakpoint(TARGET.scriptId, 12).status, "added");
    assert.equal(chain.debug.addBreakpoint(TARGET.scriptId, 25).status, "added");
    await chain.startDebugSession();

    const restarting = chain.backend.restart();
    await chain.clock.advance(START_MS + SETTLE_MS + 500);
    await restarting;

    const breakpoints = chain.debug.getSnapshot().breakpoints;
    assert.equal(breakpoints.length, 2, "a backend restart must not delete a breakpoint");
    assert.deepEqual(
      breakpoints.map((breakpoint) => breakpoint.line),
      [12, 25],
    );
    chain.dispose();
  });

  test("watches survive a restart too, and are simply no longer resolved", async () => {
    const chain = setup();
    await chain.becomeReady();
    await chain.startDebugSession();
    assert.ok(chain.debug.addWatch("frame") !== null);

    const restarting = chain.backend.restart();
    await chain.clock.advance(START_MS + SETTLE_MS + 500);
    await restarting;

    assert.equal(chain.debug.getSnapshot().watches.length, 1, "a watch is the user's own list");
    chain.dispose();
  });

  test("the controllers are the same objects afterwards, so nothing above them is rebuilt", async () => {
    const chain = setup();
    await chain.becomeReady();
    const before = { debug: chain.debug, profiler: chain.profiler, target: chain.target };

    const restarting = chain.backend.restart();
    await chain.clock.advance(START_MS + SETTLE_MS + 500);
    await restarting;

    assert.equal(chain.debug, before.debug, "the debugger controller was replaced");
    assert.equal(chain.profiler, before.profiler, "the profiler controller was replaced");
    assert.equal(chain.target, before.target, "the target controller was replaced");
    chain.dispose();
  });

  test("a restart while a recording is running ends the recording and does not resume it", async () => {
    const chain = setup();
    await chain.becomeReady();
    await chain.startRecording();

    const restarting = chain.backend.restart();
    await chain.clock.advance(START_MS + SETTLE_MS + 500);
    await restarting;

    assert.equal(chain.profiler.getSnapshot().recordingSince, null, "a recording is never resumed by itself");
    chain.assertConsistent("restarted while recording");
    chain.dispose();
  });
});

describe("nothing is left waiting", () => {
  test("every way the chain can come down leaves both tools settled", async () => {
    const ways: readonly { note: string; run: (chain: Chain) => Promise<void> }[] = [
      { note: "target switched off", run: async (chain) => {
        chain.switches.setAvailability("unavailable");
        await chain.clock.advance(SETTLE_MS);
      } },
      { note: "backend stopped", run: async (chain) => chain.stopBackend() },
      { note: "backend restarted", run: async (chain) => {
        const restarting = chain.backend.restart();
        await chain.clock.advance(START_MS + SETTLE_MS + 500);
        await restarting;
      } },
      { note: "tools stopped by hand", run: async (chain) => {
        const stopping = chain.debug.stop();
        await chain.clock.advance(SETTLE_MS);
        await stopping;
        const stopped = chain.profiler.stop();
        if (stopped.accepted) {
          await chain.clock.advance(SETTLE_MS);
          await stopped.settled;
        }
      } },
    ];

    for (const way of ways) {
      const chain = setup();
      await chain.becomeReady();
      await chain.startDebugSession();
      await chain.startRecording();

      await way.run(chain);

      chain.assertConsistent(way.note);
      chain.dispose();
    }
  });

  test("releasing the binding stops the tools following anything", async () => {
    const chain = setup();
    await chain.becomeReady();
    assert.equal(chain.debug.getSnapshot().state, "ready");

    chain.unbind();
    chain.switches.setAvailability("unavailable");
    await chain.clock.advance(SETTLE_MS);

    assert.equal(chain.debug.getSnapshot().state, "ready", "nothing follows the target any more");
    chain.dispose();
  });

  test("the binding leaves no listener behind on either source", async () => {
    const chain = setup();
    await chain.becomeReady();
    chain.unbind();
    // A second unbind must not throw, and a further change must reach nothing.
    chain.unbind();
    await chain.stopBackend();
    assert.equal(chain.debug.getSnapshot().state, "ready");
    chain.dispose();
  });
});
