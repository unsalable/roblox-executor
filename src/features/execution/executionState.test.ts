import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  canTransitionExecution,
  EXECUTION_PHASES,
  InvalidExecutionTransitionError,
  isExecutionBusy,
  transitionExecution,
} from "@/features/execution/executionState";
import type { ExecutionPhase } from "@/features/execution/types";

const walk = (...phases: ExecutionPhase[]) =>
  phases.reduce((from, to) => transitionExecution(from, to));

describe("execution state machine", () => {
  test("covers exactly the six phases", () => {
    assert.deepEqual([...EXECUTION_PHASES].sort(), ["cancelled", "error", "idle", "preparing", "running", "success"]);
  });

  test("idle → preparing → running → success", () => {
    assert.equal(walk("idle", "preparing", "running", "success"), "success");
  });

  test("running can end in error or cancelled", () => {
    assert.equal(walk("idle", "preparing", "running", "error"), "error");
    assert.equal(walk("idle", "preparing", "running", "cancelled"), "cancelled");
  });

  test("preparing can fail or be cancelled before running", () => {
    assert.equal(walk("idle", "preparing", "error"), "error");
    assert.equal(walk("idle", "preparing", "cancelled"), "cancelled");
  });

  test("a finished execution is only left through a new request", () => {
    for (const terminal of ["success", "error", "cancelled"] as const) {
      assert.equal(transitionExecution(terminal, "preparing"), "preparing");
      for (const target of EXECUTION_PHASES.filter((phase) => phase !== "preparing")) {
        assert.equal(canTransitionExecution(terminal, target), false, `${terminal} → ${target}`);
      }
    }
  });

  test("rejects nonsensical transitions", () => {
    const invalid: [ExecutionPhase, ExecutionPhase][] = [
      ["success", "running"],
      ["idle", "running"],
      ["idle", "success"],
      ["idle", "cancelled"],
      ["preparing", "success"],
      ["preparing", "idle"],
      ["running", "preparing"],
      ["running", "idle"],
      ["error", "success"],
      ["cancelled", "running"],
    ];
    for (const [from, to] of invalid) {
      assert.throws(
        () => transitionExecution(from, to),
        (error: unknown) => error instanceof InvalidExecutionTransitionError && error.from === from && error.to === to,
        `${from} → ${to}`,
      );
    }
  });

  test("no phase transitions to itself", () => {
    for (const phase of EXECUTION_PHASES) assert.equal(canTransitionExecution(phase, phase), false, phase);
  });

  test("only preparing and running are busy", () => {
    assert.deepEqual(EXECUTION_PHASES.filter(isExecutionBusy).sort(), ["preparing", "running"]);
  });
});
