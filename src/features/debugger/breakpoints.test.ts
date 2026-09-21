import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  addBreakpoint,
  BREAKPOINT_LIMIT,
  breakpointsForScript,
  clearBreakpoints,
  findBreakpoint,
  hasEnabledBreakpoint,
  isValidBreakpointLine,
  removeBreakpoint,
  resetHitCounts,
  updateBreakpoint,
} from "@/features/debugger/breakpoints";
import type { Breakpoint } from "@/features/debugger/types";

function ids() {
  let next = 0;
  return () => `bp-${++next}`;
}

const seed = (): readonly Breakpoint[] => {
  const createId = ids();
  let list: readonly Breakpoint[] = [];
  list = addBreakpoint(list, { scriptId: "a", line: 10 }, createId);
  list = addBreakpoint(list, { scriptId: "a", line: 3 }, createId);
  list = addBreakpoint(list, { scriptId: "b", line: 7 }, createId);
  return list;
};

describe("breakpoint lines", () => {
  test("a line is a whole number of 1 or more", () => {
    assert.equal(isValidBreakpointLine(1), true);
    assert.equal(isValidBreakpointLine(0), false);
    assert.equal(isValidBreakpointLine(-3), false);
    assert.equal(isValidBreakpointLine(2.5), false);
    assert.equal(isValidBreakpointLine(Number.NaN), false);
  });
});

describe("adding and removing", () => {
  test("a breakpoint is added with its defaults", () => {
    const list = seed();
    assert.equal(list.length, 3);
    const first = findBreakpoint(list, "a", 10);
    assert.equal(first?.enabled, true);
    assert.equal(first?.hitCount, 0);
    assert.equal(first?.condition, undefined);
  });

  test("a line already marked is never marked twice", () => {
    const createId = ids();
    const list = seed();
    const again = addBreakpoint(list, { scriptId: "a", line: 10 }, createId);
    assert.equal(again, list);
  });

  test("removing one leaves the others, and removing nothing changes nothing", () => {
    const list = seed();
    const id = findBreakpoint(list, "a", 3)?.id ?? "";
    const next = removeBreakpoint(list, id);
    assert.equal(next.length, 2);
    assert.equal(findBreakpoint(next, "a", 3), null);
    assert.equal(removeBreakpoint(next, "missing"), next);
  });

  test("clearing takes every breakpoint, or only one script's", () => {
    const list = seed();
    assert.deepEqual(clearBreakpoints(list), []);
    const remaining = clearBreakpoints(list, "a");
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.scriptId, "b");
    assert.equal(clearBreakpoints(remaining, "unknown"), remaining);
  });

  test("the oldest are dropped once the limit is reached", () => {
    const createId = ids();
    let list: readonly Breakpoint[] = [];
    for (let line = 1; line <= BREAKPOINT_LIMIT + 5; line += 1) {
      list = addBreakpoint(list, { scriptId: "a", line }, createId);
    }
    assert.equal(list.length, BREAKPOINT_LIMIT);
    assert.equal(findBreakpoint(list, "a", 1), null);
    assert.ok(findBreakpoint(list, "a", BREAKPOINT_LIMIT + 5));
  });
});

describe("enabling and hit counts", () => {
  test("a disabled breakpoint keeps its place but does not stop execution", () => {
    const list = seed();
    const id = findBreakpoint(list, "a", 10)?.id ?? "";
    const next = updateBreakpoint(list, id, { enabled: false });

    assert.equal(next.length, 3);
    assert.equal(hasEnabledBreakpoint(next, "a", 10), false);
    assert.equal(hasEnabledBreakpoint(list, "a", 10), true);
    assert.equal(hasEnabledBreakpoint(list, "a", 99), false);
  });

  test("an update that changes nothing returns the same list", () => {
    const list = seed();
    const id = findBreakpoint(list, "a", 10)?.id ?? "";
    assert.equal(updateBreakpoint(list, id, { enabled: true }), list);
    assert.equal(updateBreakpoint(list, "missing", { enabled: false }), list);
  });

  test("hit counts are session state and can be put back to zero", () => {
    const list = seed();
    const id = findBreakpoint(list, "a", 10)?.id ?? "";
    const hit = updateBreakpoint(list, id, { hitCount: 3 });
    assert.equal(findBreakpoint(hit, "a", 10)?.hitCount, 3);

    const reset = resetHitCounts(hit);
    assert.equal(findBreakpoint(reset, "a", 10)?.hitCount, 0);
    // Nothing to reset is not a change.
    assert.equal(resetHitCounts(reset), reset);
  });
});

describe("reading a script's breakpoints", () => {
  test("only that script's, in line order", () => {
    const list = seed();
    assert.deepEqual(
      breakpointsForScript(list, "a").map((entry) => entry.line),
      [3, 10],
    );
    assert.deepEqual(breakpointsForScript(list, null), []);
    assert.deepEqual(breakpointsForScript(list, "unknown"), []);
  });
});
