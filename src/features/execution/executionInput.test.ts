import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildExecutionInput, type ExecuteTarget } from "@/features/execution/executionInput";
import { validateExecutionInput, type ValidationEnvironment } from "@/features/execution/validation";

const target = (selectedText: string): ExecuteTarget => ({
  script: { id: "script-1", name: "Main.lua", content: "local a = 1\nprint(a)\n" },
  selectedText,
});

const environment: ValidationEnvironment = {
  phase: "idle",
  timeoutMs: 5000,
  providerLabel: "Local Test Execution",
  requiresTarget: false,
  targetReady: false,
};

describe("execute command → execution input", () => {
  test("auto without a selection executes the full script", () => {
    assert.deepEqual(buildExecutionInput("auto", target("")), {
      mode: "full-script",
      script: { id: "script-1", name: "Main.lua" },
      source: "local a = 1\nprint(a)\n",
    });
  });

  test("auto with a selection executes only the selected text", () => {
    assert.deepEqual(buildExecutionInput("auto", target("print(a)")), {
      mode: "selection",
      script: { id: "script-1", name: "Main.lua" },
      source: "print(a)",
    });
  });

  test("an explicit full-script command ignores the selection", () => {
    const input = buildExecutionInput("full-script", target("print(a)"));
    assert.equal(input.mode, "full-script");
    assert.equal(input.source, "local a = 1\nprint(a)\n");
  });

  test("an explicit selection command without a selection is refused by validation", () => {
    const input = buildExecutionInput("selection", target(""));
    assert.equal(input.mode, "selection");
    assert.equal(validateExecutionInput(input, environment)?.code, "EMPTY_SELECTION");
  });

  test("a whitespace-only selection is still selection mode and is refused", () => {
    const input = buildExecutionInput("auto", target("  \n "));
    assert.equal(input.mode, "selection");
    assert.equal(validateExecutionInput(input, environment)?.code, "EMPTY_SELECTION");
  });

  test("no open script produces an input that validation rejects", () => {
    const input = buildExecutionInput("auto", { script: null, selectedText: "" });
    assert.deepEqual(input, { mode: "full-script", script: null, source: null });
    assert.equal(validateExecutionInput(input, environment)?.code, "NO_ACTIVE_SCRIPT");
  });

  test("the document is not modified", () => {
    const current = target("print(a)");
    const before = structuredClone(current);
    buildExecutionInput("auto", current);
    assert.deepEqual(current, before);
  });
});
