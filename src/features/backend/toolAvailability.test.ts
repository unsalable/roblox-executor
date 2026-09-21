import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BACKEND_STATES } from "@/features/backend/backendState";
import { deriveCapabilities } from "@/features/backend/capabilities";
import { toolAvailability, unavailableReason, type GatedTool } from "@/features/backend/toolAvailability";
import type { BackendCapabilities, BackendProviders } from "@/features/backend/types";
import { createMockDebuggerProvider } from "@/features/debugger/providers/MockDebuggerProvider";
import { createMockProfilerProvider } from "@/features/profiler/providers/MockProfilerProvider";
import { createFakeClock } from "@/lib/testing/fakeClock";

/**
 * The one place the reason a tool cannot be used is decided.
 *
 * An earlier design had every surface say "No target has been detected.", which is now
 * sometimes untrue — so what matters here is the order: the outermost cause wins,
 * and the target is only blamed when nothing else is wrong.
 */

const TOOLS: readonly GatedTool[] = ["debugger", "profiler"];

function capabilitiesFor(tools: { debugger: boolean; profiler: boolean }): BackendCapabilities {
  const clock = createFakeClock();
  const providers: BackendProviders = {
    target: null,
    debugger: tools.debugger ? createMockDebuggerProvider({ clock }) : null,
    profiler: tools.profiler ? createMockProfilerProvider({ clock }) : null,
  };
  return deriveCapabilities(providers);
}

describe("why a tool has nothing to work against", () => {
  test("an unsupported tool names itself, whatever the backend is doing", () => {
    for (const tool of TOOLS) {
      for (const backendReady of [true, false]) {
        const reason = unavailableReason(tool, { supported: false, backendReady });
        assert.match(reason, /provides no/, `${tool} (ready=${backendReady})`);
        assert.match(reason, new RegExp(tool), tool);
      }
    }
  });

  test("a backend that is not running is named before the target", () => {
    for (const tool of TOOLS) {
      assert.equal(
        unavailableReason(tool, { supported: true, backendReady: false }),
        "The developer backend is not running.",
        tool,
      );
    }
  });

  test("the target is only blamed when the backend and the tool are both fine", () => {
    for (const tool of TOOLS) {
      assert.equal(
        unavailableReason(tool, { supported: true, backendReady: true }),
        "No target has been detected.",
        tool,
      );
    }
  });

  test("every reason is a complete sentence a developer can act on", () => {
    for (const tool of TOOLS) {
      for (const supported of [true, false]) {
        for (const backendReady of [true, false]) {
          const reason = unavailableReason(tool, { supported, backendReady });
          assert.match(reason, /^[A-Z].*\.$/, reason);
        }
      }
    }
  });
});

describe("reading availability out of a backend snapshot", () => {
  test("a tool is available only while the backend is ready and supplies it", () => {
    const both = capabilitiesFor({ debugger: true, profiler: true });
    for (const state of BACKEND_STATES) {
      for (const tool of TOOLS) {
        const availability = toolAvailability(tool, state, both);
        assert.equal(availability.supported, true, `${tool} @ ${state}`);
        assert.equal(availability.backendReady, state === "ready", `${tool} @ ${state}`);
      }
    }
  });

  test("a tool the backend does not supply is unsupported even while it is ready", () => {
    const debuggerOnly = capabilitiesFor({ debugger: true, profiler: false });
    assert.deepEqual(toolAvailability("debugger", "ready", debuggerOnly), { supported: true, backendReady: true });
    assert.deepEqual(toolAvailability("profiler", "ready", debuggerOnly), { supported: false, backendReady: true });
  });

  test("the reason a ready backend gives for a missing tool is the tool, not the target", () => {
    const debuggerOnly = capabilitiesFor({ debugger: true, profiler: false });
    assert.equal(
      unavailableReason("profiler", toolAvailability("profiler", "ready", debuggerOnly)),
      "This developer backend provides no profiler.",
    );
    assert.equal(
      unavailableReason("debugger", toolAvailability("debugger", "ready", debuggerOnly)),
      "No target has been detected.",
    );
  });
});
