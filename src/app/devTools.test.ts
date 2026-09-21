import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bindDevToolsToTarget } from "@/app/devTools";
import { createDebuggerController } from "@/features/debugger/debuggerController";
import { createMockDebuggerProvider } from "@/features/debugger/providers/MockDebuggerProvider";
import { createProfilerController } from "@/features/profiler/profilerController";
import { createMockProfilerProvider } from "@/features/profiler/providers/MockProfilerProvider";
import { TARGET_STATUSES } from "@/features/target/targetState";
import type { DebugTarget } from "@/features/debugger/types";
import type { TargetStatus } from "@/features/target/types";
import { createFakeClock } from "@/lib/testing/fakeClock";

/**
 * Backend → Target → Debugger / Profiler: the one link between what the tools
 * run against and the tools themselves, exercised with the real controllers and
 * sources the test moves by hand.
 *
 * The binding resolves three separate facts — is the backend ready, is a target
 * there, does the backend supply this tool — and it is the only place they meet.
 * Nothing here composes a backend: the sources are doubles so the answers can be
 * set independently, which is the whole point of keeping them apart.
 */

const TARGET: DebugTarget = { scriptId: "s1", scriptName: "Main.lua", lineCount: 20 };

function createTargetSource(initial: TargetStatus = "unavailable") {
  let status = initial;
  const listeners = new Set<() => void>();

  return {
    source: {
      getStatus: () => status,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    listenerCount: () => listeners.size,
    set: (next: TargetStatus) => {
      status = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

function createBackendSource(initial = true) {
  let ready = initial;
  const listeners = new Set<() => void>();

  return {
    source: {
      isReady: () => ready,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    listenerCount: () => listeners.size,
    set: (next: boolean) => {
      ready = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

interface SetupOptions {
  /** Whether the backend is ready to begin with. */
  backendReady?: boolean;
  /** Which tools the backend supplies. */
  supports?: { debugger: boolean; profiler: boolean };
}

function setup(initial: TargetStatus = "unavailable", options: SetupOptions = {}) {
  const clock = createFakeClock();
  const silent = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
  const target = createTargetSource(initial);

  const debug = createDebuggerController({
    provider: createMockDebuggerProvider({ clock }),
    clock,
    log: silent,
  });
  const profiler = createProfilerController({
    provider: createMockProfilerProvider({ clock }),
    clock,
    log: silent,
  });

  const backend = createBackendSource(options.backendReady ?? true);
  const unbind = bindDevToolsToTarget({
    target: target.source,
    backend: backend.source,
    ...(options.supports === undefined ? {} : { supports: options.supports }),
    debug,
    profiler,
  });
  return { clock, debug, profiler, target, backend, unbind };
}

describe("target presence", () => {
  test("no target means neither tool is available", () => {
    const { debug, profiler } = setup();
    assert.equal(debug.getSnapshot().state, "unavailable");
    assert.equal(profiler.getSnapshot().state, "unavailable");
  });

  test("a target that is already there is applied at once", () => {
    const { debug, profiler } = setup("ready");
    assert.equal(debug.getSnapshot().state, "ready");
    assert.equal(profiler.getSnapshot().state, "ready");
  });

  test("a detected target is enough for both tools", () => {
    const { debug, profiler, target } = setup();
    target.set("detected");

    assert.equal(debug.getSnapshot().state, "ready");
    assert.equal(profiler.getSnapshot().state, "ready");
  });

  test("every target status either has a target or does not, and both tools agree", () => {
    const { debug, profiler, target } = setup();

    for (const status of TARGET_STATUSES) {
      target.set(status);
      const debuggerReady = debug.getSnapshot().state !== "unavailable";
      const profilerReady = profiler.getSnapshot().state !== "unavailable";
      assert.equal(debuggerReady, profilerReady, `${status}: the two tools disagree`);
    }
  });

  test("an injected target keeps both tools available", () => {
    const { debug, profiler, target } = setup("ready");
    target.set("injecting");
    target.set("injected");

    assert.equal(debug.getSnapshot().state, "ready");
    assert.equal(profiler.getSnapshot().state, "ready");
  });
});

describe("losing the target", () => {
  test("a debug session is stopped rather than left claiming to be paused", async () => {
    const { clock, debug, target } = setup("ready");
    const submission = debug.start({ target: TARGET });
    assert.ok(submission.accepted);
    await clock.advance(200);
    assert.equal(debug.getSnapshot().state, "paused");

    target.set("unavailable");

    const snapshot = debug.getSnapshot();
    assert.equal(snapshot.state, "unavailable");
    assert.equal(snapshot.session?.stopReason, "target-lost");
    assert.equal(snapshot.error?.code, "TARGET_DISCONNECTED");
  });

  test("a recording is stopped rather than left running", async () => {
    const { clock, profiler, target } = setup("ready");
    profiler.start();
    await clock.advance(100);
    assert.equal(profiler.getSnapshot().state, "recording");

    target.set("unavailable");

    assert.equal(profiler.getSnapshot().state, "unavailable");
    assert.equal(profiler.getSnapshot().error?.code, "TARGET_DISCONNECTED");
  });

  test("a target that comes back makes both tools ready again", async () => {
    const { clock, debug, profiler, target } = setup("ready");
    const submission = debug.start({ target: TARGET });
    assert.ok(submission.accepted);
    await clock.advance(200);

    target.set("unavailable");
    target.set("detected");

    assert.equal(debug.getSnapshot().state, "ready");
    assert.equal(profiler.getSnapshot().state, "ready");
  });
});

describe("backend readiness", () => {
  test("a backend that is not ready means neither tool is available, target or not", () => {
    const { debug, profiler } = setup("ready", { backendReady: false });
    assert.equal(debug.getSnapshot().state, "unavailable");
    assert.equal(profiler.getSnapshot().state, "unavailable");
  });

  test("the backend becoming ready is enough to make the tools follow the target again", () => {
    const { debug, profiler, backend } = setup("ready", { backendReady: false });
    backend.set(true);

    assert.equal(debug.getSnapshot().state, "ready");
    assert.equal(profiler.getSnapshot().state, "ready");
  });

  test("a backend that stops takes both tools with it, and the target is not what changed", async () => {
    const { clock, debug, profiler, target, backend } = setup("ready");
    const submission = debug.start({ target: TARGET });
    assert.ok(submission.accepted);
    await clock.advance(200);
    assert.equal(debug.getSnapshot().state, "paused");

    backend.set(false);

    assert.equal(debug.getSnapshot().state, "unavailable");
    assert.equal(profiler.getSnapshot().state, "unavailable");
    assert.equal(target.listenerCount(), 1, "the target source is untouched by a backend change");
  });

  test("a tool the backend does not supply is never marked available", () => {
    const { debug, profiler } = setup("ready", { supports: { debugger: false, profiler: true } });
    assert.equal(debug.getSnapshot().state, "unavailable", "an unsupported tool has nothing to work against");
    assert.equal(profiler.getSnapshot().state, "ready", "the other tool is unaffected");
  });

  test("with no backend given the tools follow the target alone, as they did before", () => {
    const clock = createFakeClock();
    const silent = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
    const target = createTargetSource("ready");
    const debug = createDebuggerController({ provider: createMockDebuggerProvider({ clock }), clock, log: silent });
    const profiler = createProfilerController({ provider: createMockProfilerProvider({ clock }), clock, log: silent });

    const unbind = bindDevToolsToTarget({ target: target.source, debug, profiler });
    assert.equal(debug.getSnapshot().state, "ready");
    assert.equal(profiler.getSnapshot().state, "ready");
    unbind();
  });
});

describe("releasing the binding", () => {
  test("unbinding stops following the target", () => {
    const { debug, target, unbind } = setup("ready");
    unbind();
    assert.equal(target.listenerCount(), 0);

    target.set("unavailable");
    assert.equal(debug.getSnapshot().state, "ready", "nothing follows the target any more");
  });

  test("unbinding releases the backend source too, so nothing is left subscribed", () => {
    const { backend, debug, unbind } = setup("ready");
    unbind();
    assert.equal(backend.listenerCount(), 0);

    backend.set(false);
    assert.equal(debug.getSnapshot().state, "ready", "nothing follows the backend any more");
  });
});
