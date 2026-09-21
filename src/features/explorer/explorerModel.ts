import type {
  ExplorerModel,
  ExplorerModelIssue,
  ExplorerNode,
  ExplorerNodeData,
  ExplorerTree,
  ExplorerTreeNode,
} from "@/features/explorer/types";
import { matchesQuery } from "@/lib/search";

/**
 * Pure views of the Explorer hierarchy: building the model from what a provider
 * reported, walking it, filtering it and describing where an object sits.
 *
 * Nothing here holds state or talks to React. The controller owns the model;
 * these functions only read it.
 */

/** Defensive ceiling for a walk up the parents. Cycles are broken while building, so this is unreachable. */
const MAX_DEPTH = 512;

/**
 * Resolves the hierarchy from a flat list.
 *
 * Provider data is never trusted to be well formed: a duplicate id is dropped,
 * a parent that does not exist places its object at the root, and a loop is
 * broken at the object that closed it. Each repair is recorded in `issues`
 * rather than silently swallowed, so the Explorer can report it once. Sibling
 * order is the provider's; the model does not re-sort it.
 */
export function buildExplorerModel(data: readonly ExplorerNodeData[]): ExplorerModel {
  const issues: ExplorerModelIssue[] = [];
  const source = new Map<string, ExplorerNodeData>();

  for (const entry of data) {
    if (source.has(entry.id)) {
      issues.push({ kind: "duplicate-id", id: entry.id });
      continue;
    }
    source.set(entry.id, entry);
  }

  /** Parent after repairs: null means the object is a root. */
  const parentOf = new Map<string, string | null>();
  for (const [id, entry] of source) {
    const { parentId } = entry;
    if (parentId === null) {
      parentOf.set(id, null);
      continue;
    }
    // An object that names itself is the shortest possible loop, not a parent
    // that was never reported; saying so keeps the diagnostic true.
    if (parentId === id) {
      issues.push({ kind: "parent-cycle", id });
      parentOf.set(id, null);
      continue;
    }
    if (!source.has(parentId)) {
      issues.push({ kind: "missing-parent", id, parentId });
      parentOf.set(id, null);
      continue;
    }
    parentOf.set(id, parentId);
  }

  // Break parent loops: walking up from every object must terminate, so a chain
  // that comes back to an object already on the current walk is cut there.
  const settled = new Set<string>();
  for (const id of source.keys()) {
    if (settled.has(id)) continue;

    const walking = new Set<string>();
    let current: string | null = id;
    while (current !== null && !settled.has(current)) {
      if (walking.has(current)) {
        issues.push({ kind: "parent-cycle", id: current });
        parentOf.set(current, null);
        break;
      }
      walking.add(current);
      current = parentOf.get(current) ?? null;
    }
    for (const visited of walking) settled.add(visited);
  }

  const childIds = new Map<string, string[]>();
  const rootIds: string[] = [];
  for (const id of source.keys()) {
    const parentId = parentOf.get(id) ?? null;
    if (parentId === null) {
      rootIds.push(id);
      continue;
    }
    const siblings = childIds.get(parentId);
    if (siblings) siblings.push(id);
    else childIds.set(parentId, [id]);
  }

  const nodes = new Map<string, ExplorerNode>();
  const attach = (id: string, depth: number) => {
    const entry = source.get(id);
    if (!entry) return;
    const children = childIds.get(id) ?? [];
    nodes.set(id, {
      ...entry,
      parentId: parentOf.get(id) ?? null,
      childIds: children,
      depth,
      properties: entry.properties ?? [],
    });
    for (const child of children) attach(child, depth + 1);
  };
  for (const id of rootIds) attach(id, 0);

  return { nodes, rootIds, count: nodes.size, issues };
}

export const EMPTY_EXPLORER_MODEL: ExplorerModel = buildExplorerModel([]);

export function findExplorerNode(model: ExplorerModel, id: string | null): ExplorerNode | null {
  return id === null ? null : (model.nodes.get(id) ?? null);
}

export function explorerChildren(model: ExplorerModel, id: string): readonly ExplorerNode[] {
  const node = model.nodes.get(id);
  if (!node) return [];
  return node.childIds.map((childId) => model.nodes.get(childId)).filter((child) => child !== undefined);
}

export const hasExplorerChildren = (node: ExplorerNode): boolean => node.childIds.length > 0;

/**
 * The objects from the root down to `id`, inclusive — the breadcrumb.
 *
 * An id the model does not hold yields an empty path rather than a partial one,
 * which is how a selection that has gone away is recognised.
 */
export function explorerPath(model: ExplorerModel, id: string | null): readonly ExplorerNode[] {
  const node = findExplorerNode(model, id);
  if (!node) return [];

  const path: ExplorerNode[] = [node];
  let current = node;
  for (let step = 0; step < MAX_DEPTH; step += 1) {
    const parent = findExplorerNode(model, current.parentId);
    if (!parent) break;
    path.push(parent);
    current = parent;
  }
  return path.reverse();
}

/** `Workspace / Environment / Lighting`. Empty for an object the model does not hold. */
export function formatExplorerPath(path: readonly ExplorerNode[]): string {
  return path.map((node) => node.name).join(" / ");
}

/** Every object above `id`, nearest first. Used to reveal a selection. */
export function explorerAncestorIds(model: ExplorerModel, id: string | null): readonly string[] {
  const path = explorerPath(model, id);
  return path.slice(0, -1).map((node) => node.id).reverse();
}

/** The whole hierarchy, ready to render. Rebuilt only when the model changes. */
export function buildExplorerTree(model: ExplorerModel): ExplorerTree {
  const visit = (id: string): ExplorerTreeNode | null => {
    const node = model.nodes.get(id);
    if (!node) return null;
    return {
      node,
      children: node.childIds.map(visit).filter((child) => child !== null),
      matched: false,
    };
  };

  return { roots: model.rootIds.map(visit).filter((node) => node !== null) };
}

/**
 * Keeps what matches a normalized, non-empty query.
 *
 * A matching object keeps the objects above it, so its location stays
 * understandable, and keeps everything inside it, so "what is in here?" is
 * answerable from the result. Matches are flagged for highlighting.
 */
export function filterExplorerTree(tree: ExplorerTree, needle: string): ExplorerTree {
  const keepAll = (entry: ExplorerTreeNode, matched: boolean): ExplorerTreeNode => ({
    node: entry.node,
    children: entry.children.map((child) => keepAll(child, matchesQuery(child.node.name, needle))),
    matched,
  });

  const filter = (entry: ExplorerTreeNode): ExplorerTreeNode | null => {
    if (matchesQuery(entry.node.name, needle)) return keepAll(entry, true);
    const children = entry.children.map(filter).filter((child) => child !== null);
    return children.length === 0 ? null : { node: entry.node, children, matched: false };
  };

  return { roots: tree.roots.map(filter).filter((entry) => entry !== null) };
}

export const isExplorerTreeEmpty = (tree: ExplorerTree): boolean => tree.roots.length === 0;

/** Objects in display order, skipping what sits inside a collapsed one. Drives keyboard navigation. */
export function visibleExplorerIds(tree: ExplorerTree, isExpanded: (id: string) => boolean): readonly string[] {
  const ids: string[] = [];
  const walk = (entry: ExplorerTreeNode) => {
    ids.push(entry.node.id);
    if (!isExpanded(entry.node.id)) return;
    for (const child of entry.children) walk(child);
  };
  for (const entry of tree.roots) walk(entry);
  return ids;
}

/** Every object in the tree, whether or not its parent is expanded. */
export function allExplorerIds(tree: ExplorerTree): readonly string[] {
  const ids: string[] = [];
  const walk = (entry: ExplorerTreeNode) => {
    ids.push(entry.node.id);
    for (const child of entry.children) walk(child);
  };
  for (const entry of tree.roots) walk(entry);
  return ids;
}

/** First object in display order. */
export function firstExplorerId(tree: ExplorerTree): string | null {
  return tree.roots[0]?.node.id ?? null;
}

/**
 * First object in display order that matched the query itself, for Enter in
 * the search field. A filtered tree keeps the objects above a match as
 * context, so its first row is usually not the thing that was searched for.
 */
export function firstExplorerMatchId(tree: ExplorerTree): string | null {
  const walk = (entry: ExplorerTreeNode): string | null => {
    if (entry.matched) return entry.node.id;
    for (const child of entry.children) {
      const found = walk(child);
      if (found !== null) return found;
    }
    return null;
  };

  for (const root of tree.roots) {
    const found = walk(root);
    if (found !== null) return found;
  }
  return null;
}
