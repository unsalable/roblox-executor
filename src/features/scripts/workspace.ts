import { createId } from "@/lib/id";
import type { ScriptDocument, ScriptFolder, WorkspaceState } from "@/types/workspace";

/**
 * Pure workspace transitions. Every function takes a state and returns the
 * next one — the same object when nothing changed — so they can be tested
 * without React, storage or Monaco. Each transition keeps the invariants that
 * `normalizeWorkspace` restores for data loaded from storage.
 */

export const SCRIPT_EXTENSION = ".lua";
export const DEFAULT_SCRIPT_CONTENT = "-- New Nova script\n\n";
export const DEFAULT_SCRIPT_STEM = "Script";
export const DEFAULT_FOLDER_NAME = "New Folder";
export const MAX_NAME_LENGTH = 64;
/** Folders nest at most this deep (a top-level folder is depth 1), which keeps the sidebar narrow. */
export const MAX_FOLDER_DEPTH = 4;

const RESERVED_NAME_CHARACTERS = /[<>:"/\\|?*]/;
const COPY_SUFFIX = / copy(?: \d+)?$/i;

export const emptyWorkspace: WorkspaceState = {
  scripts: [],
  folders: [],
  openScriptIds: [],
  activeScriptId: null,
};

/** Stable identity for a new script or folder. */
export function createWorkspaceId(): string {
  return createId();
}

export function findScript(state: WorkspaceState, id: string): ScriptDocument | undefined {
  return state.scripts.find((script) => script.id === id);
}

export function findFolder(state: WorkspaceState, id: string): ScriptFolder | undefined {
  return state.folders.find((folder) => folder.id === id);
}

export type TransitionResult = { ok: true; state: WorkspaceState } | { ok: false; reason: string };
export type NameValidation = { ok: true; name: string } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Names

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const hasControlCharacter = (value: string) => [...value].some((character) => character.charCodeAt(0) < 32);

/** Rules shared by script and folder names. Returns the problem, or null when `base` is acceptable. */
function checkBaseName(base: string, maxLength: number): string | null {
  if (base === "") return "Name cannot be empty.";
  if (RESERVED_NAME_CHARACTERS.test(base) || hasControlCharacter(base)) {
    return 'Name cannot contain < > : " / \\ | ? * or control characters.';
  }
  if (base.endsWith(".")) return "Name cannot end with a period.";
  if (base.length > maxLength) return `Name must be ${MAX_NAME_LENGTH} characters or fewer.`;
  return null;
}

/**
 * `root`, `root 2`, `root 3`, … (or `root Copy`, `root Copy 2`, … with a
 * label), shortened so the result never exceeds `maxLength`.
 */
function numberedName(root: string, label: string, index: number, maxLength: number): string {
  const tail = `${label}${index === 1 ? "" : ` ${index}`}`;
  const trimmedRoot = root.slice(0, Math.max(0, maxLength - tail.length)).replace(/[.\s]+$/, "");
  return `${trimmedRoot}${tail}`.trim();
}

const scriptBaseMaxLength = MAX_NAME_LENGTH - SCRIPT_EXTENSION.length;

function scriptNameTaken(scripts: readonly ScriptDocument[], name: string, ignoreId: string | null = null) {
  return scripts.find((script) => script.id !== ignoreId && sameName(script.name, name));
}

/** `Script.lua`, `Script 2.lua`, `Script 3.lua`, … — the first name not used anywhere in the workspace. */
export function nextScriptName(scripts: readonly ScriptDocument[], stem = DEFAULT_SCRIPT_STEM): string {
  for (let index = 1; ; index += 1) {
    const name = `${numberedName(stem, "", index, scriptBaseMaxLength)}${SCRIPT_EXTENSION}`;
    if (!scriptNameTaken(scripts, name)) return name;
  }
}

/**
 * Name for a copy of `name`: `Main.lua` → `Main Copy.lua` → `Main Copy 2.lua`.
 * An existing `Copy`/`Copy N` suffix is not stacked, so copying `Main Copy.lua`
 * gives `Main Copy 2.lua` rather than `Main Copy Copy.lua`.
 */
export function duplicateScriptName(scripts: readonly ScriptDocument[], name: string): string {
  const base = name.toLowerCase().endsWith(SCRIPT_EXTENSION) ? name.slice(0, -SCRIPT_EXTENSION.length) : name;
  const root = base.replace(COPY_SUFFIX, "") || base;
  for (let index = 1; ; index += 1) {
    const candidate = `${numberedName(root, " Copy", index, scriptBaseMaxLength)}${SCRIPT_EXTENSION}`;
    if (!scriptNameTaken(scripts, candidate)) return candidate;
  }
}

/** `New Folder`, `New Folder 2`, … — the first name not used by another folder in the same parent. */
export function nextFolderName(
  folders: readonly ScriptFolder[],
  parentId: string | null,
  root = DEFAULT_FOLDER_NAME,
): string {
  for (let index = 1; ; index += 1) {
    const name = numberedName(root, "", index, MAX_NAME_LENGTH);
    if (!folders.some((folder) => folder.parentId === parentId && sameName(folder.name, name))) return name;
  }
}

/**
 * Normalizes user input into a script name: trims it, guarantees a single
 * `.lua` extension, and rejects empty, oversized, duplicate or obviously
 * invalid names. `ignoreId` excludes the script being renamed from the
 * duplicate check.
 */
export function validateScriptName(
  input: string,
  scripts: readonly ScriptDocument[],
  ignoreId: string | null = null,
): NameValidation {
  let base = input.trim();
  if (base.toLowerCase().endsWith(SCRIPT_EXTENSION)) {
    base = base.slice(0, -SCRIPT_EXTENSION.length).trimEnd();
  }

  const problem = checkBaseName(base, scriptBaseMaxLength);
  if (problem) return { ok: false, reason: problem };

  const name = `${base}${SCRIPT_EXTENSION}`;
  const clash = scriptNameTaken(scripts, name, ignoreId);
  if (clash) return { ok: false, reason: `A script named "${clash.name}" already exists.` };

  return { ok: true, name };
}

/** Folder names follow the script rules without the extension, and only need to be unique within their parent. */
export function validateFolderName(
  input: string,
  folders: readonly ScriptFolder[],
  parentId: string | null,
  ignoreId: string | null = null,
): NameValidation {
  const name = input.trim();
  const problem = checkBaseName(name, MAX_NAME_LENGTH);
  if (problem) return { ok: false, reason: problem };

  const clash = folders.find(
    (folder) => folder.id !== ignoreId && folder.parentId === parentId && sameName(folder.name, name),
  );
  if (clash) return { ok: false, reason: `A folder named "${clash.name}" already exists here.` };

  return { ok: true, name };
}

// ---------------------------------------------------------------------------
// Folder hierarchy helpers

/** Depth of a folder: 1 for a top-level folder, 0 for the root (`null`). Stops safely on a broken chain. */
export function folderDepth(folders: readonly ScriptFolder[], folderId: string | null): number {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  let depth = 0;
  let current = folderId === null ? undefined : byId.get(folderId);
  while (current && depth <= folders.length) {
    depth += 1;
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return depth;
}

/** Ids of `folderId` and every folder above it. */
export function folderAncestorIds(folders: readonly ScriptFolder[], folderId: string | null): Set<string> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const ids = new Set<string>();
  let current = folderId === null ? undefined : byId.get(folderId);
  while (current && !ids.has(current.id)) {
    ids.add(current.id);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return ids;
}

/**
 * Effective parent of every folder: parents that do not exist, point at the
 * folder itself or close a cycle become `null`. Cycles are broken
 * deterministically at the member that was created first.
 */
export function resolveFolderParents(folders: readonly ScriptFolder[]): Map<string, string | null> {
  const index = new Map(folders.map((folder, position) => [folder.id, position]));
  const parents = new Map<string, string | null>();

  for (const folder of folders) {
    const { parentId } = folder;
    parents.set(folder.id, parentId !== null && parentId !== folder.id && index.has(parentId) ? parentId : null);
  }

  for (const folder of folders) {
    const path: string[] = [];
    let current: string | null = folder.id;
    while (current !== null) {
      const seenAt = path.indexOf(current);
      if (seenAt !== -1) {
        const cycle = path.slice(seenAt);
        const oldest = cycle.reduce((a, b) => (index.get(a)! <= index.get(b)! ? a : b));
        parents.set(oldest, null);
        break;
      }
      path.push(current);
      current = parents.get(current) ?? null;
    }
  }

  return parents;
}

// ---------------------------------------------------------------------------
// Internal helpers

function updateScript(
  state: WorkspaceState,
  id: string,
  update: (script: ScriptDocument) => ScriptDocument,
): WorkspaceState {
  const index = state.scripts.findIndex((script) => script.id === id);
  if (index === -1) return state;

  const current = state.scripts[index]!;
  const next = update(current);
  if (next === current) return state;

  const scripts = state.scripts.slice();
  scripts[index] = next;
  return { ...state, scripts };
}

function updateFolder(
  state: WorkspaceState,
  id: string,
  update: (folder: ScriptFolder) => ScriptFolder,
): WorkspaceState {
  const index = state.folders.findIndex((folder) => folder.id === id);
  if (index === -1) return state;

  const current = state.folders[index]!;
  const next = update(current);
  if (next === current) return state;

  const folders = state.folders.slice();
  folders[index] = next;
  return { ...state, folders };
}

/**
 * Removes `id` from the tab list. When it was the active tab, the tab that
 * slides into its place becomes active (the right neighbour, or the left one
 * when it was last).
 */
function withoutTab(state: WorkspaceState, id: string): Pick<WorkspaceState, "openScriptIds" | "activeScriptId"> {
  const index = state.openScriptIds.indexOf(id);
  if (index === -1) return { openScriptIds: state.openScriptIds, activeScriptId: state.activeScriptId };

  const openScriptIds = state.openScriptIds.filter((openId) => openId !== id);
  const activeScriptId =
    state.activeScriptId === id
      ? (openScriptIds[Math.min(index, openScriptIds.length - 1)] ?? null)
      : state.activeScriptId;

  return { openScriptIds, activeScriptId };
}

// ---------------------------------------------------------------------------
// Scripts

export interface NewScriptOptions {
  id: string;
  now: number;
  name?: string;
  content?: string;
  /** Containing folder; the workspace root when omitted. */
  folderId?: string | null;
}

/** Adds a saved script, opens it as the last tab and makes it active. */
export function createScript(state: WorkspaceState, options: NewScriptOptions): WorkspaceState {
  const { id, now, content = DEFAULT_SCRIPT_CONTENT, folderId = null } = options;
  if (findScript(state, id)) throw new Error(`A script with id ${id} already exists`);
  if (folderId !== null && !findFolder(state, folderId)) throw new Error(`Folder ${folderId} does not exist`);

  const script: ScriptDocument = {
    id,
    name: options.name ?? nextScriptName(state.scripts),
    language: "lua",
    content,
    savedContent: content,
    isDirty: false,
    folderId,
    isFavorite: false,
    createdAt: now,
    updatedAt: now,
  };

  return {
    ...state,
    scripts: [...state.scripts, script],
    openScriptIds: [...state.openScriptIds, id],
    activeScriptId: id,
  };
}

/**
 * Copies a script under a new id and name into the same folder, then opens the
 * copy as the active tab. The copy takes the current buffer, including unsaved
 * edits, as its saved content, so it starts clean. The favorite flag is not copied.
 */
export function duplicateScript(
  state: WorkspaceState,
  sourceId: string,
  options: { id: string; now: number },
): WorkspaceState {
  const source = findScript(state, sourceId);
  if (!source) return state;

  return createScript(state, {
    id: options.id,
    now: options.now,
    name: duplicateScriptName(state.scripts, source.name),
    content: source.content,
    folderId: source.folderId,
  });
}

/** Opens a saved script (appending a tab when needed) and makes it active. */
export function openScript(state: WorkspaceState, id: string): WorkspaceState {
  if (!findScript(state, id)) return state;
  if (state.openScriptIds.includes(id)) return setActiveScript(state, id);
  return { ...state, openScriptIds: [...state.openScriptIds, id], activeScriptId: id };
}

/** Switches to an already open tab. Unknown or closed ids are ignored. */
export function setActiveScript(state: WorkspaceState, id: string): WorkspaceState {
  if (state.activeScriptId === id || !state.openScriptIds.includes(id)) return state;
  return { ...state, activeScriptId: id };
}

/** Closes a tab. The script, including any unsaved buffer, stays in the workspace. */
export function closeScript(state: WorkspaceState, id: string): WorkspaceState {
  const tabs = withoutTab(state, id);
  if (tabs.openScriptIds === state.openScriptIds) return state;
  return { ...state, ...tabs };
}

/** Removes a script from the workspace and from the tab list. */
export function deleteScript(state: WorkspaceState, id: string): WorkspaceState {
  if (!findScript(state, id)) return state;
  return {
    ...state,
    scripts: state.scripts.filter((script) => script.id !== id),
    ...withoutTab(state, id),
  };
}

export function updateScriptContent(state: WorkspaceState, id: string, content: string): WorkspaceState {
  return updateScript(state, id, (script) =>
    script.content === content
      ? script
      : { ...script, content, isDirty: content !== script.savedContent },
  );
}

/** Marks the current buffer as saved. Clean scripts are returned unchanged. */
export function saveScript(state: WorkspaceState, id: string, now: number): WorkspaceState {
  return updateScript(state, id, (script) =>
    script.isDirty ? { ...script, savedContent: script.content, isDirty: false, updatedAt: now } : script,
  );
}

/** Saves every script with unsaved changes. */
export function saveAllScripts(state: WorkspaceState, now: number): WorkspaceState {
  return state.scripts.reduce((next, script) => saveScript(next, script.id, now), state);
}

/** Restores the last saved content, dropping unsaved edits. Clean scripts are returned unchanged. */
export function discardChanges(state: WorkspaceState, id: string): WorkspaceState {
  return updateScript(state, id, (script) =>
    script.isDirty ? { ...script, content: script.savedContent, isDirty: false } : script,
  );
}

export function renameScript(state: WorkspaceState, id: string, input: string, now: number): TransitionResult {
  const script = findScript(state, id);
  if (!script) return { ok: false, reason: "The script no longer exists." };

  const validation = validateScriptName(input, state.scripts, id);
  if (!validation.ok) return validation;

  const { name } = validation;
  if (name === script.name) return { ok: true, state };

  return { ok: true, state: updateScript(state, id, (current) => ({ ...current, name, updatedAt: now })) };
}

/** Moves a script to a folder (or the root with `null`). Its id, content, dirty state and tab are untouched. */
export function moveScript(
  state: WorkspaceState,
  id: string,
  folderId: string | null,
  now: number,
): TransitionResult {
  const script = findScript(state, id);
  if (!script) return { ok: false, reason: "The script no longer exists." };
  if (folderId !== null && !findFolder(state, folderId)) {
    return { ok: false, reason: "The destination folder no longer exists." };
  }
  if (script.folderId === folderId) return { ok: true, state };

  return { ok: true, state: updateScript(state, id, (current) => ({ ...current, folderId, updatedAt: now })) };
}

export function toggleFavorite(state: WorkspaceState, id: string): WorkspaceState {
  return updateScript(state, id, (script) => ({ ...script, isFavorite: !script.isFavorite }));
}

// ---------------------------------------------------------------------------
// Folders

export interface NewFolderOptions {
  id: string;
  now: number;
  name: string;
  parentId: string | null;
}

export function createFolder(state: WorkspaceState, options: NewFolderOptions): TransitionResult {
  const { id, now, parentId } = options;
  if (findFolder(state, id)) throw new Error(`A folder with id ${id} already exists`);
  if (parentId !== null && !findFolder(state, parentId)) {
    return { ok: false, reason: "The parent folder no longer exists." };
  }
  if (folderDepth(state.folders, parentId) >= MAX_FOLDER_DEPTH) {
    return { ok: false, reason: `Folders can be nested at most ${MAX_FOLDER_DEPTH} levels deep.` };
  }

  const validation = validateFolderName(options.name, state.folders, parentId);
  if (!validation.ok) return validation;

  const folder: ScriptFolder = { id, name: validation.name, parentId, createdAt: now, updatedAt: now };
  return { ok: true, state: { ...state, folders: [...state.folders, folder] } };
}

export function renameFolder(state: WorkspaceState, id: string, input: string, now: number): TransitionResult {
  const folder = findFolder(state, id);
  if (!folder) return { ok: false, reason: "The folder no longer exists." };

  const validation = validateFolderName(input, state.folders, folder.parentId, id);
  if (!validation.ok) return validation;

  const { name } = validation;
  if (name === folder.name) return { ok: true, state };

  return { ok: true, state: updateFolder(state, id, (current) => ({ ...current, name, updatedAt: now })) };
}

/**
 * Deletes a folder without deleting anything inside it: its scripts and
 * subfolders move up to the folder's own parent (the workspace root for a
 * top-level folder), in one step. A moved subfolder whose name clashes with a
 * folder already in that parent gets a numbered name (`Old` → `Old 2`).
 */
export function deleteFolder(state: WorkspaceState, id: string): WorkspaceState {
  const folder = findFolder(state, id);
  if (!folder) return state;

  const destination = folder.parentId;
  const siblings = state.folders.filter((candidate) => candidate.parentId === destination && candidate.id !== id);

  const folders = state.folders.flatMap((candidate) => {
    if (candidate.id === id) return [];
    if (candidate.parentId !== id) return [candidate];

    const clash = siblings.some((sibling) => sameName(sibling.name, candidate.name));
    const moved: ScriptFolder = {
      ...candidate,
      parentId: destination,
      name: clash ? nextFolderName(siblings, destination, candidate.name) : candidate.name,
    };
    siblings.push(moved);
    return [moved];
  });

  const scripts = state.scripts.map((script) =>
    script.folderId === id ? { ...script, folderId: destination } : script,
  );

  return { ...state, scripts, folders };
}

// ---------------------------------------------------------------------------
// Integrity

export interface NormalizeResult {
  state: WorkspaceState;
  /** Every repair, phrased for the log. */
  issues: string[];
}

/**
 * Restores the workspace invariants on data that did not come from the
 * transitions above (stored or migrated workspaces): folder parents exist and
 * never form a cycle, scripts live in existing folders, tabs reference
 * existing scripts at most once, and the active script is an open tab.
 * Returns the same state object when nothing needed repair.
 */
export function normalizeWorkspace(state: WorkspaceState): NormalizeResult {
  const issues: string[] = [];

  const parents = resolveFolderParents(state.folders);
  let foldersChanged = false;
  const folders = state.folders.map((folder) => {
    const parentId = parents.get(folder.id) ?? null;
    if (parentId === folder.parentId) return folder;
    foldersChanged = true;
    const exists = state.folders.some((candidate) => candidate.id === folder.parentId);
    issues.push(
      exists
        ? `folder "${folder.name}" was part of a folder cycle and was moved to the root`
        : `folder "${folder.name}" had a missing parent and was moved to the root`,
    );
    return { ...folder, parentId };
  });

  const folderIds = new Set(folders.map((folder) => folder.id));
  let scriptsChanged = false;
  const scripts = state.scripts.map((script) => {
    if (script.folderId === null || folderIds.has(script.folderId)) return script;
    scriptsChanged = true;
    issues.push(`"${script.name}" was in a missing folder and was moved to the root`);
    return { ...script, folderId: null };
  });

  const scriptIds = new Set(scripts.map((script) => script.id));
  const openScriptIds: string[] = [];
  for (const id of state.openScriptIds) {
    if (scriptIds.has(id) && !openScriptIds.includes(id)) openScriptIds.push(id);
    else issues.push(`removed invalid open tab reference ${JSON.stringify(id)}`);
  }
  const tabsChanged = openScriptIds.length !== state.openScriptIds.length;

  let activeScriptId = state.activeScriptId;
  if (activeScriptId === null || !openScriptIds.includes(activeScriptId)) {
    if (activeScriptId !== null) {
      issues.push(`active script ${JSON.stringify(activeScriptId)} is not open; selected another tab`);
    }
    activeScriptId = openScriptIds[0] ?? null;
  }

  if (!foldersChanged && !scriptsChanged && !tabsChanged && activeScriptId === state.activeScriptId) {
    return { state, issues };
  }

  return {
    state: {
      scripts: scriptsChanged ? scripts : state.scripts,
      folders: foldersChanged ? folders : state.folders,
      openScriptIds: tabsChanged ? openScriptIds : state.openScriptIds,
      activeScriptId,
    },
    issues,
  };
}
