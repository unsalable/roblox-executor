/** Languages the workspace can hold. Lua is the only one in this phase. */
export type ScriptLanguage = "lua";

/**
 * One script as the workspace knows it. The workspace is the source of truth
 * for script documents; the editor mirrors `content` but never owns it.
 */
export interface ScriptDocument {
  /** Stable identity. Never derived from the display name. */
  id: string;
  /**
   * Display name, always ending in `.lua`. Unique across the whole workspace
   * (case-insensitively), because tabs, favorites and the title bar show the
   * bare name without its folder.
   */
  name: string;
  language: ScriptLanguage;
  /** Current buffer, including edits that have not been saved yet. */
  content: string;
  /** Content as of the last explicit save. */
  savedContent: string;
  /** `content !== savedContent`, kept on the document so readers never compare buffers. */
  isDirty: boolean;
  /** Containing folder, or null for the workspace root. Always an existing folder. */
  folderId: string | null;
  /** Listed in the Favorites section as well as in its folder. */
  isFavorite: boolean;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds of the last save, rename or move. */
  updatedAt: number;
}

/**
 * A folder in Nova's internal workspace hierarchy. Folders only organize
 * scripts inside the workspace; nothing is created on the user's filesystem.
 */
export interface ScriptFolder {
  /** Stable identity. Never derived from the display name. */
  id: string;
  /** Unique among the folders that share `parentId` (case-insensitively). */
  name: string;
  /** Parent folder, or null for a top-level folder. Never forms a cycle. */
  parentId: string | null;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds of the last rename. */
  updatedAt: number;
}

export interface WorkspaceState {
  /** Every script in the workspace, open or not, in creation order. */
  scripts: readonly ScriptDocument[];
  /** Every folder, in creation order. */
  folders: readonly ScriptFolder[];
  /** Tab order. Always a subset of `scripts`. */
  openScriptIds: readonly string[];
  /** One of `openScriptIds`, or null exactly when no tab is open. */
  activeScriptId: string | null;
}

export const WORKSPACE_SCHEMA_VERSION = 2;

/** Stored shape of one script, schema version 1. */
export interface PersistedScriptV1 {
  id: string;
  name: string;
  language: ScriptLanguage;
  /** Saved content. */
  content: string;
  /** Unsaved buffer, present only while it differs from `content`. */
  draft?: string;
  createdAt: number;
  updatedAt: number;
}

/** Stored workspace, schema version 1. Read for migration only. */
export interface PersistedWorkspaceV1 {
  version: 1;
  scripts: PersistedScriptV1[];
  openScriptIds: string[];
  activeScriptId: string | null;
}

/** Stored shape of one script, schema version 2: version 1 plus its location and favorite flag. */
export interface PersistedScriptV2 extends PersistedScriptV1 {
  folderId: string | null;
  isFavorite: boolean;
}

export interface PersistedFolderV2 {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Stored workspace, schema version 2. */
export interface PersistedWorkspaceV2 {
  version: typeof WORKSPACE_SCHEMA_VERSION;
  scripts: PersistedScriptV2[];
  folders: PersistedFolderV2[];
  openScriptIds: string[];
  activeScriptId: string | null;
}
