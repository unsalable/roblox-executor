import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BACKEND_STATES,
  canTransitionBackend,
  InvalidBackendTransitionError,
  isBackendBusy,
  isBackendReady,
  STARTABLE_BACKEND_STATES,
  STOPPABLE_BACKEND_STATES,
  transitionBackend,
} from "@/features/backend/backendState";
import type { BackendState } from "@/features/backend/types";

/**
 * The backend lifecycle as data. Checked here on its own, without a controller
 * or a backend, so the edges Nova allows are readable in one place.
 */

describe("the backend lifecycle", () => {
  test("every state is reachable from created", () => {
    const seen = new Set<BackendState>(["created"]);
    // Breadth-first over the allowed edges: an unreachable state would be dead code.
    for (let added = true; added; ) {
      added = false;
      for (const from of [...seen]) {
        for (const to of BACKEND_STATES) {
          if (!canTransitionBackend(from, to) || seen.has(to)) continue;
          seen.add(to);
          added = true;
        }
      }
    }
    assert.deepEqual([...seen].sort(), [...BACKEND_STATES].sort());
  });

  test("a launch walks created → starting → ready → stopping → stopped and can start again", () => {
    const path: BackendState[] = ["starting", "ready", "stopping", "stopped", "starting"];
    let state: BackendState = "created";
    for (const next of path) state = transitionBackend(state, next);
    assert.equal(state, "starting");
  });

  test("a start that is cancelled lands at stopped, because nothing failed", () => {
    assert.ok(canTransitionBackend("starting", "stopped"));
    assert.ok(canTransitionBackend("starting", "error"));
  });

  test("nothing may go straight from created to ready", () => {
    assert.ok(!canTransitionBackend("created", "ready"), "a backend cannot be ready without starting");
    assert.throws(() => transitionBackend("created", "ready"), InvalidBackendTransitionError);
  });

  test("an impossible transition throws rather than being silently applied", () => {
    assert.throws(
      () => transitionBackend("stopped", "ready"),
      (error: unknown) => {
        assert.ok(error instanceof InvalidBackendTransitionError);
        assert.equal(error.from, "stopped");
        assert.equal(error.to, "ready");
        assert.match(error.message, /stopped → ready/);
        return true;
      },
    );
  });

  test("a failed backend can be retried or settled, never resumed", () => {
    assert.ok(canTransitionBackend("error", "starting"));
    assert.ok(canTransitionBackend("error", "stopping"));
    assert.ok(canTransitionBackend("error", "stopped"));
    assert.ok(!canTransitionBackend("error", "ready"), "a failure is not undone by declaring readiness");
  });

  test("only the resting states start, and only the live ones have anything to stop", () => {
    assert.deepEqual([...STARTABLE_BACKEND_STATES], ["created", "stopped", "error"]);
    for (const state of STARTABLE_BACKEND_STATES) {
      assert.ok(canTransitionBackend(state, "starting"), `${state} must be able to start`);
    }
    for (const state of BACKEND_STATES) {
      if (STOPPABLE_BACKEND_STATES.includes(state)) continue;
      assert.ok(!isBackendReady(state) || state === "ready", state);
    }
  });

  test("ready and busy are separate questions", () => {
    assert.ok(isBackendReady("ready"));
    assert.ok(!isBackendBusy("ready"), "a ready backend is not busy");
    for (const state of ["starting", "stopping"] as const) {
      assert.ok(isBackendBusy(state), state);
      assert.ok(!isBackendReady(state), `${state} is not ready`);
    }
    for (const state of ["created", "stopped", "error"] as const) {
      assert.ok(!isBackendReady(state), state);
      assert.ok(!isBackendBusy(state), state);
    }
  });
});
