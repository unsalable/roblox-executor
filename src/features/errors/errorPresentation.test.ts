import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  describeBackendError,
  describeDebugError,
  describeExecutionError,
  describeProfilerError,
  describeTargetError,
  PRESENTED_BACKEND_CODES,
  PRESENTED_DEBUG_CODES,
  PRESENTED_EXECUTION_CODES,
  PRESENTED_PROFILER_CODES,
  PRESENTED_TARGET_CODES,
  type ErrorActionId,
} from "@/features/errors/errorPresentation";

/** The shell's own actions. A presentation may offer one of these, or none. */
const REAL_ACTIONS: readonly ErrorActionId[] = [
  "detect-target",
  "inject",
  "disconnect-target",
  "open-settings",
  "new-script",
];

describe("presenting target errors", () => {
  test("every code Nova can report has a presentation", () => {
    for (const code of PRESENTED_TARGET_CODES) {
      const presentation = describeTargetError({ code, message: "" });
      assert.equal(presentation.code, code);
      assert.ok(presentation.title.length > 0, `${code} needs a title`);
      assert.ok(presentation.explanation.length > 0, `${code} needs an explanation`);
    }
  });

  test("the next step is always one of the actions the shell really has", () => {
    for (const code of PRESENTED_TARGET_CODES) {
      const { action } = describeTargetError({ code, message: "" });
      if (action !== null) assert.ok(REAL_ACTIONS.includes(action.id), `${code} offers ${action.id}`);
    }
  });

  test("a target that is not ready explains itself and offers detection", () => {
    const presentation = describeTargetError({ code: "TARGET_NOT_READY", message: "The target is not ready." });
    assert.equal(presentation.title, "Target Not Ready");
    assert.match(presentation.explanation, /not ready/);
    assert.equal(presentation.code, "TARGET_NOT_READY");
    assert.deepEqual(presentation.action, { id: "detect-target", label: "Detect Target" });
  });

  test("a timeout points at the setting that governs it", () => {
    const presentation = describeTargetError({ code: "INJECTION_TIMEOUT", message: "" });
    assert.equal(presentation.action?.id, "open-settings");
    assert.match(presentation.explanation, /Settings › Target/);
  });

  test("a provider problem offers no action, because none of them would help", () => {
    assert.equal(describeTargetError({ code: "PROVIDER_UNAVAILABLE", message: "" }).action, null);
    assert.equal(describeTargetError({ code: "PROVIDER_MISCONFIGURED", message: "" }).action, null);
  });

  test("the controller's own sentence is kept when it says something new", () => {
    const presentation = describeTargetError({
      code: "INJECTION_FAILED",
      message: "The simulated injection was configured to fail.",
    });
    assert.equal(presentation.reported, "The simulated injection was configured to fail.");
  });

  test("a message that repeats the explanation is not shown twice", () => {
    const explanation = describeTargetError({ code: "TARGET_UNAVAILABLE", message: "" }).explanation;
    assert.equal(describeTargetError({ code: "TARGET_UNAVAILABLE", message: explanation }).reported, null);
    assert.equal(describeTargetError({ code: "TARGET_UNAVAILABLE", message: "   " }).reported, null);
  });

  test("technical details are carried through, trimmed, and absent when empty", () => {
    assert.equal(
      describeTargetError({ code: "INJECTION_FAILED", message: "x", details: "  Provider: Local Test Target  " })
        .details,
      "Provider: Local Test Target",
    );
    assert.equal(describeTargetError({ code: "INJECTION_FAILED", message: "x" }).details, null);
    assert.equal(describeTargetError({ code: "INJECTION_FAILED", message: "x", details: "  " }).details, null);
  });
});

describe("presenting execution errors", () => {
  test("every code Nova can report has a presentation", () => {
    for (const code of PRESENTED_EXECUTION_CODES) {
      const presentation = describeExecutionError({ code, message: "" });
      assert.equal(presentation.code, code);
      assert.ok(presentation.title.length > 0, `${code} needs a title`);
      assert.ok(presentation.explanation.length > 0, `${code} needs an explanation`);
    }
  });

  test("the next step is always one of the actions the shell really has", () => {
    for (const code of PRESENTED_EXECUTION_CODES) {
      const { action } = describeExecutionError({ code, message: "" });
      if (action !== null) assert.ok(REAL_ACTIONS.includes(action.id), `${code} offers ${action.id}`);
    }
  });

  test("an execution refused for want of a target reads like the target's own refusal", () => {
    const presentation = describeExecutionError({ code: "TARGET_NOT_READY", message: "" });
    assert.equal(presentation.title, "Target Not Ready");
    assert.equal(presentation.action?.label, "Detect Target");
  });

  test("having no script open offers the action that fixes it", () => {
    assert.deepEqual(describeExecutionError({ code: "NO_ACTIVE_SCRIPT", message: "" }).action, {
      id: "new-script",
      label: "New Script",
    });
  });

  test("a refusal that only waiting fixes offers nothing", () => {
    assert.equal(describeExecutionError({ code: "EXECUTION_ALREADY_RUNNING", message: "" }).action, null);
  });

  test("no presentation claims a target state; they describe the failure only", () => {
    for (const code of PRESENTED_EXECUTION_CODES) {
      const { explanation } = describeExecutionError({ code, message: "" });
      assert.ok(!/is injected|is ready|is attached/i.test(explanation), `${code} must not claim a target state`);
    }
  });
});

describe("presenting debugger and profiler errors", () => {
  test("every code either tool can report has a presentation", () => {
    for (const code of PRESENTED_DEBUG_CODES) {
      const presentation = describeDebugError({ code, message: "" });
      assert.equal(presentation.code, code);
      assert.ok(presentation.title.length > 0, `${code} needs a title`);
      assert.ok(presentation.explanation.length > 0, `${code} needs an explanation`);
    }
    for (const code of PRESENTED_PROFILER_CODES) {
      const presentation = describeProfilerError({ code, message: "" });
      assert.equal(presentation.code, code);
      assert.ok(presentation.title.length > 0, `${code} needs a title`);
      assert.ok(presentation.explanation.length > 0, `${code} needs an explanation`);
    }
  });

  test("the next step is always one of the actions the shell really has", () => {
    for (const code of PRESENTED_DEBUG_CODES) {
      const { action } = describeDebugError({ code, message: "" });
      if (action !== null) assert.ok(REAL_ACTIONS.includes(action.id), `${code} offers ${action.id}`);
    }
    for (const code of PRESENTED_PROFILER_CODES) {
      const { action } = describeProfilerError({ code, message: "" });
      if (action !== null) assert.ok(REAL_ACTIONS.includes(action.id), `${code} offers ${action.id}`);
    }
  });

  test("a tool with no target points at detection, as the target's own errors do", () => {
    assert.equal(describeDebugError({ code: "DEBUGGER_UNAVAILABLE", message: "" }).action?.id, "detect-target");
    assert.equal(describeProfilerError({ code: "PROFILER_UNAVAILABLE", message: "" }).action?.id, "detect-target");
  });

  test("a watch that could not be read says what a watch is, and is not offered a retry", () => {
    const presentation = describeDebugError({ code: "WATCH_EVALUATION_FAILED", message: "" });
    assert.match(presentation.explanation, /never run code/);
    assert.equal(presentation.action, null);
  });

  test("the controller's own sentence is kept only when it adds something", () => {
    const plain = describeDebugError({ code: "BREAKPOINT_INVALID", message: "" });
    assert.equal(plain.reported, null);

    const detailed = describeDebugError({
      code: "BREAKPOINT_INVALID",
      message: "A breakpoint needs a line number of 1 or more.",
      details: "Requested line: 0",
    });
    assert.equal(detailed.details, "Requested line: 0");
    assert.ok(detailed.reported !== null);
  });
});

describe("presenting developer backend errors", () => {
  test("every code Nova can report has a presentation", () => {
    for (const code of PRESENTED_BACKEND_CODES) {
      const presentation = describeBackendError({ code, message: "" });
      assert.equal(presentation.code, code);
      assert.ok(presentation.title.length > 0, `${code} needs a title`);
      assert.ok(presentation.explanation.length > 0, `${code} needs an explanation`);
    }
  });

  test("none of them offers an action, because none of the shell's actions would help", () => {
    for (const code of PRESENTED_BACKEND_CODES) {
      const { action } = describeBackendError({ code, message: "" });
      assert.equal(action, null, `${code} must not offer an action that cannot fix it`);
    }
  });

  test("an unsupported capability is presented as a refusal, never as a failure of the user's", () => {
    const presentation = describeBackendError({ code: "PROVIDER_CAPABILITY_UNSUPPORTED", message: "" });
    assert.match(presentation.explanation, /does not support/);
    assert.match(presentation.explanation, /refused/);
  });

  test("a tool the backend does not supply explains that, rather than blaming the target", () => {
    const presentation = describeBackendError({ code: "PROVIDER_UNAVAILABLE", message: "" });
    assert.match(presentation.explanation, /supplies no provider/);
  });

  test("the controller's own sentence is kept when it says something new", () => {
    const plain = describeBackendError({ code: "PROVIDER_TIMEOUT", message: "" });
    assert.equal(plain.reported, null);

    const detailed = describeBackendError({
      code: "PROVIDER_TIMEOUT",
      message: "The Local Mock backend did not start within 5000 ms.",
      details: "The request was abandoned; a late answer is ignored.",
    });
    assert.ok(detailed.reported !== null);
    assert.equal(detailed.details, "The request was abandoned; a late answer is ignored.");
  });
});
