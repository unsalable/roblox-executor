import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildWorkspaceTree,
  countFolderContents,
  filterWorkspaceTree,
  listFavorites,
  listFolderDestinations,
  matchIndex,
  normalizeQuery,
  type FolderNode,
  type WorkspaceTree,
} from "@/features/scripts/tree";
import { createFolder, createScript, emptyWorkspace, toggleFavorite, updateScriptContent } from "@/features/scripts/workspace";
import type { ScriptFolder, WorkspaceState } from "@/types/workspace";

function sample(): WorkspaceState {
  let state: WorkspaceState = emptyWorkspace;
  const folder = (id: string, name: string, parentId: string | null = null) => {
    const result = createFolder(state, { id, now: 1, name, parentId });
    assert.ok(result.ok);
    state = result.state;
  };
  folder("testing", "Testing");
  folder("weapons", "Weapons");
  folder("guns", "Guns", "weapons");
  folder("empty", "Archive");
  const script = (id: string, name: string, folderId: string | null = null) => {
    state = createScript(state, { id, now: 2, name, folderId });
  };
  script("main", "Main.lua");
  script("debug", "Debug.lua");
  script("ak", "AK.lua", "guns");
  script("pistol", "Pistol.lua", "weapons");
  script("weapontest", "WeaponTest.lua", "testing");
  script("movement", "Movement.lua", "testing");
  script("s10", "Script 10.lua");
  script("s2", "Script 2.lua");
  return state;
}

/** Compact outline: folders as `Name/`, scripts by name, children indented. */
function outline(tree: WorkspaceTree): string[] {
  const lines: string[] = [];
  const visit = (node: FolderNode, indent: string) => {
    lines.push(`${indent}${node.folder.name}/`);
    for (const child of node.folders) visit(child, `${indent}  `);
    for (const script of node.scripts) lines.push(`${indent}  ${script.name}`);
  };
  for (const node of tree.folders) visit(node, "");
  for (const script of tree.scripts) lines.push(script.name);
  return lines;
}

describe("tree", () => {
  test("folders come before scripts, both in natural alphabetical order", () => {
    const { scripts, folders } = sample();
    assert.deepEqual(outline(buildWorkspaceTree(scripts, folders)), [
      "Archive/",
      "Testing/",
      "  Movement.lua",
      "  WeaponTest.lua",
      "Weapons/",
      "  Guns/",
      "    AK.lua",
      "  Pistol.lua",
      "Debug.lua",
      "Main.lua",
      "Script 2.lua",
      "Script 10.lua",
    ]);
  });

  test("order is stable regardless of input order", () => {
    const { scripts, folders } = sample();
    const reversed = buildWorkspaceTree([...scripts].reverse(), [...folders].reverse());
    assert.deepEqual(outline(reversed), outline(buildWorkspaceTree(scripts, folders)));
  });

  test("depth and unsaved markers propagate up", () => {
    const state = updateScriptContent(sample(), "ak", "dirty");
    const tree = buildWorkspaceTree(state.scripts, state.folders);
    const weapons = tree.folders.find((node) => node.folder.id === "weapons")!;
    assert.equal(weapons.depth, 0);
    assert.equal(weapons.folders[0]!.depth, 1);
    assert.equal(weapons.hasDirty, true);
    assert.equal(weapons.folders[0]!.hasDirty, true);
    assert.equal(tree.folders.find((node) => node.folder.id === "testing")!.hasDirty, false);
  });

  test("broken references never loop, and orphaned scripts show at the root", () => {
    const folders: ScriptFolder[] = [
      { id: "a", name: "A", parentId: "b", createdAt: 1, updatedAt: 1 },
      { id: "b", name: "B", parentId: "a", createdAt: 1, updatedAt: 1 },
    ];
    const { scripts } = createScript(emptyWorkspace, { id: "x", now: 1, name: "X.lua", folderId: null });
    const orphan = { ...scripts[0]!, folderId: "missing" };
    const tree = buildWorkspaceTree([orphan], folders);
    assert.deepEqual(outline(tree), ["X.lua"]);
  });
});

describe("search", () => {
  const tree = () => {
    const { scripts, folders } = sample();
    return buildWorkspaceTree(scripts, folders);
  };

  test("matching scripts keep their folders; other entries are hidden", () => {
    assert.deepEqual(outline(filterWorkspaceTree(tree(), normalizeQuery("  AK "))), ["Weapons/", "  Guns/", "    AK.lua"]);
  });

  test("a matching folder shows everything inside it", () => {
    assert.deepEqual(outline(filterWorkspaceTree(tree(), "weapon")), [
      "Testing/",
      "  WeaponTest.lua",
      "Weapons/",
      "  Guns/",
      "    AK.lua",
      "  Pistol.lua",
    ]);
  });

  test("is case-insensitive and can find nothing", () => {
    assert.deepEqual(outline(filterWorkspaceTree(tree(), normalizeQuery("MAIN"))), ["Main.lua"]);
    const none = filterWorkspaceTree(tree(), "zzz");
    assert.deepEqual(outline(none), []);
  });

  test("highlight position", () => {
    assert.equal(matchIndex("WeaponTest.lua", "test"), 6);
    assert.equal(matchIndex("Main.lua", ""), -1);
  });
});

describe("favorites and destinations", () => {
  test("favorites are alphabetical and filterable", () => {
    let state = sample();
    for (const id of ["pistol", "main", "ak"]) state = toggleFavorite(state, id);
    assert.deepEqual(listFavorites(state.scripts).map((script) => script.name), ["AK.lua", "Main.lua", "Pistol.lua"]);
    assert.deepEqual(listFavorites(state.scripts, "pis").map((script) => script.name), ["Pistol.lua"]);
  });

  test("destinations list every folder in tree order with its path", () => {
    const { scripts, folders } = sample();
    const destinations = listFolderDestinations(buildWorkspaceTree(scripts, folders));
    assert.deepEqual(
      destinations.map((entry) => [entry.path, entry.depth]),
      [
        ["Archive", 0],
        ["Testing", 0],
        ["Weapons", 0],
        ["Weapons / Guns", 1],
      ],
    );
  });

  test("folder contents count direct children only", () => {
    const { scripts, folders } = sample();
    assert.deepEqual(countFolderContents(scripts, folders, "weapons"), { scripts: 1, folders: 1 });
    assert.deepEqual(countFolderContents(scripts, folders, "empty"), { scripts: 0, folders: 0 });
  });
});
