import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  allExplorerIds,
  buildExplorerModel,
  buildExplorerTree,
  explorerAncestorIds,
  explorerChildren,
  explorerPath,
  filterExplorerTree,
  findExplorerNode,
  firstExplorerId,
  firstExplorerMatchId,
  formatExplorerPath,
  isExplorerTreeEmpty,
  visibleExplorerIds,
} from "@/features/explorer/explorerModel";
import {
  createExplorerScaleData,
  createMockExplorerProvider,
} from "@/features/explorer/providers/MockExplorerProvider";
import type { ExplorerNodeData, ExplorerTree, ExplorerTreeNode } from "@/features/explorer/types";
import { normalizeQuery } from "@/lib/search";

const mock = () => buildExplorerModel(createMockExplorerProvider().read());

/** Compact outline: one line per object, indented by depth. */
function outline(tree: ExplorerTree): string[] {
  const lines: string[] = [];
  const visit = (entry: ExplorerTreeNode, indent: string) => {
    lines.push(`${indent}${entry.node.name}`);
    for (const child of entry.children) visit(child, `${indent}  `);
  };
  for (const root of tree.roots) visit(root, "");
  return lines;
}

const node = (id: string, name: string, parentId: string | null, className = "Folder"): ExplorerNodeData => ({
  id,
  name,
  className,
  parentId,
});

describe("explorer model", () => {
  test("the mock hierarchy resolves with one root, in the order the provider listed it", () => {
    assert.deepEqual(outline(buildExplorerTree(mock())), [
      "Workspace",
      "  Camera",
      "  Baseplate",
      "  SpawnLocation",
      "  Environment",
      "    Folder",
      "    Lighting",
      "  Players",
      "  ReplicatedStorage",
      "    Assets",
      "      Crate",
      "      Ambience",
      "    Modules",
      "      Util",
      "      Config",
    ]);
  });

  test("parent and child links agree in both directions", () => {
    const model = mock();
    const environment = findExplorerNode(model, "environment");
    assert.ok(environment);
    assert.equal(environment.parentId, "workspace");
    assert.deepEqual(
      explorerChildren(model, "environment").map((child) => child.id),
      ["environment-folder", "lighting"],
    );
    for (const childId of environment.childIds) {
      assert.equal(model.nodes.get(childId)?.parentId, "environment");
    }
  });

  test("depth counts from the root", () => {
    const model = mock();
    assert.equal(findExplorerNode(model, "workspace")?.depth, 0);
    assert.equal(findExplorerNode(model, "environment")?.depth, 1);
    assert.equal(findExplorerNode(model, "lighting")?.depth, 2);
    assert.equal(findExplorerNode(model, "modules-util")?.depth, 3);
  });

  test("the model is clean: no issues, and every object is reachable", () => {
    const model = mock();
    assert.deepEqual(model.issues, []);
    assert.equal(model.count, allExplorerIds(buildExplorerTree(model)).length);
  });

  test("an object whose parent was never reported is shown at the root, and the repair is recorded", () => {
    const model = buildExplorerModel([node("a", "A", null), node("orphan", "Orphan", "missing")]);
    assert.deepEqual(outline(buildExplorerTree(model)), ["A", "Orphan"]);
    assert.deepEqual(model.issues, [{ kind: "missing-parent", id: "orphan", parentId: "missing" }]);
  });

  test("an object that is its own parent is reported as the loop it is, and shown at the root", () => {
    const model = buildExplorerModel([node("self", "Self", "self")]);
    assert.deepEqual(model.rootIds, ["self"]);
    assert.deepEqual(model.issues, [{ kind: "parent-cycle", id: "self" }]);
  });

  test("a duplicate id keeps the first object and records the repair", () => {
    const model = buildExplorerModel([node("a", "First", null), node("a", "Second", null)]);
    assert.equal(model.count, 1);
    assert.equal(findExplorerNode(model, "a")?.name, "First");
    assert.deepEqual(model.issues, [{ kind: "duplicate-id", id: "a" }]);
  });

  test("a loop in the parents is broken, and nothing disappears because of it", () => {
    const model = buildExplorerModel([node("a", "A", "b"), node("b", "B", "a"), node("c", "C", "b")]);
    assert.equal(model.count, 3);
    assert.equal(allExplorerIds(buildExplorerTree(model)).length, 3);
    assert.equal(model.issues.filter((issue) => issue.kind === "parent-cycle").length, 1);
  });

  test("a chain that ends in a loop still reaches every object once", () => {
    const model = buildExplorerModel([
      node("a", "A", "b"),
      node("b", "B", "c"),
      node("c", "C", "a"),
      node("leaf", "Leaf", "c"),
    ]);
    const ids = allExplorerIds(buildExplorerTree(model));
    assert.equal(ids.length, 4);
    assert.equal(new Set(ids).size, 4);
  });

  test("an empty model is an empty tree", () => {
    const model = buildExplorerModel([]);
    assert.equal(model.count, 0);
    assert.ok(isExplorerTreeEmpty(buildExplorerTree(model)));
    assert.equal(firstExplorerId(buildExplorerTree(model)), null);
  });
});

describe("explorer paths", () => {
  test("a path runs from the root down to the object", () => {
    const model = mock();
    assert.equal(formatExplorerPath(explorerPath(model, "lighting")), "Workspace / Environment / Lighting");
    assert.equal(formatExplorerPath(explorerPath(model, "modules-util")), "Workspace / ReplicatedStorage / Modules / Util");
  });

  test("the root's path is the root itself", () => {
    const model = mock();
    assert.equal(formatExplorerPath(explorerPath(model, "workspace")), "Workspace");
  });

  test("an object that is not in the model has no path at all", () => {
    const model = mock();
    assert.deepEqual(explorerPath(model, "gone"), []);
    assert.deepEqual(explorerPath(model, null), []);
    assert.equal(formatExplorerPath(explorerPath(model, "gone")), "");
  });

  test("a repaired parent is reflected in the path rather than guessed at", () => {
    const model = buildExplorerModel([node("a", "A", null), node("orphan", "Orphan", "missing")]);
    assert.equal(formatExplorerPath(explorerPath(model, "orphan")), "Orphan");
  });

  test("ancestors are listed nearest first", () => {
    const model = mock();
    assert.deepEqual(explorerAncestorIds(model, "modules-util"), ["modules", "replicated-storage", "workspace"]);
    assert.deepEqual(explorerAncestorIds(model, "workspace"), []);
    assert.deepEqual(explorerAncestorIds(model, "gone"), []);
  });
});

describe("explorer search", () => {
  const tree = () => buildExplorerTree(mock());

  test("a matching object keeps the objects above it", () => {
    assert.deepEqual(outline(filterExplorerTree(tree(), normalizeQuery("  Lighting "))), [
      "Workspace",
      "  Environment",
      "    Lighting",
    ]);
  });

  test("a matching object keeps everything inside it", () => {
    assert.deepEqual(outline(filterExplorerTree(tree(), "modules")), [
      "Workspace",
      "  ReplicatedStorage",
      "    Modules",
      "      Util",
      "      Config",
    ]);
  });

  test("searching is case-insensitive", () => {
    assert.deepEqual(outline(filterExplorerTree(tree(), normalizeQuery("CAMERA"))), ["Workspace", "  Camera"]);
  });

  test("several matches in different branches all keep their own parents", () => {
    assert.deepEqual(outline(filterExplorerTree(tree(), "i")), [
      "Workspace",
      "  SpawnLocation",
      "  Environment",
      "    Folder",
      "    Lighting",
      "  ReplicatedStorage",
      "    Assets",
      "      Crate",
      "      Ambience",
      "    Modules",
      "      Util",
      "      Config",
    ]);
  });

  test("a matching root keeps the whole hierarchy", () => {
    const full = outline(tree());
    assert.deepEqual(outline(filterExplorerTree(tree(), "workspace")), full);
  });

  test("nothing matching leaves an empty tree", () => {
    const result = filterExplorerTree(tree(), "zzz");
    assert.ok(isExplorerTreeEmpty(result));
    assert.deepEqual(outline(result), []);
  });

  test("only the objects that matched are flagged for highlighting", () => {
    const [root] = filterExplorerTree(tree(), "lighting").roots;
    assert.ok(root);
    assert.equal(root.matched, false);
    assert.equal(root.children[0]?.matched, false);
    assert.equal(root.children[0]?.children[0]?.matched, true);
  });

  test("a match keeps its descendants but only flags the ones that match too", () => {
    const [root] = filterExplorerTree(tree(), "assets").roots;
    const assets = root?.children[0]?.children[0];
    assert.equal(assets?.node.name, "Assets");
    assert.equal(assets?.matched, true);
    assert.deepEqual(
      assets?.children.map((child) => [child.node.name, child.matched]),
      [
        ["Crate", false],
        ["Ambience", false],
      ],
    );
  });
});

describe("explorer navigation order", () => {
  test("only the objects inside expanded ones are listed", () => {
    const tree = buildExplorerTree(mock());
    const expanded = new Set(["workspace"]);
    assert.deepEqual(visibleExplorerIds(tree, (id) => expanded.has(id)), [
      "workspace",
      "camera",
      "baseplate",
      "spawn",
      "environment",
      "players",
      "replicated-storage",
    ]);
  });

  test("a fully collapsed tree lists only its roots", () => {
    const tree = buildExplorerTree(mock());
    assert.deepEqual(visibleExplorerIds(tree, () => false), ["workspace"]);
  });

  test("a fully expanded tree lists everything, in display order", () => {
    const tree = buildExplorerTree(mock());
    assert.deepEqual(visibleExplorerIds(tree, () => true), allExplorerIds(tree));
  });

  test("the first object is the first row", () => {
    assert.equal(firstExplorerId(buildExplorerTree(mock())), "workspace");
  });

  test("the first match is the object searched for, not the parent kept for context", () => {
    const tree = buildExplorerTree(mock());
    for (const [query, expected] of [
      ["lighting", "lighting"],
      ["camera", "camera"],
      ["modules", "modules"],
      ["util", "modules-util"],
    ] as const) {
      const filtered = filterExplorerTree(tree, query);
      assert.equal(firstExplorerMatchId(filtered), expected, `"${query}" should find ${expected}`);
      // The first *row* is the ancestor, which is exactly why the two differ.
      assert.equal(firstExplorerId(filtered), "workspace");
    }
  });

  test("a query that only the root answers to finds the root", () => {
    const filtered = filterExplorerTree(buildExplorerTree(mock()), "workspace");
    assert.equal(firstExplorerMatchId(filtered), "workspace");
  });

  test("nothing matched means no match to go to", () => {
    assert.equal(firstExplorerMatchId(filterExplorerTree(buildExplorerTree(mock()), "zzz")), null);
    assert.equal(firstExplorerMatchId(buildExplorerTree(mock())), null);
  });
});

describe("explorer at scale", () => {
  for (const count of [100, 500, 1000]) {
    test(`${count} objects build into one reachable hierarchy and stay searchable`, () => {
      const model = buildExplorerModel(createExplorerScaleData(count));
      assert.equal(model.count, count);
      assert.deepEqual(model.issues, []);

      const tree = buildExplorerTree(model);
      assert.equal(allExplorerIds(tree).length, count);

      // "Object 7" matches itself and nothing else; its parents are kept.
      const filtered = filterExplorerTree(tree, "object 7");
      const names = allExplorerIds(filtered).map((id) => model.nodes.get(id)?.name);
      assert.ok(names.includes("Object 7"));
      assert.ok(names.every((name) => name !== undefined));
      assert.ok(names.length < count);
    });
  }
});
