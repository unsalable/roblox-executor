import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BACKEND_STATES } from "@/features/backend/backendState";
import { filterCommands, isCommandEnabled, nextCommandIndex, runCommandAt } from "@/features/commands/commands";
import {
  buildDebuggerCommands,
  type DebuggerCommandState,
} from "@/features/commands/debuggerCommands";
import {
  buildDeveloperCommands,
  type DeveloperCommandActions,
  type DeveloperCommandState,
} from "@/features/commands/developerCommands";
import { buildProfilerCommands, type ProfilerCommandState } from "@/features/commands/profilerCommands";
import { COMMAND_CATEGORIES, type Command } from "@/features/commands/types";

/**
 * Command Palette → the developer backend. The commands are built from state, so
 * what the palette offers — and the reason it gives when it cannot — is checked
 * here without rendering anything.
 */

function recorder() {
  const ran: string[] = [];
  const action = (name: string) => () => {
    ran.push(name);
  };
  return { ran, action };
}

function developerActions(): DeveloperCommandActions & { ran: string[] } {
  const { ran, action } = recorder();
  return {
    ran,
    showStatus: action("showStatus"),
    restartBackend: action("restartBackend"),
    refreshCapabilities: action("refreshCapabilities"),
  };
}

const developerState = (overrides: Partial<DeveloperCommandState> = {}): DeveloperCommandState => ({
  state: "ready",
  busy: false,
  hasProviders: true,
  ...overrides,
});

const byId = (commands: readonly Command[], id: string): Command | undefined =>
  commands.find((command) => command.id === id);

describe("the developer backend's commands", () => {
  test("every documented backend command is offered, in the Developer category", () => {
    const commands = buildDeveloperCommands(developerState(), developerActions());
    assert.deepEqual(
      commands.map((command) => command.title),
      ["Developer: Show Backend Status", "Developer: Restart Backend", "Developer: Refresh Capabilities"],
    );
    assert.ok(commands.every((command) => command.category === "Developer"));
    assert.ok(COMMAND_CATEGORIES.includes("Developer"), "the category has to exist for the titles to match");
  });

  test("ids are stable kebab-case handles, prefixed with the feature", () => {
    const commands = buildDeveloperCommands(developerState(), developerActions());
    assert.deepEqual(
      commands.map((command) => command.id),
      ["developer-backend-status", "developer-restart-backend", "developer-refresh-capabilities"],
    );
  });

  test("each command runs the controller action, and only its own", () => {
    const actions = developerActions();
    const commands = buildDeveloperCommands(developerState(), actions);

    byId(commands, "developer-backend-status")?.run();
    byId(commands, "developer-restart-backend")?.run();
    byId(commands, "developer-refresh-capabilities")?.run();

    assert.deepEqual(actions.ran, ["showStatus", "restartBackend", "refreshCapabilities"]);
  });

  test("showing the status is always possible, because there is always something to report", () => {
    for (const state of BACKEND_STATES) {
      const commands = buildDeveloperCommands(developerState({ state }), developerActions());
      assert.ok(isCommandEnabled(byId(commands, "developer-backend-status")!), state);
    }
  });

  test("a backend that has never been started can still be restarted, which is how Auto start off is recovered", () => {
    const commands = buildDeveloperCommands(developerState({ state: "created" }), developerActions());
    const restart = byId(commands, "developer-restart-backend");
    assert.ok(
      isCommandEnabled(restart!),
      "with Auto start off the backend rests at created, and this is the only command that can start it",
    );
  });

  test("every resting state can be restarted, so the backend is never a dead end", () => {
    for (const state of ["created", "stopped", "error", "ready"] as const) {
      const commands = buildDeveloperCommands(developerState({ state }), developerActions());
      assert.ok(isCommandEnabled(byId(commands, "developer-restart-backend")!), state);
    }
  });

  test("a backend in the middle of a lifecycle operation cannot be restarted", () => {
    for (const state of ["starting", "stopping"] as const) {
      const commands = buildDeveloperCommands(developerState({ state, busy: true }), developerActions());
      assert.equal(
        byId(commands, "developer-restart-backend")?.disabledReason,
        "The backend is already starting or stopping.",
        state,
      );
    }
  });

  test("a stopped or failed backend can be restarted, which is how it is recovered", () => {
    for (const state of ["ready", "stopped", "error"] as const) {
      const commands = buildDeveloperCommands(developerState({ state }), developerActions());
      assert.ok(isCommandEnabled(byId(commands, "developer-restart-backend")!), state);
    }
  });

  test("a backend with no providers has nothing to refresh, and names that reason", () => {
    const commands = buildDeveloperCommands(developerState({ hasProviders: false }), developerActions());
    assert.equal(
      byId(commands, "developer-refresh-capabilities")?.disabledReason,
      "This backend supplies no providers to ask.",
    );
  });

  test("a disabled command stays in the list so the palette can show the reason", () => {
    const commands = buildDeveloperCommands(developerState({ state: "starting", busy: true }), developerActions());
    assert.equal(commands.length, 3, "nothing is dropped from the list");
    assert.ok(commands.some((command) => command.disabledReason !== undefined));
  });

  test("every reason is a complete sentence", () => {
    const states: Partial<DeveloperCommandState>[] = [
      { state: "starting", busy: true },
      { state: "stopping", busy: true },
      { hasProviders: false },
    ];
    for (const overrides of states) {
      for (const command of buildDeveloperCommands(developerState(overrides), developerActions())) {
        if (command.disabledReason === undefined) continue;
        assert.match(command.disabledReason, /^[A-Z].*\.$/, `${command.id}: ${command.disabledReason}`);
      }
    }
  });

  test("disabledReason is absent rather than undefined when a command can run", () => {
    const commands = buildDeveloperCommands(developerState(), developerActions());
    const status = byId(commands, "developer-backend-status")!;
    assert.ok(!("disabledReason" in status), "an optional property set to undefined is not the same as absent");
  });
});

describe("the palette's own behaviour with these commands", () => {
  test("typing the category finds the whole group", () => {
    const commands = buildDeveloperCommands(developerState(), developerActions());
    assert.equal(filterCommands(commands, "developer").length, 3);
  });

  test("the arrow keys skip a command that cannot run", () => {
    const commands = buildDeveloperCommands(developerState({ state: "starting", busy: true }), developerActions());
    const next = nextCommandIndex(commands, 0, 1);
    assert.notEqual(next, 1, "the disabled restart must be stepped over");
    assert.ok(isCommandEnabled(commands[next]!));
  });

  test("running a disabled command does nothing at all", () => {
    const actions = developerActions();
    const commands = buildDeveloperCommands(developerState({ state: "starting", busy: true }), actions);
    const index = commands.findIndex((command) => command.id === "developer-restart-backend");

    let closed = 0;
    assert.equal(runCommandAt(commands, index, () => (closed += 1)), null);
    assert.deepEqual(actions.ran, []);
    assert.equal(closed, 0, "the palette does not even close for a command it will not run");
  });
});

describe("an unsupported tool is explained by the tool that is missing", () => {
  const debugState = (overrides: Partial<DebuggerCommandState> = {}): DebuggerCommandState => ({
    state: "unavailable",
    supported: false,
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
    state: "unavailable",
    supported: false,
    backendReady: true,
    busy: false,
    hasSession: false,
    hasData: false,
    ...overrides,
  });

  test("a backend with no debugger says that, not that no target was detected", () => {
    const commands = buildDebuggerCommands(debugState(), {
      start: () => undefined,
      stop: () => undefined,
      resume: () => undefined,
      pause: () => undefined,
      stepOver: () => undefined,
      stepInto: () => undefined,
      stepOut: () => undefined,
      addBreakpoint: () => undefined,
      removeBreakpoint: () => undefined,
      clearBreakpoints: () => undefined,
    });
    assert.equal(
      byId(commands, "debugger-start")?.disabledReason,
      "This developer backend provides no debugger.",
      "the missing capability is the honest reason, and it takes priority",
    );
  });

  test("a backend with no profiler says that too", () => {
    const commands = buildProfilerCommands(profilerState(), {
      start: () => undefined,
      stop: () => undefined,
      clear: () => undefined,
      refresh: () => undefined,
    });
    assert.equal(byId(commands, "profiler-start")?.disabledReason, "This developer backend provides no profiler.");
  });

  test("a backend that is not running is named as the cause, not the target", () => {
    const commands = buildDebuggerCommands(debugState({ supported: true, backendReady: false }), {
      start: () => undefined,
      stop: () => undefined,
      resume: () => undefined,
      pause: () => undefined,
      stepOver: () => undefined,
      stepInto: () => undefined,
      stepOut: () => undefined,
      addBreakpoint: () => undefined,
      removeBreakpoint: () => undefined,
      clearBreakpoints: () => undefined,
    });
    assert.equal(byId(commands, "debugger-start")?.disabledReason, "The developer backend is not running.");
  });

  test("the profiler says the same thing about the same backend", () => {
    const commands = buildProfilerCommands(profilerState({ supported: true, backendReady: false }), {
      start: () => undefined,
      stop: () => undefined,
      clear: () => undefined,
      refresh: () => undefined,
    });
    assert.equal(byId(commands, "profiler-start")?.disabledReason, "The developer backend is not running.");
  });

  test("a supported tool with no target still gives the target's reason", () => {
    const commands = buildDebuggerCommands(debugState({ supported: true }), {
      start: () => undefined,
      stop: () => undefined,
      resume: () => undefined,
      pause: () => undefined,
      stepOver: () => undefined,
      stepInto: () => undefined,
      stepOut: () => undefined,
      addBreakpoint: () => undefined,
      removeBreakpoint: () => undefined,
      clearBreakpoints: () => undefined,
    });
    assert.equal(byId(commands, "debugger-start")?.disabledReason, "No target has been detected.");
  });
});
