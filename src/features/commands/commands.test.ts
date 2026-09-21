import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  filterCommands,
  firstCommandIndex,
  isCommandEnabled,
  nextCommandIndex,
  resolveActiveIndex,
  runCommandAt,
} from "@/features/commands/commands";
import type { Command, CommandCategory } from "@/features/commands/types";

function command(
  id: string,
  title: string,
  category: CommandCategory,
  extra: Partial<Command> = {},
): Command {
  return { id, title, category, run: () => undefined, ...extra };
}

const COMMANDS: readonly Command[] = [
  command("new-script", "New Script", "Workspace", { hint: "Ctrl+T" }),
  command("new-folder", "New Folder", "Workspace"),
  command("focus-editor", "Focus Editor", "View", { keywords: ["monaco", "code"] }),
  command("focus-explorer", "Focus Explorer", "View", { keywords: ["tree", "objects"] }),
  command("toggle-console", "Toggle Console", "Console"),
  command("inject", "Inject", "Target", { disabledReason: "No target has been detected." }),
];

const titles = (commands: readonly Command[]) => commands.map((entry) => entry.title);

describe("command search", () => {
  test("an empty query keeps the declared order, which groups related commands", () => {
    assert.deepEqual(titles(filterCommands(COMMANDS, "")), titles(COMMANDS));
    assert.deepEqual(titles(filterCommands(COMMANDS, "   ")), titles(COMMANDS));
  });

  test("a title match wins over a keyword or category match", () => {
    assert.deepEqual(titles(filterCommands(COMMANDS, "console")), ["Toggle Console"]);
  });

  test("a command whose title starts with the query comes first", () => {
    assert.deepEqual(titles(filterCommands(COMMANDS, "new")), ["New Script", "New Folder"]);
    assert.equal(titles(filterCommands(COMMANDS, "focus"))[0], "Focus Editor");
  });

  test("searching is case- and space-insensitive", () => {
    assert.deepEqual(titles(filterCommands(COMMANDS, "  NEW SCRIPT ")), ["New Script"]);
  });

  test("keywords find a command known under another name", () => {
    assert.deepEqual(titles(filterCommands(COMMANDS, "monaco")), ["Focus Editor"]);
    assert.deepEqual(titles(filterCommands(COMMANDS, "tree")), ["Focus Explorer"]);
  });

  test("a category name finds everything in it", () => {
    assert.deepEqual(titles(filterCommands(COMMANDS, "workspace")), ["New Script", "New Folder"]);
  });

  test("a query nothing answers to finds nothing", () => {
    assert.deepEqual(filterCommands(COMMANDS, "zzz"), []);
  });

  test("a command that cannot run is still found, so the palette can say why", () => {
    const [found] = filterCommands(COMMANDS, "inject");
    assert.equal(found?.id, "inject");
    assert.equal(isCommandEnabled(found as Command), false);
  });
});

describe("command keyboard navigation", () => {
  test("the first highlight lands on a command that can run", () => {
    assert.equal(firstCommandIndex(COMMANDS), 0);
    assert.equal(firstCommandIndex([COMMANDS[5] as Command, ...COMMANDS.slice(0, 1)]), 1);
  });

  test("moving down and up steps one command at a time", () => {
    assert.equal(nextCommandIndex(COMMANDS, 0, 1), 1);
    assert.equal(nextCommandIndex(COMMANDS, 2, -1), 1);
  });

  test("commands that cannot run are stepped over", () => {
    // Index 5 is disabled, so moving down from 4 wraps past it to 0.
    assert.equal(nextCommandIndex(COMMANDS, 4, 1), 0);
    assert.equal(nextCommandIndex(COMMANDS, 0, -1), 4);
  });

  test("moving wraps at both ends", () => {
    const enabled = COMMANDS.slice(0, 3);
    assert.equal(nextCommandIndex(enabled, 2, 1), 0);
    assert.equal(nextCommandIndex(enabled, 0, -1), 2);
  });

  test("an empty list, or one where nothing can run, highlights nothing", () => {
    assert.equal(nextCommandIndex([], 0, 1), -1);
    assert.equal(firstCommandIndex([]), -1);
    assert.equal(firstCommandIndex([COMMANDS[5] as Command]), -1);
  });

  test("a single runnable command stays where it is", () => {
    const one = [COMMANDS[0] as Command];
    assert.equal(nextCommandIndex(one, 0, 1), 0);
    assert.equal(nextCommandIndex(one, 0, -1), 0);
  });

  test("an index that no longer exists is treated as nothing being highlighted", () => {
    assert.equal(nextCommandIndex(COMMANDS, 99, 1), 0);
    assert.equal(nextCommandIndex(COMMANDS, -1, -1), 4);
  });
});

describe("keeping the highlight on a command", () => {
  test("the highlight stays on its command when the list is rebuilt around it", () => {
    const rebuilt = COMMANDS.map((entry) => ({ ...entry }));
    assert.equal(resolveActiveIndex(rebuilt, "toggle-console"), 4);
  });

  test("a highlight that can no longer run falls back to the first that can", () => {
    assert.equal(resolveActiveIndex(COMMANDS, "inject"), 0);
    assert.equal(resolveActiveIndex(COMMANDS, "not-a-command"), 0);
    assert.equal(resolveActiveIndex(COMMANDS, null), 0);
  });

  test("a highlight survives the list being filtered down to it", () => {
    const filtered = filterCommands(COMMANDS, "focus");
    assert.equal(resolveActiveIndex(filtered, "focus-explorer"), 1);
  });

  test("nothing to run means nothing highlighted", () => {
    assert.equal(resolveActiveIndex([], "new-script"), -1);
  });
});

describe("running a command", () => {
  test("running closes the palette first, then calls the command's own handler", () => {
    const order: string[] = [];
    const list = [command("x", "X", "View", { run: () => order.push("run") })];

    const ran = runCommandAt(list, 0, () => order.push("close"));

    assert.equal(ran?.id, "x");
    assert.deepEqual(order, ["close", "run"]);
  });

  test("a command that cannot run does nothing at all — not even closing", () => {
    let closed = false;
    let ran = false;
    const blocked = command("y", "Y", "Target", {
      disabledReason: "The target is busy.",
      run: () => (ran = true),
    });

    const result = runCommandAt([blocked], 0, () => (closed = true));

    assert.equal(result, null);
    assert.equal(ran, false);
    assert.equal(closed, false);
  });

  test("an index that points at nothing runs nothing", () => {
    let closed = false;
    assert.equal(runCommandAt(COMMANDS, -1, () => (closed = true)), null);
    assert.equal(runCommandAt(COMMANDS, 99, () => (closed = true)), null);
    assert.equal(runCommandAt([], 0, () => (closed = true)), null);
    assert.equal(closed, false);
  });

  test("a command with a reason is reported as unavailable rather than left out", () => {
    const blocked = command("y", "Y", "Target", { disabledReason: "The target is busy." });
    assert.equal(isCommandEnabled(blocked), false);
    assert.equal(blocked.disabledReason, "The target is busy.");
    assert.deepEqual(titles(filterCommands([blocked], "y")), ["Y"]);
  });
});
