import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  filterCommands,
  isCommandEnabled,
  nextCommandIndex,
  runCommandAt,
} from "@/features/commands/commands";
import {
  buildDebuggerCommands,
  type DebuggerCommandActions,
  type DebuggerCommandState,
} from "@/features/commands/debuggerCommands";
import {
  buildProfilerCommands,
  type ProfilerCommandActions,
  type ProfilerCommandState,
} from "@/features/commands/profilerCommands";
import { COMMAND_CATEGORIES, type Command } from "@/features/commands/types";

/**
 * Command Palette → Debugger and Command Palette → Profiler. The commands are
 * built from state, so what the palette offers — and the reason it gives when
 * it cannot — is checked here without rendering anything.
 */

function recorder() {
  const ran: string[] = [];
  const action = (name: string) => () => {
    ran.push(name);
  };
  return { ran, action };
}

function debuggerActions(): DebuggerCommandActions & { ran: string[] } {
  const { ran, action } = recorder();
  return {
    ran,
    start: action("start"),
    stop: action("stop"),
    resume: action("resume"),
    pause: action("pause"),
    stepOver: action("stepOver"),
    stepInto: action("stepInto"),
    stepOut: action("stepOut"),
    addBreakpoint: action("addBreakpoint"),
    removeBreakpoint: action("removeBreakpoint"),
    clearBreakpoints: action("clearBreakpoints"),
  };
}

function profilerActions(): ProfilerCommandActions & { ran: string[] } {
  const { ran, action } = recorder();
  return { ran, start: action("start"), stop: action("stop"), clear: action("clear"), refresh: action("refresh") };
}

const debugState = (overrides: Partial<DebuggerCommandState> = {}): DebuggerCommandState => ({
  state: "ready",
  supported: true,
  backendReady: true,
  busy: false,
  pausePending: false,
  supportsPause: true,
  hasScript: true,
  scriptBreakpoints: 0,
  totalBreakpoints: 0,
  ...overrides,
});

const profilerState = (overrides: Partial<ProfilerCommandState> = {}): ProfilerCommandState => ({
  state: "ready",
  supported: true,
  backendReady: true,
  busy: false,
  hasSession: false,
  hasData: false,
  ...overrides,
});

const byId = (commands: readonly Command[], id: string): Command | undefined =>
  commands.find((command) => command.id === id);

describe("the debugger's commands", () => {
  test("every command the brief names is offered", () => {
    const commands = buildDebuggerCommands(debugState(), debuggerActions());
    const titles = commands.map((command) => command.title);

    for (const title of [
      "Debugger: Continue",
      "Debugger: Pause",
      "Debugger: Step Over",
      "Debugger: Step Into",
      "Debugger: Step Out",
      "Debugger: Stop",
      "Debugger: Add Breakpoint",
      "Debugger: Remove Breakpoint",
      "Debugger: Clear Breakpoints",
    ]) {
      assert.ok(titles.includes(title), `missing ${title}`);
    }
    assert.ok(commands.every((command) => COMMAND_CATEGORIES.includes(command.category)));
  });

  test("with no target, everything says why it cannot run", () => {
    const commands = buildDebuggerCommands(debugState({ state: "unavailable" }), debuggerActions());

    assert.match(byId(commands, "debugger-start")?.disabledReason ?? "", /No target/);
    assert.match(byId(commands, "debugger-continue")?.disabledReason ?? "", /No target/);
    assert.ok(byId(commands, "debugger-stop")?.disabledReason);
  });

  test("with no script open a session cannot be started and no line can be marked", () => {
    const commands = buildDebuggerCommands(debugState({ hasScript: false }), debuggerActions());

    assert.match(byId(commands, "debugger-start")?.disabledReason ?? "", /No script is open/);
    assert.match(byId(commands, "debugger-add-breakpoint")?.disabledReason ?? "", /No script is open/);
  });

  test("while paused the steps run and starting is refused", () => {
    const actions = debuggerActions();
    const commands = buildDebuggerCommands(debugState({ state: "paused" }), actions);

    for (const id of ["debugger-continue", "debugger-step-over", "debugger-step-into", "debugger-step-out"]) {
      const command = byId(commands, id);
      assert.equal(command?.disabledReason, undefined, id);
      command?.run();
    }
    assert.deepEqual(actions.ran, ["resume", "stepOver", "stepInto", "stepOut"]);
    assert.match(byId(commands, "debugger-start")?.disabledReason ?? "", /already running/);
    assert.match(byId(commands, "debugger-pause")?.disabledReason ?? "", /No debug session is running/);
  });

  test("while running only Pause and Stop are offered", () => {
    const commands = buildDebuggerCommands(debugState({ state: "running" }), debuggerActions());

    assert.equal(byId(commands, "debugger-pause")?.disabledReason, undefined);
    assert.equal(byId(commands, "debugger-stop")?.disabledReason, undefined);
    assert.match(byId(commands, "debugger-continue")?.disabledReason ?? "", /already running/);
  });

  test("a provider that cannot pause says so instead of offering it", () => {
    const commands = buildDebuggerCommands(debugState({ state: "running", supportsPause: false }), debuggerActions());
    assert.match(byId(commands, "debugger-pause")?.disabledReason ?? "", /cannot pause/);
  });

  test("a pause already asked for is not offered twice", () => {
    const commands = buildDebuggerCommands(
      debugState({ state: "running", pausePending: true }),
      debuggerActions(),
    );
    assert.match(byId(commands, "debugger-pause")?.disabledReason ?? "", /already been requested/);
  });

  test("removing and clearing breakpoints need breakpoints to act on", () => {
    const none = buildDebuggerCommands(debugState(), debuggerActions());
    assert.match(byId(none, "debugger-remove-breakpoint")?.disabledReason ?? "", /no breakpoints/);
    assert.match(byId(none, "debugger-clear-breakpoints")?.disabledReason ?? "", /no breakpoints to clear/);

    const some = buildDebuggerCommands(
      debugState({ scriptBreakpoints: 1, totalBreakpoints: 3 }),
      debuggerActions(),
    );
    assert.equal(byId(some, "debugger-remove-breakpoint")?.disabledReason, undefined);
    assert.equal(byId(some, "debugger-clear-breakpoints")?.disabledReason, undefined);
  });

  test("a busy debugger refuses a second operation", () => {
    const commands = buildDebuggerCommands(debugState({ state: "paused", busy: true }), debuggerActions());
    assert.match(byId(commands, "debugger-continue")?.disabledReason ?? "", /already in progress/);
  });
});

describe("the profiler's commands", () => {
  test("every command the brief names is offered", () => {
    const commands = buildProfilerCommands(profilerState(), profilerActions());
    assert.deepEqual(
      commands.map((command) => command.title),
      ["Profiler: Start", "Profiler: Stop", "Profiler: Clear", "Profiler: Refresh"],
    );
  });

  test("with no target nothing can be recorded", () => {
    const commands = buildProfilerCommands(profilerState({ state: "unavailable" }), profilerActions());
    assert.match(byId(commands, "profiler-start")?.disabledReason ?? "", /No target/);
  });

  test("while recording, Stop is the only one offered", () => {
    const actions = profilerActions();
    const commands = buildProfilerCommands(profilerState({ state: "recording" }), actions);

    assert.equal(byId(commands, "profiler-stop")?.disabledReason, undefined);
    assert.match(byId(commands, "profiler-start")?.disabledReason ?? "", /already running/);
    assert.match(byId(commands, "profiler-clear")?.disabledReason ?? "", /Stop the recording/);

    byId(commands, "profiler-stop")?.run();
    assert.deepEqual(actions.ran, ["stop"]);
  });

  test("clearing and refreshing need something to act on", () => {
    const empty = buildProfilerCommands(profilerState(), profilerActions());
    assert.match(byId(empty, "profiler-clear")?.disabledReason ?? "", /nothing to clear/);
    assert.match(byId(empty, "profiler-refresh")?.disabledReason ?? "", /no recorded session/);

    const recorded = buildProfilerCommands(profilerState({ hasSession: true, hasData: true }), profilerActions());
    assert.equal(byId(recorded, "profiler-clear")?.disabledReason, undefined);
    assert.equal(byId(recorded, "profiler-refresh")?.disabledReason, undefined);
  });
});

describe("the palette's own behaviour with these commands", () => {
  const all = () => [
    ...buildDebuggerCommands(debugState({ state: "paused" }), debuggerActions()),
    ...buildProfilerCommands(profilerState(), profilerActions()),
  ];

  test("typing a tool's name finds its commands", () => {
    assert.ok(filterCommands(all(), "step").length >= 3);
    assert.equal(filterCommands(all(), "profiler").length, 4);
    assert.ok(filterCommands(all(), "breakpoint").length >= 3);
  });

  test("a command that cannot run stays listed but is stepped over", () => {
    const commands = buildProfilerCommands(profilerState(), profilerActions());
    const listed = filterCommands(commands, "profiler");

    assert.equal(listed.length, 4);
    assert.equal(isCommandEnabled(listed[2] as Command), false);
    // Start is the only one that can run, so the arrows keep landing on it.
    assert.equal(nextCommandIndex(listed, -1, 1), 0);
    assert.equal(nextCommandIndex(listed, 0, 1), 0);
  });

  test("running a disabled command does nothing at all", () => {
    const actions = profilerActions();
    const commands = buildProfilerCommands(profilerState(), actions);
    let closed = 0;

    assert.equal(runCommandAt(commands, 3, () => (closed += 1)), null);
    assert.deepEqual(actions.ran, []);
    assert.equal(closed, 0);
  });

  test("running an enabled command closes the palette first, then acts", () => {
    const actions = profilerActions();
    const commands = buildProfilerCommands(profilerState(), actions);
    const order: string[] = [];

    const command = runCommandAt(commands, 0, () => order.push("closed"));
    order.push(...actions.ran);

    assert.equal(command?.id, "profiler-start");
    assert.deepEqual(order, ["closed", "start"]);
  });
});
