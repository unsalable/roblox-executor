import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  deriveCapabilities,
  describeProviders,
  healthOf,
  isToolSupported,
  normalizeHealth,
  restingHealth,
} from "@/features/backend/capabilities";
import {
  createUnsupportedDebuggerProvider,
  createUnsupportedProfilerProvider,
  createUnsupportedTargetProvider,
} from "@/features/backend/providers/unsupported";
import { DEVELOPER_TOOLS } from "@/features/backend/types";
import type { BackendCapabilities, BackendProviders, ProviderHealthReport } from "@/features/backend/types";
import { createMockDebuggerProvider } from "@/features/debugger/providers/MockDebuggerProvider";
import type { DebuggerProvider } from "@/features/debugger/types";
import { createMockProfilerProvider } from "@/features/profiler/providers/MockProfilerProvider";
import { createLocalTestTargetProvider } from "@/features/target/providers/LocalTestTargetProvider";
import type { TargetProvider } from "@/features/target/types";
import { createFakeClock } from "@/lib/testing/fakeClock";

/**
 * What a backend supports, derived from the providers it supplies. Pure
 * functions only, so this needs no backend, no controller and no clock beyond
 * the one the providers ask for.
 */

const NONE: BackendProviders = { target: null, debugger: null, profiler: null };

/** What a backend that supplies nothing has to derive. Written out, not derived. */
const NOTHING_SUPPORTED: BackendCapabilities = {
  target: { canConnect: false, canCancelInject: false },
  debugger: { canDebug: false, canPause: false },
  profiler: { canProfile: false },
};

function allProviders(): BackendProviders {
  const clock = createFakeClock();
  return {
    target: createLocalTestTargetProvider({ clock }),
    debugger: createMockDebuggerProvider({ clock }),
    profiler: createMockProfilerProvider({ clock }),
  };
}

describe("deriving capabilities", () => {
  test("a backend that supplies everything supports everything its providers declare", () => {
    const capabilities = deriveCapabilities(allProviders());
    assert.deepEqual(capabilities, {
      target: { canConnect: true, canCancelInject: true },
      debugger: { canDebug: true, canPause: true },
      profiler: { canProfile: true },
    });
  });

  test("a backend that supplies nothing supports nothing", () => {
    assert.deepEqual(deriveCapabilities(NONE), NOTHING_SUPPORTED);
  });

  test("a tool the backend does not supply is unsupported, one tool at a time", () => {
    const clock = createFakeClock();
    const targetOnly = deriveCapabilities({
      target: createLocalTestTargetProvider({ clock }),
      debugger: null,
      profiler: null,
    });
    assert.equal(targetOnly.target.canConnect, true);
    assert.equal(targetOnly.debugger.canDebug, false, "no debugger provider means no debugging");
    assert.equal(targetOnly.debugger.canPause, false, "a tool that is absent cannot pause either");
    assert.equal(targetOnly.profiler.canProfile, false);
  });

  test("a provider that cannot cancel is supported but says so, which is not the same fact", () => {
    const clock = createFakeClock();
    const base = createLocalTestTargetProvider({ clock });
    const noCancel: TargetProvider = { ...base, supportsCancel: false };
    const capabilities = deriveCapabilities({ target: noCancel, debugger: null, profiler: null });
    assert.equal(capabilities.target.canConnect, true, "it can still attach");
    assert.equal(capabilities.target.canCancelInject, false);
  });

  test("a debugger that cannot stop a run cannot pause", () => {
    const clock = createFakeClock();
    const base = createMockDebuggerProvider({ clock });
    const noPause: DebuggerProvider = { ...base, supportsCancel: false };
    const capabilities = deriveCapabilities({ target: null, debugger: noPause, profiler: null });
    assert.equal(capabilities.debugger.canDebug, true);
    assert.equal(capabilities.debugger.canPause, false);
  });

  test("the stand-in providers are honest: wired, and declaring they can do nothing extra", () => {
    // The composition root substitutes these, so they are never "null" to the
    // controllers — but a backend that supplied them would still report false.
    const capabilities = deriveCapabilities({
      target: createUnsupportedTargetProvider("Test"),
      debugger: createUnsupportedDebuggerProvider("Test"),
      profiler: createUnsupportedProfilerProvider("Test"),
    });
    assert.equal(capabilities.target.canCancelInject, false);
    assert.equal(capabilities.debugger.canPause, false);
  });

  test("isToolSupported answers for every tool without a lookup table of its own", () => {
    const capabilities = deriveCapabilities(allProviders());
    for (const tool of DEVELOPER_TOOLS) {
      assert.equal(isToolSupported(capabilities, tool), true, tool);
      assert.equal(isToolSupported(NOTHING_SUPPORTED, tool), false, tool);
    }
  });

  test("capabilities are frozen, so nothing downstream can quietly widen them", () => {
    const capabilities = deriveCapabilities(NONE);
    assert.throws(() => {
      (capabilities.debugger as { canDebug: boolean }).canDebug = true;
    });
  });
});

describe("describing the providers", () => {
  test("each supplied provider is described once, with the tool it serves", () => {
    const described = describeProviders(allProviders());
    assert.deepEqual(
      described.map((provider) => provider.tool),
      ["target", "debugger", "profiler"],
    );
    for (const provider of described) {
      assert.ok(provider.label.length > 0, `${provider.tool} needs a label`);
      assert.ok(provider.providerType.length > 0, `${provider.tool} needs a type`);
      assert.ok(provider.description.length > 0, `${provider.tool} needs a description`);
      assert.equal(provider.simulated, true, "every provider shipped today is a simulation");
    }
  });

  test("a tool the backend does not supply produces no entry at all", () => {
    assert.deepEqual(describeProviders(NONE), []);
    const clock = createFakeClock();
    const partial = describeProviders({
      target: createLocalTestTargetProvider({ clock }),
      debugger: null,
      profiler: null,
    });
    assert.deepEqual(
      partial.map((provider) => provider.tool),
      ["target"],
      "describing a provider that is not there would be a lie",
    );
  });
});

describe("provider health", () => {
  test("every tool gets a row, even one the backend said nothing about", () => {
    const capabilities = deriveCapabilities(allProviders());
    const reports = normalizeHealth([{ tool: "target", health: "healthy", reason: null }], capabilities);
    assert.deepEqual(
      reports.map((report) => report.tool),
      [...DEVELOPER_TOOLS],
    );
    assert.equal(healthOf(reports, "debugger").health, "unavailable");
    assert.match(healthOf(reports, "debugger").reason ?? "", /did not report/);
  });

  test("an unsupported tool says the backend supplies none, not that it failed", () => {
    const reports = normalizeHealth([], NOTHING_SUPPORTED);
    for (const report of reports) {
      assert.equal(report.health, "unavailable", report.tool);
      assert.match(report.reason ?? "", /supplies no provider/, report.tool);
    }
  });

  test("what the backend reported is kept, degraded and error included", () => {
    const capabilities = deriveCapabilities(allProviders());
    const reported: readonly ProviderHealthReport[] = [
      { tool: "target", health: "healthy", reason: null },
      { tool: "debugger", health: "degraded", reason: "Stepping is slower than usual." },
      { tool: "profiler", health: "error", reason: "The recorder refused." },
    ];
    const reports = normalizeHealth(reported, capabilities);
    assert.equal(healthOf(reports, "debugger").health, "degraded");
    assert.equal(healthOf(reports, "profiler").reason, "The recorder refused.");
  });

  test("a backend that is not running reports one reason for every tool", () => {
    const reports = restingHealth("The backend is stopped.");
    assert.equal(reports.length, DEVELOPER_TOOLS.length);
    for (const report of reports) {
      assert.equal(report.health, "unavailable", report.tool);
      assert.equal(report.reason, "The backend is stopped.");
    }
  });

  test("asking about a tool no report mentions answers unavailable rather than throwing", () => {
    const report = healthOf([], "profiler");
    assert.equal(report.tool, "profiler");
    assert.equal(report.health, "unavailable");
  });
});
