import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ACTIVE_DEBUG_STATES,
  DEBUG_STATES,
  canTransitionDebug,
  InvalidDebugTransitionError,
  isDebugPaused,
  isDebugSessionActive,
  STARTABLE_DEBUG_STATES,
  transitionDebug,
} from "@/features/debugger/debuggerState";

describe("debugger state machine", () => {
  test("a launch starts with no target and no session", () => {
    assert.ok(DEBUG_STATES.includes("unavailable"));
    assert.equal(canTransitionDebug("unavailable", "running"), false);
    assert.equal(canTransitionDebug("unavailable", "ready"), true);
  });

  test("the happy path runs start → pause → continue → stop", () => {
    assert.equal(transitionDebug("ready", "running"), "running");
    assert.equal(transitionDebug("running", "paused"), "paused");
    assert.equal(transitionDebug("paused", "running"), "running");
    assert.equal(transitionDebug("running", "stopped"), "stopped");
    assert.equal(transitionDebug("stopped", "ready"), "ready");
  });

  test("losing the target is applied from every state", () => {
    for (const state of DEBUG_STATES) {
      if (state === "unavailable") continue;
      assert.equal(canTransitionDebug(state, "unavailable"), true, `${state} → unavailable`);
    }
  });

  test("an impossible transition throws rather than being applied silently", () => {
    assert.throws(() => transitionDebug("unavailable", "paused"), InvalidDebugTransitionError);
    assert.throws(() => transitionDebug("ready", "paused"), InvalidDebugTransitionError);
    assert.throws(() => transitionDebug("running", "ready"), InvalidDebugTransitionError);
  });

  test("a session can only be started from a resting state", () => {
    assert.deepEqual([...STARTABLE_DEBUG_STATES], ["ready", "stopped", "error"]);
    for (const state of STARTABLE_DEBUG_STATES) {
      assert.equal(canTransitionDebug(state, "running"), true, `${state} startable`);
    }
    // `paused` also reaches `running`, but by continuing rather than starting.
    for (const state of ACTIVE_DEBUG_STATES) {
      assert.equal(STARTABLE_DEBUG_STATES.includes(state), false, `${state} not startable`);
    }
    assert.deepEqual([...ACTIVE_DEBUG_STATES], ["running", "paused"]);
  });

  test("the helpers answer what the UI asks", () => {
    assert.equal(isDebugSessionActive("paused"), true);
    assert.equal(isDebugSessionActive("stopped"), false);
    assert.equal(isDebugPaused("paused"), true);
    assert.equal(isDebugPaused("running"), false);
  });
});
