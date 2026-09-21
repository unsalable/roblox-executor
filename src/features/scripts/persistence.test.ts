import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  decideUnbackedWrite,
  migrateStoredWorkspace,
  parseWorkspace,
  serializeWorkspace,
} from "@/features/scripts/persistence";
import {
  createFolder,
  createScript,
  emptyWorkspace,
  findFolder,
  findScript,
  toggleFavorite,
  updateScriptContent,
} from "@/features/scripts/workspace";
import { WORKSPACE_SCHEMA_VERSION, type PersistedWorkspaceV1, type WorkspaceState } from "@/types/workspace";

function context() {
  let next = 0;
  return { now: 1000, createId: () => `new-${++next}` };
}

const parse = (value: unknown) => parseWorkspace(JSON.parse(JSON.stringify(value)), context());

const v1Workspace: PersistedWorkspaceV1 = {
  version: 1,
  scripts: [
    { id: "a", name: "Main.lua", language: "lua", content: "print(1)", createdAt: 1, updatedAt: 2 },
    { id: "b", name: "Test.lua", language: "lua", content: "saved", draft: "unsaved", createdAt: 3, updatedAt: 3 },
  ],
  openScriptIds: ["a", "b"],
  activeScriptId: "b",
};

describe("round trip", () => {
  test("serialize and parse restore folders, favorites, drafts, tabs and the active script", () => {
    let state: WorkspaceState = emptyWorkspace;
    const folder = createFolder(state, { id: "f", now: 5, name: "Weapons", parentId: null });
    assert.ok(folder.ok);
    state = folder.state;
    const nested = createFolder(state, { id: "g", now: 6, name: "Guns", parentId: "f" });
    assert.ok(nested.ok);
    state = nested.state;
    state = createScript(state, { id: "a", now: 7, name: "AK.lua", folderId: "g" });
    state = createScript(state, { id: "b", now: 8, name: "Main.lua" });
    state = toggleFavorite(updateScriptContent(state, "a", "draft"), "a");

    const stored = serializeWorkspace(state);
    assert.equal(stored.version, WORKSPACE_SCHEMA_VERSION);
    assert.equal(stored.scripts[0]!.draft, "draft");
    assert.equal("draft" in stored.scripts[1]!, false);

    const result = parse(stored);
    assert.deepEqual(result.issues, []);
    assert.equal(result.discardedData, false);
    assert.equal(result.migratedFrom, null);
    assert.deepEqual(result.state, state);
  });
});

describe("migration", () => {
  test("v1 → v2 keeps every script, draft and tab, at the root and not favorited", () => {
    const result = parse(v1Workspace);

    assert.equal(result.migratedFrom, 1);
    assert.deepEqual(result.issues, []);
    assert.equal(result.discardedData, false);
    assert.deepEqual(result.state.folders, []);
    assert.deepEqual(result.state.openScriptIds, ["a", "b"]);
    assert.equal(result.state.activeScriptId, "b");

    const main = findScript(result.state, "a")!;
    assert.equal(main.content, "print(1)");
    assert.equal(main.folderId, null);
    assert.equal(main.isFavorite, false);
    assert.equal(main.updatedAt, 2);

    const test = findScript(result.state, "b")!;
    assert.equal(test.content, "unsaved");
    assert.equal(test.savedContent, "saved");
    assert.equal(test.isDirty, true);
  });

  test("migration is deterministic and does not mutate its input", () => {
    const input = JSON.parse(JSON.stringify(v1Workspace));
    const snapshot = JSON.stringify(input);
    const first = migrateStoredWorkspace(input);
    const second = migrateStoredWorkspace(input);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(input), snapshot);
    assert.equal(first?.value.version, 2);
    assert.equal(migrateStoredWorkspace({ version: 2 })?.from, null);
  });

  test("malformed v1 entries are repaired or dropped after migration", () => {
    const result = parse({
      version: 1,
      scripts: [
        { id: "a", name: "Main.lua", content: "x" },
        "not a script",
        { id: "a", name: "Clash.lua", content: "y" },
        { name: "NoContent.lua" },
        { content: "nameless" },
      ],
      openScriptIds: ["a", 42, "missing"],
      activeScriptId: "missing",
    });

    assert.equal(result.migratedFrom, 1);
    assert.equal(result.discardedData, true);
    assert.deepEqual(result.state.scripts.map((script) => script.name), ["Main.lua", "Clash.lua", "Recovered 5.lua"]);
    assert.deepEqual(result.state.scripts.map((script) => script.id), ["a", "new-1", "new-2"]);
    assert.deepEqual(result.state.openScriptIds, ["a"]);
    assert.equal(result.state.activeScriptId, "a");
    assert.ok(result.issues.length >= 6, result.issues.join("\n"));
  });

  test("unsupported versions and shapes fall back to an empty workspace", () => {
    for (const value of [null, [], "text", { version: 99, scripts: [] }, { version: "2" }, { version: 0, scripts: [] }, { version: 2 }]) {
      const result = parseWorkspace(value, context());
      assert.equal(result.state.scripts.length, 0, JSON.stringify(value));
      assert.equal(result.discardedData, true);
    }
  });
});

describe("v2 validation", () => {
  test("missing new fields default to root and not favorite", () => {
    const result = parse({
      version: 2,
      scripts: [{ id: "a", name: "Main.lua", content: "x", createdAt: 1, updatedAt: 1 }],
      openScriptIds: ["a"],
      activeScriptId: "a",
    });
    assert.deepEqual(result.issues, []);
    assert.equal(findScript(result.state, "a")!.folderId, null);
    assert.equal(findScript(result.state, "a")!.isFavorite, false);
    assert.deepEqual(result.state.folders, []);
  });

  test("invalid folder data is repaired without losing scripts", () => {
    const result = parse({
      version: 2,
      scripts: [
        { id: "a", name: "A.lua", content: "", folderId: "f1", isFavorite: true },
        { id: "b", name: "B.lua", content: "", folderId: "ghost", isFavorite: "yes" },
        { id: "c", name: "C.lua", content: "", folderId: 7 },
      ],
      folders: [
        { id: "f1", name: "Weapons", parentId: "f2" },
        { id: "f2", name: "Loop", parentId: "f1" },
        { id: "f1", name: "Dup", parentId: null },
        { name: "  ", parentId: "nowhere" },
        42,
      ],
      openScriptIds: [],
      activeScriptId: null,
    });

    const { state } = result;
    assert.equal(result.discardedData, true, "a dropped folder entry triggers a backup");
    assert.equal(state.scripts.length, 3);
    assert.equal(findScript(state, "a")!.folderId, "f1");
    assert.equal(findScript(state, "a")!.isFavorite, true);
    assert.equal(findScript(state, "b")!.folderId, null);
    assert.equal(findScript(state, "b")!.isFavorite, false);
    assert.equal(findScript(state, "c")!.folderId, null);

    assert.deepEqual(state.folders.map((folder) => folder.name), ["Weapons", "Loop", "Dup", "Recovered Folder 4"]);
    assert.equal(findFolder(state, "f1")!.parentId, null, "cycle broken at the oldest folder");
    assert.equal(findFolder(state, "f2")!.parentId, "f1");
    assert.equal(state.folders[2]!.id, "new-1", "duplicate folder id replaced");
    assert.equal(state.folders[3]!.parentId, null);
  });

  test("an unreadable folder list keeps scripts and reports discarded data", () => {
    const result = parse({
      version: 2,
      scripts: [{ id: "a", name: "A.lua", content: "", folderId: "f" }],
      folders: "broken",
      openScriptIds: ["a"],
      activeScriptId: "a",
    });
    assert.equal(result.discardedData, true);
    assert.equal(findScript(result.state, "a")!.folderId, null);
    assert.equal(result.state.activeScriptId, "a");
  });
});

describe("stored data that could not be backed up", () => {
  test("the unattended autosave holds off rather than destroying the only copy", () => {
    assert.equal(decideUnbackedWrite("autosave", false), "hold");
  });

  test("a retried backup that succeeds lets the write through", () => {
    assert.equal(decideUnbackedWrite("autosave", true), "proceed");
    assert.equal(decideUnbackedWrite("flush", true), "proceed");
  });

  test("an explicit save and the closing flush are never silently refused", () => {
    // Holding these would trade a rare recovery failure for losing everything
    // the user did this session, which is the worse loss of the two.
    assert.equal(decideUnbackedWrite("flush", false), "replace");
  });
});

