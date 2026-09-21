import { matchesQuery } from "@/lib/search";
import type { ScriptDocument, ScriptFolder } from "@/types/workspace";

/** Query handling is shared with the other searchable lists; re-exported so callers keep one import. */
export { matchIndex, normalizeQuery } from "@/lib/search";

/**
 * Read-only views of the workspace for navigation: the sorted folder tree, the
 * favorites list, search filtering and move destinations. Pure functions over
 * workspace data; nothing here copies or owns a script document.
 */

export interface FolderNode {
  folder: ScriptFolder;
  /** 0 for a top-level folder. */
  depth: number;
  folders: FolderNode[];
  scripts: ScriptDocument[];
  /** Some script in this folder or below has unsaved changes. */
  hasDirty: boolean;
}

export interface WorkspaceTree {
  /** Top-level folders. */
  folders: FolderNode[];
  /** Scripts at the workspace root. */
  scripts: ScriptDocument[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Alphabetical, numbers compared by value (`Script 2` before `Script 10`), ties broken by id so order is stable. */
export function compareByName(a: { id: string; name: string }, b: { id: string; name: string }): number {
  return collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Builds the navigation tree: folders before scripts, both alphabetical.
 * Entries that point at a missing folder are shown at the root, and folders
 * that cannot be reached from the root (only possible in unnormalized data)
 * are left out rather than recursed into.
 */
export function buildWorkspaceTree(
  scripts: readonly ScriptDocument[],
  folders: readonly ScriptFolder[],
): WorkspaceTree {
  const nodes = new Map<string, FolderNode>();
  for (const folder of folders) {
    nodes.set(folder.id, { folder, depth: 0, folders: [], scripts: [], hasDirty: false });
  }

  const root: WorkspaceTree = { folders: [], scripts: [] };
  for (const node of nodes.values()) {
    const { parentId } = node.folder;
    const parent = parentId === null ? undefined : nodes.get(parentId);
    (parent ? parent.folders : root.folders).push(node);
  }

  for (const script of scripts) {
    const parent = script.folderId === null ? undefined : nodes.get(script.folderId);
    (parent ? parent.scripts : root.scripts).push(script);
  }

  const finish = (node: FolderNode, depth: number): boolean => {
    node.depth = depth;
    node.folders.sort((a, b) => compareByName(a.folder, b.folder));
    node.scripts.sort(compareByName);
    let hasDirty = node.scripts.some((script) => script.isDirty);
    for (const child of node.folders) hasDirty = finish(child, depth + 1) || hasDirty;
    node.hasDirty = hasDirty;
    return hasDirty;
  };

  root.folders.sort((a, b) => compareByName(a.folder, b.folder));
  root.scripts.sort(compareByName);
  for (const node of root.folders) finish(node, 0);

  return root;
}

/**
 * Keeps what matches a normalized, non-empty query. A matching script keeps
 * its folders visible, so the location stays understandable; a matching
 * folder keeps everything inside it.
 */
export function filterWorkspaceTree(tree: WorkspaceTree, needle: string): WorkspaceTree {
  const matches = (name: string) => matchesQuery(name, needle);

  const filterNode = (node: FolderNode): FolderNode | null => {
    if (matches(node.folder.name)) return node;
    const folders = node.folders.map(filterNode).filter((child) => child !== null);
    const scripts = node.scripts.filter((script) => matches(script.name));
    if (folders.length === 0 && scripts.length === 0) return null;
    return { ...node, folders, scripts };
  };

  return {
    folders: tree.folders.map(filterNode).filter((node) => node !== null),
    scripts: tree.scripts.filter((script) => matches(script.name)),
  };
}

export function isTreeEmpty(tree: WorkspaceTree): boolean {
  return tree.folders.length === 0 && tree.scripts.length === 0;
}

/** Favorite scripts, alphabetical. */
export function listFavorites(scripts: readonly ScriptDocument[], needle = ""): ScriptDocument[] {
  return scripts
    .filter((script) => script.isFavorite && (needle === "" || matchesQuery(script.name, needle)))
    .sort(compareByName);
}

export interface FolderDestination {
  folder: ScriptFolder;
  depth: number;
  /** `Weapons / Guns`, for disambiguating folders with the same name. */
  path: string;
}

/** Every folder in tree order (depth first, alphabetical), e.g. for a "Move to…" picker. */
export function listFolderDestinations(tree: WorkspaceTree): FolderDestination[] {
  const result: FolderDestination[] = [];
  const visit = (node: FolderNode, parentPath: string) => {
    const path = parentPath === "" ? node.folder.name : `${parentPath} / ${node.folder.name}`;
    result.push({ folder: node.folder, depth: node.depth, path });
    for (const child of node.folders) visit(child, path);
  };
  for (const node of tree.folders) visit(node, "");
  return result;
}

/** Direct contents of a folder, e.g. to explain what deleting it moves. */
export function countFolderContents(
  scripts: readonly ScriptDocument[],
  folders: readonly ScriptFolder[],
  folderId: string,
): { scripts: number; folders: number } {
  return {
    scripts: scripts.filter((script) => script.folderId === folderId).length,
    folders: folders.filter((folder) => folder.parentId === folderId).length,
  };
}
