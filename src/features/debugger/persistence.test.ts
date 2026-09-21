import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BREAKPOINTS_SCHEMA_VERSION,
  parseBreakpoints,
  serializeBreakpoints,
} from "@/features/debugger/persistence";
import type { Breakpoint } from "@/features/debugger/types";

function context() {
  let next = 0;
  return { createId: () => `new-${++next}` };
}

const parse = (value: unknown) => parseBreakpoints(JSON.parse(JSON.stringify(value)), context());

const breakpoint = (overrides: Partial<Breakpoint> = {}): Breakpoint => ({
  id: "bp-1",
  scriptId: "script-1",
  line: 12,
  enabled: true,
  hitCount: 0,
  ...overrides,
});

describe("breakpoint round trip", () => {
  test("what is stored comes back the same, without session state", () => {
    const stored = serializeBreakpoints([
      breakpoint({ hitCount: 7 }),
      breakpoint({ id: "bp-2", line: 3, enabled: false, condition: "health < 20" }),
    ]);

    assert.equal(stored.version, BREAKPOINTS_SCHEMA_VERSION);
    assert.equal("hitCount" in stored.breakpoints[0]!, false, "hit counts describe a session, not a setting");

    const { breakpoints, issues } = parse(stored);
    assert.deepEqual(issues, []);
    assert.equal(breakpoints.length, 2);
    assert.equal(breakpoints[0]?.hitCount, 0);
    assert.equal(breakpoints[1]?.enabled, false);
    assert.equal(breakpoints[1]?.condition, "health < 20");
  });

  test("a breakpoint without a condition does not store an empty one", () => {
    const stored = serializeBreakpoints([breakpoint()]);
    assert.equal("condition" in stored.breakpoints[0]!, false);
  });
});

describe("reading damaged data", () => {
  test("anything that is not a breakpoint document gives none", () => {
    for (const value of [null, 42, "breakpoints", [], {}, { version: 1 }]) {
      const { breakpoints, issues } = parse(value);
      assert.deepEqual(breakpoints, [], JSON.stringify(value));
      assert.equal(issues.length, 1);
    }
  });

  test("a version this build cannot read is refused rather than guessed at", () => {
    const { breakpoints, issues } = parse({ version: 99, breakpoints: [breakpoint()] });
    assert.deepEqual(breakpoints, []);
    assert.match(issues[0] ?? "", /unsupported breakpoint version/);
  });

  test("entries that name no script or no usable line are dropped", () => {
    const { breakpoints, issues } = parse({
      version: 1,
      breakpoints: [
        { id: "a", scriptId: "", line: 4, enabled: true },
        { id: "b", scriptId: "s", line: 0, enabled: true },
        { id: "c", scriptId: "s", line: 2.5, enabled: true },
        "not an object",
        { id: "d", scriptId: "s", line: 9, enabled: true },
      ],
    });

    assert.equal(breakpoints.length, 1);
    assert.equal(breakpoints[0]?.line, 9);
    assert.equal(issues.length, 4);
  });

  test("a line stored twice keeps the first, so the editor can never show two", () => {
    const { breakpoints, issues } = parse({
      version: 1,
      breakpoints: [
        { id: "a", scriptId: "s", line: 5, enabled: true },
        { id: "b", scriptId: "s", line: 5, enabled: false },
      ],
    });

    assert.equal(breakpoints.length, 1);
    assert.equal(breakpoints[0]?.enabled, true);
    assert.match(issues[0] ?? "", /second breakpoint/);
  });

  test("a missing or repeated id is replaced rather than dropping the breakpoint", () => {
    const { breakpoints, issues } = parse({
      version: 1,
      breakpoints: [
        { scriptId: "s", line: 1, enabled: true },
        { id: "same", scriptId: "s", line: 2, enabled: true },
        { id: "same", scriptId: "s", line: 3, enabled: true },
      ],
    });

    assert.equal(breakpoints.length, 3);
    assert.equal(new Set(breakpoints.map((entry) => entry.id)).size, 3);
    assert.equal(issues.length, 2);
  });

  test("an unreadable enabled flag leaves the breakpoint enabled and says so", () => {
    const { breakpoints, issues } = parse({
      version: 1,
      breakpoints: [{ id: "a", scriptId: "s", line: 4, enabled: "yes" }],
    });

    assert.equal(breakpoints[0]?.enabled, true);
    assert.match(issues[0] ?? "", /enabled flag/);
  });
});
