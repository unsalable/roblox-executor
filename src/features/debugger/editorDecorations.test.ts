import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildDebugDecorations, DEBUG_CLASS } from "@/features/debugger/editorDecorations";
import { buildDebugProgram } from "@/features/debugger/providers/MockDebuggerProvider";
import { countScriptLines, debugContextFromExplorer, debugTargetFromScript } from "@/features/debugger/session";
import type { Breakpoint } from "@/features/debugger/types";
import { buildExplorerModel } from "@/features/explorer/explorerModel";
import type { ExplorerNodeData } from "@/features/explorer/types";

const breakpoint = (line: number, enabled = true): Breakpoint => ({
  id: `bp-${line}`,
  scriptId: "s1",
  line,
  enabled,
  hitCount: 0,
});

describe("what the editor draws", () => {
  test("each breakpoint becomes one glyph, in line order", () => {
    const decorations = buildDebugDecorations({
      breakpoints: [breakpoint(9), breakpoint(2)],
      activeLine: null,
    });

    assert.deepEqual(
      decorations.map((entry) => entry.line),
      [2, 9],
    );
    assert.equal(decorations[0]?.glyphClassName, DEBUG_CLASS.breakpoint);
    assert.equal(decorations[0]?.lineClassName, undefined);
  });

  test("a disabled breakpoint keeps its place and is drawn differently", () => {
    const [decoration] = buildDebugDecorations({ breakpoints: [breakpoint(4, false)], activeLine: null });
    assert.equal(decoration?.glyphClassName, DEBUG_CLASS.breakpointDisabled);
    assert.match(decoration?.hoverMessage ?? "", /disabled/);
  });

  test("the stopped line is highlighted even where there is no breakpoint", () => {
    const decorations = buildDebugDecorations({ breakpoints: [], activeLine: 7 });
    assert.equal(decorations.length, 1);
    assert.equal(decorations[0]?.lineClassName, DEBUG_CLASS.activeLine);
    assert.equal(decorations[0]?.marginClassName, DEBUG_CLASS.activeGlyph);
  });

  test("a line that is both stopped on and marked gets one decoration, not two", () => {
    const decorations = buildDebugDecorations({ breakpoints: [breakpoint(5)], activeLine: 5 });

    assert.equal(decorations.length, 1);
    assert.equal(decorations[0]?.glyphClassName, DEBUG_CLASS.breakpoint);
    assert.equal(decorations[0]?.lineClassName, DEBUG_CLASS.activeLine);
    assert.match(decorations[0]?.hoverMessage ?? "", /stopped here/);
  });

  test("a hit count is shown where the breakpoint is", () => {
    const decorations = buildDebugDecorations({
      breakpoints: [{ ...breakpoint(3), hitCount: 2 }],
      activeLine: null,
    });
    assert.match(decorations[0]?.hoverMessage ?? "", /hit 2/);
  });

  test("nothing to draw is nothing, not an empty highlight", () => {
    assert.deepEqual(buildDebugDecorations({ breakpoints: [], activeLine: null }), []);
    assert.deepEqual(buildDebugDecorations({ breakpoints: [], activeLine: 0 }), []);
  });
});

describe("what a session is started with", () => {
  test("a script becomes a target with the lines it has", () => {
    const target = debugTargetFromScript({ id: "s1", name: "Main.lua", content: "a\nb\nc" });
    assert.deepEqual(target, { scriptId: "s1", scriptName: "Main.lua", lineCount: 3 });
    assert.equal(debugTargetFromScript(null), null);
  });

  test("an empty script still has a first line to stop on", () => {
    assert.equal(countScriptLines(""), 1);
    assert.equal(countScriptLines("one line"), 1);
    assert.equal(countScriptLines("a\n"), 2);
  });

  test("the context is the object selected in the Explorer, with its path", () => {
    const data: readonly ExplorerNodeData[] = [
      { id: "workspace", name: "Workspace", className: "Workspace", parentId: null },
      { id: "camera", name: "Camera", className: "Camera", parentId: "workspace" },
    ];
    const model = buildExplorerModel(data);

    assert.deepEqual(debugContextFromExplorer(model, "camera"), {
      objectId: "camera",
      name: "Camera",
      className: "Camera",
      path: "Workspace / Camera",
    });
    assert.equal(debugContextFromExplorer(model, null), null);
    assert.equal(debugContextFromExplorer(model, "ghost"), null);
  });
});

describe("the mock program", () => {
  test("a long script gets the three-function shape, main first and last", () => {
    const depths = buildDebugProgram(20);
    assert.equal(depths.length, 20);
    assert.equal(depths[0], 1);
    assert.equal(depths.at(-1), 1);
    assert.deepEqual([...new Set(depths)].sort(), [1, 2, 3]);
  });

  test("short scripts degrade rather than breaking", () => {
    assert.deepEqual(buildDebugProgram(1), [1]);
    assert.deepEqual(buildDebugProgram(2), [1, 2]);
    assert.deepEqual(buildDebugProgram(3), [1, 2, 3]);
    assert.deepEqual(buildDebugProgram(0), [1]);
  });

  test("the same script always produces the same program", () => {
    assert.deepEqual(buildDebugProgram(37), buildDebugProgram(37));
  });
});
