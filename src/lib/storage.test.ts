import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { normalizeSettings } from "@/lib/storage";
import { defaultSettings, TIMEOUT_LIMITS } from "@/types/settings";

describe("settings persistence", () => {
  test("missing or malformed data yields the defaults", () => {
    for (const value of [undefined, null, 42, "settings", []]) {
      assert.deepEqual(normalizeSettings(value), defaultSettings, JSON.stringify(value));
    }
  });

  test("settings stored before the target model keep their values and gain the new section", () => {
    const earlier = {
      general: { confirmOnExit: false },
      editor: { fontSize: 16, tabSize: 4, wordWrap: true, minimap: true },
      appearance: { theme: "light" },
      executor: { confirmBeforeRun: false },
      performance: { showDiagnostics: true },
    };

    assert.deepEqual(normalizeSettings(earlier), {
      ...earlier,
      executor: { confirmBeforeRun: false, clearConsoleBeforeRun: false, timeoutMs: 5000 },
      target: defaultSettings.target,
      developer: defaultSettings.developer,
      updates: defaultSettings.updates,
    });
  });

  test("settings of the retired Studio bridge are dropped, not migrated", () => {
    const settings = normalizeSettings({
      connection: { autoConnect: true, timeoutMs: 9000 },
      studioBridge: { provider: "studio", port: 46_682, pairingTimeoutMs: 60_000 },
      target: { autoInject: true },
    });

    assert.ok(!("connection" in settings));
    assert.ok(!("studioBridge" in settings));
    assert.deepEqual(Object.keys(settings).sort(), [
      "appearance",
      "developer",
      "editor",
      "executor",
      "general",
      "performance",
      "target",
      "updates",
    ]);
    assert.equal(settings.target.autoInject, true);
  });

  test("target values of the wrong type fall back to their defaults", () => {
    const settings = normalizeSettings({
      target: { autoDetect: "yes", autoInject: true, injectTimeoutMs: "fast", autoReconnect: 1 },
    });
    assert.deepEqual(settings.target, {
      autoDetect: true,
      autoInject: true,
      injectTimeoutMs: 5000,
      autoReconnect: false,
    });
  });

  test("timeouts are kept within their allowed ranges", () => {
    const low = normalizeSettings({ executor: { timeoutMs: 10 }, target: { injectTimeoutMs: -5 } });
    assert.equal(low.executor.timeoutMs, TIMEOUT_LIMITS.execution.min);
    assert.equal(low.target.injectTimeoutMs, TIMEOUT_LIMITS.inject.min);

    const high = normalizeSettings({ executor: { timeoutMs: 1e9 }, target: { injectTimeoutMs: 1e9 } });
    assert.equal(high.executor.timeoutMs, TIMEOUT_LIMITS.execution.max);
    assert.equal(high.target.injectTimeoutMs, TIMEOUT_LIMITS.inject.max);
  });

  test("the developer timeouts are kept within their allowed ranges too", () => {
    const low = normalizeSettings({ developer: { backendStartupTimeoutMs: 1, healthCheckIntervalMs: 0 } });
    assert.equal(low.developer.backendStartupTimeoutMs, TIMEOUT_LIMITS.backendStartup.min);
    assert.equal(low.developer.healthCheckIntervalMs, TIMEOUT_LIMITS.healthCheck.min);

    const high = normalizeSettings({ developer: { backendStartupTimeoutMs: 1e9, healthCheckIntervalMs: 1e9 } });
    assert.equal(high.developer.backendStartupTimeoutMs, TIMEOUT_LIMITS.backendStartup.max);
    assert.equal(high.developer.healthCheckIntervalMs, TIMEOUT_LIMITS.healthCheck.max);

    const wrongType = normalizeSettings({ developer: { backendStartupTimeoutMs: "quick", healthCheckIntervalMs: null } });
    assert.equal(wrongType.developer.backendStartupTimeoutMs, defaultSettings.developer.backendStartupTimeoutMs);
    assert.equal(wrongType.developer.healthCheckIntervalMs, defaultSettings.developer.healthCheckIntervalMs);
  });

  test("settings stored before the developer timeouts gain them at their defaults", () => {
    const settings = normalizeSettings({ developer: { backendId: "local-service", autoStartBackend: false } });
    assert.equal(settings.developer.backendId, "local-service");
    assert.equal(settings.developer.autoStartBackend, false);
    assert.equal(settings.developer.backendStartupTimeoutMs, defaultSettings.developer.backendStartupTimeoutMs);
    assert.equal(settings.developer.healthCheckIntervalMs, defaultSettings.developer.healthCheckIntervalMs);
  });

  test("unknown stored keys are dropped", () => {
    const settings = normalizeSettings({
      executor: { timeoutMs: 2000, legacyFlag: true },
      target: { autoDetect: false, processId: 4213 },
      developer: { backendId: "local-service", sessionToken: "secret", sessionId: "session-1" },
    });
    assert.deepEqual(Object.keys(settings.developer).sort(), [
      "autoStartBackend",
      "backendId",
      "backendStartupTimeoutMs",
      "healthCheckIntervalMs",
    ]);
    assert.deepEqual(Object.keys(settings.executor).sort(), ["clearConsoleBeforeRun", "confirmBeforeRun", "timeoutMs"]);
    assert.deepEqual(Object.keys(settings.target).sort(), [
      "autoDetect",
      "autoInject",
      "autoReconnect",
      "injectTimeoutMs",
    ]);
    assert.equal(settings.executor.timeoutMs, 2000);
    assert.equal(settings.target.autoDetect, false);
  });

  test("a live target or execution state is never part of the settings", () => {
    const settings = normalizeSettings({ target: { autoDetect: true, status: "injected", session: "active" } });
    assert.ok(!("status" in settings.target));
    assert.ok(!("session" in settings.target));
  });

  test("settings stored before the updater gain the startup check, on", () => {
    // On is the shipped default: a build that never asks is a build that stays
    // on an old version without ever saying so.
    const settings = normalizeSettings({ general: { confirmOnExit: false } });
    assert.deepEqual(settings.updates, { checkOnStartup: true });
  });

  test("the update source is never a setting", () => {
    // It is compiled into the application. A stored value must not be able to
    // point Nova at another server, so nothing resembling one survives.
    const settings = normalizeSettings({
      updates: { checkOnStartup: false, endpoint: "https://evil.example/latest.json", pubkey: "x" },
    });
    assert.deepEqual(settings.updates, { checkOnStartup: false });
    assert.equal(JSON.stringify(settings).includes("evil.example"), false);
  });
});

