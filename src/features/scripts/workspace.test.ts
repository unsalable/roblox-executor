import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  closeScript,
  createFolder,
  createScript,
  DEFAULT_SCRIPT_CONTENT,
  deleteFolder,
  deleteScript,
  discardChanges,
  duplicateScript,
  duplicateScriptName,
  emptyWorkspace,
  findFolder,
  findScript,
  MAX_FOLDER_DEPTH,
  moveScript,
  nextFolderName,
  nextScriptName,
  normalizeWorkspace,
  openScript,
  renameFolder,
  renameScript,
  resolveFolderParents,
  saveAllScripts,
  saveScript,
  setActiveScript,
  toggleFavorite,
  updateScriptContent,
  validateFolderName,
  validateScriptName,
  type TransitionResult,
} from "@/features/scripts/workspace";
import type { ScriptDocument, ScriptFolder, WorkspaceState } from "@/types/workspace";

function unwrap(result: TransitionResult): WorkspaceState {
  if (!result.ok) assert.fail(`transition failed: ${result.reason}`);
  return result.state;
}

/** Workspace invariants every transition must keep. */
function assertIntact(state: WorkspaceState): void {
  assert.equal(normalizeWorkspace(state).state, state, "state needed normalization");
  assert.equal(new Set(state.scripts.map((script) => script.id)).size, state.scripts.length, "duplicate script ids");
  assert.equal(new Set(state.folders.map((folder) => folder.id)).size, state.folders.length, "duplicate folder ids");
}

const scriptNames = (state: WorkspaceState) => state.scripts.map((script) => script.name);

function withScripts(...names: string[]): WorkspaceState {
  return names.reduce(
    (state, name, index) => createScript(state, { id: `s${index + 1}`, now: index + 1, name }),
    emptyWorkspace,
  );
}

function addFolder(state: WorkspaceState, id: string, name: string, parentId: string | null = null): WorkspaceState {
  return unwrap(createFolder(state, { id, now: 10, name, parentId }));
}

describe("scripts", () => {
  test("create adds a clean root script, opens and activates it", () => {
    let state = createScript(emptyWorkspace, { id: "a", now: 1 });
    state = createScript(state, { id: "b", now: 2 });
    const script = findScript(state, "a")!;

    assert.deepEqual(scriptNames(state), ["Script.lua", "Script 2.lua"]);
    assert.equal(script.content, DEFAULT_SCRIPT_CONTENT);
    assert.equal(script.isDirty, false);
    assert.equal(script.folderId, null);
    assert.equal(script.isFavorite, false);
    assert.deepEqual(state.openScriptIds, ["a", "b"]);
    assert.equal(state.activeScriptId, "b");
    assertIntact(state);
  });

  test("create rejects duplicate ids and missing folders", () => {
    const state = withScripts("Main.lua");
    assert.throws(() => createScript(state, { id: "s1", now: 5 }));
    assert.throws(() => createScript(state, { id: "x", now: 5, folderId: "missing" }));
  });

  test("create inside a folder", () => {
    let state = addFolder(emptyWorkspace, "f", "Weapons");
    state = createScript(state, { id: "a", now: 1, folderId: "f" });
    assert.equal(findScript(state, "a")!.folderId, "f");
    assertIntact(state);
  });

  test("names skip taken ones case-insensitively and stay deterministic", () => {
    const state = withScripts("script.lua", "Script 3.lua");
    assert.equal(nextScriptName(state.scripts), "Script 2.lua");
    assert.equal(nextScriptName(withScripts("Script.lua", "Script 2.lua").scripts), "Script 3.lua");
  });

  test("rename keeps the id and normalizes the name", () => {
    const state = withScripts("Script.lua", "Other.lua");
    const renamed = unwrap(renameScript(state, "s1", "  Main  ", 9));
    assert.equal(findScript(renamed, "s1")!.name, "Main.lua");
    assert.equal(findScript(renamed, "s1")!.updatedAt, 9);
    assert.equal(renamed.scripts[0]!.id, "s1");
    assert.equal(unwrap(renameScript(state, "s1", "Script.lua", 9)), state);
    assertIntact(renamed);
  });

  test("rename rejects invalid names", () => {
    const state = withScripts("Script.lua", "Other.lua");
    for (const input of ["", "   ", ".lua", " .LUA ", "a/b", "a:b", 'a"b', "name.", "x".repeat(70), "other.LUA"]) {
      assert.equal(renameScript(state, "s1", input, 1).ok, false, `accepted ${JSON.stringify(input)}`);
    }
    assert.equal(renameScript(state, "missing", "Name", 1).ok, false);
    assert.equal(validateScriptName(`bad${String.fromCharCode(7)}name`, []).ok, false);
    assert.deepEqual(validateScriptName("Foo.LUA", []), { ok: true, name: "Foo.lua" });
  });

  test("delete removes the script and its tab, and keeps the others", () => {
    let state = withScripts("A.lua", "B.lua", "C.lua");
    state = setActiveScript(state, "s2");
    const next = deleteScript(state, "s2");

    assert.deepEqual(scriptNames(next), ["A.lua", "C.lua"]);
    assert.deepEqual(next.openScriptIds, ["s1", "s3"]);
    assert.equal(next.activeScriptId, "s3");
    assert.equal(deleteScript(next, "s2"), next);
    assertIntact(next);

    const last = deleteScript(deleteScript(next, "s1"), "s3");
    assert.equal(last.activeScriptId, null);
    assert.deepEqual(last.openScriptIds, []);
  });

  test("duplicate copies the current buffer clean, in the same folder, as the active tab", () => {
    let state = addFolder(emptyWorkspace, "f", "Weapons");
    state = createScript(state, { id: "a", now: 1, name: "AK.lua", folderId: "f" });
    state = updateScriptContent(state, "a", "print('unsaved')");
    state = toggleFavorite(state, "a");
    state = createScript(state, { id: "b", now: 2 });

    const next = duplicateScript(state, "a", { id: "copy", now: 3 });
    const copy = findScript(next, "copy")!;

    assert.equal(copy.name, "AK Copy.lua");
    assert.equal(copy.content, "print('unsaved')");
    assert.equal(copy.savedContent, "print('unsaved')");
    assert.equal(copy.isDirty, false);
    assert.equal(copy.language, "lua");
    assert.equal(copy.folderId, "f");
    assert.equal(copy.isFavorite, false);
    assert.equal(next.activeScriptId, "copy");
    assert.equal(findScript(next, "a")!.isDirty, true, "original keeps its unsaved state");
    assert.equal(duplicateScript(state, "missing", { id: "x", now: 3 }), state);
    assertIntact(next);
  });

  test("duplicate names do not stack suffixes", () => {
    const scripts = withScripts("Main.lua", "Main Copy.lua").scripts;
    assert.equal(duplicateScriptName(withScripts("Main.lua").scripts, "Main.lua"), "Main Copy.lua");
    assert.equal(duplicateScriptName(scripts, "Main.lua"), "Main Copy 2.lua");
    assert.equal(duplicateScriptName(scripts, "Main Copy.lua"), "Main Copy 2.lua");
    assert.equal(duplicateScriptName(withScripts("Main.lua", "Main Copy.lua", "Main Copy 2.lua").scripts, "Main Copy 2.lua"), "Main Copy 3.lua");
    const long = `${"x".repeat(60)}.lua`;
    const copyName = duplicateScriptName(withScripts(long).scripts, long);
    assert.ok(copyName.length <= 64 && copyName.endsWith(" Copy.lua") && validateScriptName(copyName, []).ok, copyName);
  });

  test("open, activate and close tabs without touching scripts", () => {
    const state = withScripts("A.lua", "B.lua", "C.lua");
    let tabs = closeScript(setActiveScript(state, "s2"), "s2");
    assert.deepEqual(tabs.openScriptIds, ["s1", "s3"]);
    assert.equal(tabs.activeScriptId, "s3", "closing the active tab activates its right neighbour");
    tabs = closeScript(tabs, "s3");
    assert.equal(tabs.activeScriptId, "s1", "closing the last tab activates the left one");
    assert.equal(closeScript(tabs, "s3"), tabs);
    assert.equal(tabs.scripts, state.scripts, "closing never deletes");

    tabs = openScript(tabs, "s2");
    assert.deepEqual(tabs.openScriptIds, ["s1", "s2"]);
    assert.equal(tabs.activeScriptId, "s2");
    assert.equal(openScript(tabs, "missing"), tabs);
    assert.equal(setActiveScript(tabs, "s3"), tabs, "closed scripts cannot become active");
    assertIntact(tabs);
  });

  test("move changes only the folder", () => {
    let state = addFolder(addFolder(emptyWorkspace, "f1", "Weapons"), "f2", "Testing");
    state = createScript(state, { id: "a", now: 1, folderId: "f1" });
    state = updateScriptContent(state, "a", "dirty");
    const before = findScript(state, "a")!;

    const moved = unwrap(moveScript(state, "a", "f2", 7));
    const after = findScript(moved, "a")!;
    assert.equal(after.folderId, "f2");
    assert.deepEqual({ ...after, folderId: before.folderId, updatedAt: before.updatedAt }, before);
    assert.equal(moved.openScriptIds, state.openScriptIds);
    assert.equal(moved.activeScriptId, "a");

    assert.equal(findScript(unwrap(moveScript(moved, "a", null, 8)), "a")!.folderId, null);
    assert.equal(unwrap(moveScript(moved, "a", "f2", 9)), moved);
    assert.equal(moveScript(moved, "a", "missing", 9).ok, false);
    assert.equal(moveScript(moved, "missing", null, 9).ok, false);
    assertIntact(moved);
  });

  test("favorite toggles without moving or deleting", () => {
    const state = withScripts("A.lua");
    const favorite = toggleFavorite(state, "s1");
    assert.equal(findScript(favorite, "s1")!.isFavorite, true);
    const cleared = toggleFavorite(favorite, "s1");
    assert.equal(findScript(cleared, "s1")!.isFavorite, false);
    assert.equal(cleared.scripts.length, 1);
    assert.equal(findScript(cleared, "s1")!.folderId, null);
    assert.equal(toggleFavorite(state, "missing"), state);
  });
});

describe("folders", () => {
  test("create validates names per parent", () => {
    let state = addFolder(emptyWorkspace, "f1", "Weapons");
    assert.equal(createFolder(state, { id: "f2", now: 1, name: "weapons", parentId: null }).ok, false);
    assert.equal(createFolder(state, { id: "f2", now: 1, name: "  ", parentId: null }).ok, false);
    assert.equal(createFolder(state, { id: "f2", now: 1, name: "a/b", parentId: null }).ok, false);
    assert.equal(createFolder(state, { id: "f2", now: 1, name: "x", parentId: "missing" }).ok, false);
    assert.throws(() => createFolder(state, { id: "f1", now: 1, name: "Other", parentId: null }));

    state = addFolder(state, "f2", "Weapons", "f1");
    assert.equal(findFolder(state, "f2")!.parentId, "f1", "same name is fine in another parent");
    assert.deepEqual(validateFolderName(" Tools ", state.folders, null), { ok: true, name: "Tools" });
    assertIntact(state);
  });

  test("default folder names are numbered deterministically", () => {
    let state = addFolder(emptyWorkspace, "f1", "New Folder");
    assert.equal(nextFolderName(state.folders, null), "New Folder 2");
    state = addFolder(state, "f2", "New Folder 2");
    assert.equal(nextFolderName(state.folders, null), "New Folder 3");
    assert.equal(nextFolderName(state.folders, "f1"), "New Folder");
  });

  test("nesting is supported up to the depth limit", () => {
    let state = emptyWorkspace;
    let parent: string | null = null;
    for (let depth = 1; depth <= MAX_FOLDER_DEPTH; depth += 1) {
      state = addFolder(state, `f${depth}`, `Level ${depth}`, parent);
      parent = `f${depth}`;
    }
    assert.equal(createFolder(state, { id: "deep", now: 1, name: "Too deep", parentId: parent }).ok, false);
    assertIntact(state);
  });

  test("rename keeps the id and checks siblings only", () => {
    let state = addFolder(addFolder(emptyWorkspace, "f1", "Weapons"), "f2", "Testing");
    state = addFolder(state, "f3", "Guns", "f1");
    const renamed = unwrap(renameFolder(state, "f1", "Arsenal", 4));
    assert.equal(findFolder(renamed, "f1")!.name, "Arsenal");
    assert.equal(findFolder(renamed, "f3")!.parentId, "f1");
    assert.equal(renameFolder(state, "f1", "testing", 4).ok, false);
    assert.equal(unwrap(renameFolder(state, "f3", "Testing", 4)).folders.length, 3, "sibling rule only");
    assert.equal(renameFolder(state, "missing", "X", 4).ok, false);
  });

  test("delete empty folder", () => {
    const state = addFolder(addFolder(emptyWorkspace, "f1", "Weapons"), "f2", "Testing");
    const next = deleteFolder(state, "f1");
    assert.deepEqual(next.folders.map((folder) => folder.id), ["f2"]);
    assert.equal(deleteFolder(next, "f1"), next);
    assertIntact(next);
  });

  test("delete non-empty folder moves its contents to the parent in one step", () => {
    let state = addFolder(emptyWorkspace, "top", "Weapons");
    state = addFolder(state, "mid", "Old", "top");
    state = addFolder(state, "sub", "Guns", "mid");
    state = createScript(state, { id: "a", now: 1, name: "AK.lua", folderId: "mid" });
    state = createScript(state, { id: "b", now: 2, name: "Pistol.lua", folderId: "sub" });
    state = updateScriptContent(state, "a", "unsaved");

    const next = deleteFolder(state, "mid");
    assert.equal(findFolder(next, "mid"), undefined);
    assert.equal(findScript(next, "a")!.folderId, "top");
    assert.equal(findScript(next, "a")!.content, "unsaved");
    assert.equal(findFolder(next, "sub")!.parentId, "top");
    assert.equal(findScript(next, "b")!.folderId, "sub", "nested contents stay inside their subfolder");
    assert.equal(next.scripts.length, 2);
    assert.equal(next.openScriptIds, state.openScriptIds);
    assertIntact(next);

    const rootLevel = deleteFolder(next, "top");
    assert.equal(findScript(rootLevel, "a")!.folderId, null);
    assert.equal(findFolder(rootLevel, "sub")!.parentId, null);
    assertIntact(rootLevel);
  });

  test("delete renames moved subfolders that would clash", () => {
    let state = addFolder(emptyWorkspace, "old", "Old");
    state = addFolder(state, "box", "Box");
    state = addFolder(state, "inner", "old", "box");
    const next = deleteFolder(state, "box");
    assert.equal(findFolder(next, "inner")!.name, "old 2");
    assert.equal(findFolder(next, "inner")!.parentId, null);
    assertIntact(next);
  });
});

describe("dirty state", () => {
  test("modify, save and discard", () => {
    const state = withScripts("Main.lua", "Other.lua");
    const edited = updateScriptContent(state, "s1", "print(1)");
    assert.equal(findScript(edited, "s1")!.isDirty, true);
    assert.equal(findScript(edited, "s2"), findScript(state, "s2"));
    assert.equal(updateScriptContent(edited, "s1", "print(1)"), edited);
    assert.equal(findScript(updateScriptContent(edited, "s1", DEFAULT_SCRIPT_CONTENT), "s1")!.isDirty, false);

    const saved = saveScript(edited, "s1", 50);
    assert.equal(findScript(saved, "s1")!.savedContent, "print(1)");
    assert.equal(findScript(saved, "s1")!.isDirty, false);
    assert.equal(findScript(saved, "s1")!.updatedAt, 50);
    assert.equal(saveScript(saved, "s1", 51), saved);

    const discarded = discardChanges(updateScriptContent(saved, "s1", "print(2)"), "s1");
    assert.equal(findScript(discarded, "s1")!.content, "print(1)");
    assert.equal(findScript(discarded, "s1")!.isDirty, false);
    assert.equal(discardChanges(saved, "s1"), saved, "discarding a clean script changes nothing");
    assertIntact(discarded);
  });

  test("save all saves only dirty scripts", () => {
    let state = withScripts("A.lua", "B.lua", "C.lua");
    state = updateScriptContent(updateScriptContent(state, "s1", "a"), "s3", "c");
    const saved = saveAllScripts(state, 99);
    assert.deepEqual(saved.scripts.map((script) => script.isDirty), [false, false, false]);
    assert.equal(findScript(saved, "s2"), findScript(state, "s2"));
    assert.equal(saveAllScripts(saved, 100), saved);
  });
});

describe("integrity", () => {
  const script = (id: string, folderId: string | null = null): ScriptDocument => ({
    id,
    name: `${id}.lua`,
    language: "lua",
    content: "",
    savedContent: "",
    isDirty: false,
    folderId,
    isFavorite: false,
    createdAt: 1,
    updatedAt: 1,
  });
  const folder = (id: string, parentId: string | null = null): ScriptFolder => ({
    id,
    name: id,
    parentId,
    createdAt: 1,
    updatedAt: 1,
  });

  test("a valid workspace is returned unchanged", () => {
    const state: WorkspaceState = {
      scripts: [script("a", "f")],
      folders: [folder("f")],
      openScriptIds: ["a"],
      activeScriptId: "a",
    };
    const result = normalizeWorkspace(state);
    assert.equal(result.state, state);
    assert.deepEqual(result.issues, []);
  });

  test("missing script references in tabs and the active script are repaired", () => {
    const result = normalizeWorkspace({
      scripts: [script("a"), script("b")],
      folders: [],
      openScriptIds: ["ghost", "b", "a", "b"],
      activeScriptId: "ghost",
    });
    assert.deepEqual(result.state.openScriptIds, ["b", "a"]);
    assert.equal(result.state.activeScriptId, "b");
    assert.equal(result.issues.length, 3);
  });

  test("an active script that is not open is replaced; no tabs means no active script", () => {
    const closed = normalizeWorkspace({ scripts: [script("a")], folders: [], openScriptIds: [], activeScriptId: "a" });
    assert.equal(closed.state.activeScriptId, null);
    const unset = normalizeWorkspace({ scripts: [script("a")], folders: [], openScriptIds: ["a"], activeScriptId: null });
    assert.equal(unset.state.activeScriptId, "a");
  });

  test("missing folder references move entries to the root", () => {
    const result = normalizeWorkspace({
      scripts: [script("a", "gone"), script("b", "f")],
      folders: [folder("f", "gone"), folder("self", "self")],
      openScriptIds: [],
      activeScriptId: null,
    });
    assert.equal(findScript(result.state, "a")!.folderId, null);
    assert.equal(findScript(result.state, "b")!.folderId, "f");
    assert.equal(findFolder(result.state, "f")!.parentId, null);
    assert.equal(findFolder(result.state, "self")!.parentId, null);
    assert.equal(result.issues.length, 3);
  });

  test("folder cycles are broken at the oldest member", () => {
    const folders = [folder("a", "c"), folder("b", "a"), folder("c", "b"), folder("d", "c")];
    const parents = resolveFolderParents(folders);
    assert.deepEqual([...parents], [["a", null], ["b", "a"], ["c", "b"], ["d", "c"]]);

    const result = normalizeWorkspace({ scripts: [], folders, openScriptIds: [], activeScriptId: null });
    assert.equal(findFolder(result.state, "a")!.parentId, null);
    assertIntact(result.state);
    assert.deepEqual(resolveFolderParents([folder("x", "y"), folder("y", "x")]).get("x"), null);
  });
});
