import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import {
  favoriteKey,
  FolderBranch,
  folderKey,
  handleTreeKeyDown,
  parseRowKey,
  scriptKey,
  ScriptRow,
  TreeScriptRow,
  type Anchor,
  type RowKey,
  type TreeContext,
  type TreeKeyActions,
  type TreeRowHandlers,
} from "@/features/scripts/ScriptTree";
import {
  buildWorkspaceTree,
  filterWorkspaceTree,
  isTreeEmpty,
  listFavorites,
  normalizeQuery,
  type FolderNode,
  type WorkspaceTree,
} from "@/features/scripts/tree";
import { folderAncestorIds, folderDepth, MAX_FOLDER_DEPTH, type NameValidation } from "@/features/scripts/workspace";
import type { ScriptDocument, ScriptFolder } from "@/types/workspace";

/**
 * What the script manager can ask for. Destructive and dialog-backed requests
 * (close, discard, delete, new folder, move) go through the shell's central
 * workspace dialogs, so the sidebar never confirms anything itself.
 */
export interface ScriptManagerActions {
  openScript: (id: string) => void;
  closeScript: (id: string) => void;
  saveScript: (id: string) => void;
  createScript: (folderId: string | null) => void;
  createFolder: (parentId: string | null) => void;
  renameScript: (id: string, name: string) => NameValidation;
  renameFolder: (id: string, name: string) => NameValidation;
  duplicateScript: (id: string) => void;
  toggleFavorite: (id: string) => void;
  moveScript: (id: string) => void;
  discardChanges: (id: string) => void;
  deleteScript: (id: string) => void;
  deleteFolder: (id: string) => void;
}

interface ScriptManagerProps {
  scripts: readonly ScriptDocument[];
  folders: readonly ScriptFolder[];
  openScriptIds: readonly string[];
  activeScriptId: string | null;
  /** Must be referentially stable. */
  actions: ScriptManagerActions;
}

type MenuTarget = { key: RowKey | "root"; anchor: Anchor };

const EMPTY_SET: ReadonlySet<string> = new Set();

/** First script in display order, for Enter in the search field. */
function firstScript(tree: WorkspaceTree): ScriptDocument | undefined {
  const inFolder = (node: FolderNode): ScriptDocument | undefined => {
    for (const child of node.folders) {
      const found = inFolder(child);
      if (found) return found;
    }
    return node.scripts[0];
  };
  for (const node of tree.folders) {
    const found = inFolder(node);
    if (found) return found;
  }
  return tree.scripts[0];
}

function scriptMenu(script: ScriptDocument, isActive: boolean, isOpen: boolean, canMove: boolean): MenuItem[] {
  return [
    { id: "open", label: "Open", disabled: isActive },
    ...(isOpen ? [{ id: "close", label: "Close Tab" }] : []),
    { id: "separator-edit", separator: true },
    { id: "rename", label: "Rename", hint: "F2" },
    { id: "duplicate", label: "Duplicate" },
    { id: "favorite", label: script.isFavorite ? "Remove from Favorites" : "Add to Favorites" },
    { id: "move", label: "Move to…", disabled: !canMove },
    ...(script.isDirty
      ? [
          { id: "separator-changes", separator: true as const },
          { id: "save", label: "Save" },
          { id: "discard", label: "Discard Changes…" },
        ]
      : []),
    { id: "separator-delete", separator: true },
    { id: "delete", label: "Delete…", hint: "Del", destructive: true },
  ];
}

function folderMenu(canNest: boolean): MenuItem[] {
  return [
    { id: "new-script", label: "New Script" },
    { id: "new-folder", label: "New Folder", disabled: !canNest },
    { id: "separator-edit", separator: true },
    { id: "rename", label: "Rename", hint: "F2" },
    { id: "delete", label: "Delete…", hint: "Del", destructive: true },
  ];
}

const ROOT_MENU: readonly MenuItem[] = [
  { id: "new-script", label: "New Script" },
  { id: "new-folder", label: "New Folder" },
];

function ScriptManagerView({ scripts, folders, openScriptIds, activeScriptId, actions }: ScriptManagerProps) {
  const baseId = useId();
  const [query, setQuery] = useState("");
  const needle = normalizeQuery(useDeferredValue(query));
  const searching = needle !== "";

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(EMPTY_SET);
  /** Folders collapsed while searching; forgotten when the query changes. */
  const [searchCollapsed, setSearchCollapsed] = useState({ needle: "", ids: EMPTY_SET });
  const [favoritesOpen, setFavoritesOpen] = useState(true);
  const [renamingKey, setRenamingKey] = useState<RowKey | null>(null);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [focusKey, setFocusKey] = useState<RowKey | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<RowKey | null>(null);

  const rowId = useCallback((key: RowKey) => `${baseId}-${key}`, [baseId]);

  const tree = useMemo(() => buildWorkspaceTree(scripts, folders), [scripts, folders]);
  const visibleTree = useMemo(() => (searching ? filterWorkspaceTree(tree, needle) : tree), [tree, searching, needle]);
  const favorites = useMemo(() => listFavorites(scripts, needle), [scripts, needle]);
  const openIds = useMemo(() => new Set(openScriptIds), [openScriptIds]);

  const activeFolderId = useMemo(
    () => (activeScriptId === null ? null : (scripts.find((script) => script.id === activeScriptId)?.folderId ?? null)),
    [scripts, activeScriptId],
  );
  const activeAncestors = useMemo(() => folderAncestorIds(folders, activeFolderId), [folders, activeFolderId]);

  const isExpanded = useCallback(
    (folderId: string) =>
      searching
        ? !(searchCollapsed.needle === needle && searchCollapsed.ids.has(folderId))
        : !collapsed.has(folderId),
    [searching, needle, searchCollapsed, collapsed],
  );

  const setExpanded = useCallback(
    (folderId: string, expanded: boolean) => {
      const update = (ids: ReadonlySet<string>) => {
        if (ids.has(folderId) === !expanded) return ids;
        const next = new Set(ids);
        if (expanded) next.delete(folderId);
        else next.add(folderId);
        return next;
      };
      if (searching) {
        setSearchCollapsed((current) => ({
          needle,
          ids: update(current.needle === needle ? current.ids : EMPTY_SET),
        }));
      } else {
        setCollapsed(update);
      }
    },
    [searching, needle],
  );

  // Read through a ref so row handlers stay stable and toggling one folder does not re-render every row.
  const expansion = useRef({ isExpanded, setExpanded });
  useEffect(() => {
    expansion.current = { isExpanded, setExpanded };
  });
  const toggleFolder = useCallback((folderId: string) => {
    const current = expansion.current;
    current.setExpanded(folderId, !current.isExpanded(folderId));
  }, []);

  /** Row keys of the workspace tree in display order, skipping the contents of collapsed folders. */
  const visibleKeys = useMemo(() => {
    const keys: RowKey[] = [];
    const walk = (node: FolderNode) => {
      keys.push(folderKey(node.folder.id));
      if (!isExpanded(node.folder.id)) return;
      node.folders.forEach(walk);
      for (const script of node.scripts) keys.push(scriptKey(script.id));
    };
    visibleTree.folders.forEach(walk);
    for (const script of visibleTree.scripts) keys.push(scriptKey(script.id));
    return keys;
  }, [visibleTree, isExpanded]);

  const favoriteKeys = useMemo(() => favorites.map((script) => favoriteKey(script.id)), [favorites]);

  /** Roving tabindex: each tree has exactly one row in the tab order. */
  const pickTabbable = (keys: readonly RowKey[], preferred: readonly (RowKey | null)[]) => {
    const available = new Set(keys);
    return preferred.find((key) => key !== null && available.has(key)) ?? keys[0] ?? null;
  };
  const activeId = activeScriptId ?? "";
  const treeTabbable = pickTabbable(visibleKeys, [focusKey, scriptKey(activeId)]);
  const favoritesTabbable = pickTabbable(favoriteKeys, [focusKey, favoriteKey(activeId)]);

  // Newly created entries and moved scripts are revealed by expanding the folders above them.
  // `collapsed` is read, not tracked: expanding or collapsing a folder must not re-run the reveal.
  const knownEntries = useRef<{ scripts: Map<string, string | null>; folders: Set<string> } | null>(null);
  useEffect(() => {
    const previous = knownEntries.current;
    knownEntries.current = {
      scripts: new Map(scripts.map((script) => [script.id, script.folderId])),
      folders: new Set(folders.map((folder) => folder.id)),
    };
    if (!previous) return;

    const reveal = new Set<string>();
    const revealInside = (folderId: string | null) => {
      for (const id of folderAncestorIds(folders, folderId)) reveal.add(id);
    };
    for (const script of scripts) {
      if (!previous.scripts.has(script.id) || previous.scripts.get(script.id) !== script.folderId) {
        revealInside(script.folderId);
      }
    }
    const created = folders.filter((folder) => !previous.folders.has(folder.id));
    for (const folder of created) revealInside(folder.parentId);

    if ([...reveal].some((id) => collapsed.has(id))) {
      setCollapsed((current) => {
        const next = new Set(current);
        for (const id of reveal) next.delete(id);
        return next;
      });
    }

    const newest = created.at(-1);
    if (!newest) return;
    // After the expanded parent has rendered, bring the new folder into view.
    const frame = requestAnimationFrame(() =>
      document.getElementById(rowId(folderKey(newest.id)))?.firstElementChild?.scrollIntoView({ block: "nearest" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [scripts, folders, rowId]);

  // Keep the active script's row in view when it changes (new tab, tab switch, duplicate).
  useEffect(() => {
    if (activeScriptId === null) return;
    const row = document.getElementById(rowId(scriptKey(activeScriptId)));
    if (row && !row.closest("[inert]")) row.firstElementChild?.scrollIntoView({ block: "nearest" });
  }, [activeScriptId, rowId]);

  // Focus requested for after a re-render (rename can re-sort the row).
  useEffect(() => {
    const key = pendingFocus.current;
    if (key === null) return;
    pendingFocus.current = null;
    document.getElementById(rowId(key))?.focus();
  });

  // When the focused row disappears (deleted), keep keyboard users in the list instead of dropping focus.
  const previousKeys = useRef<{ tree: readonly RowKey[]; favorites: readonly RowKey[] }>({ tree: [], favorites: [] });
  useEffect(() => {
    const previous = previousKeys.current;
    previousKeys.current = { tree: visibleKeys, favorites: favoriteKeys };
    if (focusKey === null || document.activeElement !== document.body) return;

    const [before, now] = focusKey.startsWith("fav:")
      ? [previous.favorites, favoriteKeys]
      : [previous.tree, visibleKeys];
    const index = before.indexOf(focusKey);
    if (index === -1 || now.includes(focusKey)) return;
    const candidate = now[Math.min(index, now.length - 1)];
    if (candidate) document.getElementById(rowId(candidate))?.focus();
  }, [visibleKeys, favoriteKeys, focusKey, rowId]);

  const handlers = useMemo<TreeRowHandlers>(
    () => ({
      openScript: actions.openScript,
      closeScript: actions.closeScript,
      createScript: actions.createScript,
      toggleFolder,
      startRename: setRenamingKey,
      finishRename: (key, restoreFocus) => {
        setRenamingKey((current) => (current === key ? null : current));
        if (restoreFocus) pendingFocus.current = key;
      },
      renameScript: actions.renameScript,
      renameFolder: actions.renameFolder,
      showMenu: (key, anchor) => setMenu({ key, anchor }),
      focusRow: (key) => setFocusKey(key),
    }),
    [actions, toggleFolder],
  );

  const context: TreeContext = {
    rowId,
    isExpanded,
    activeScriptId,
    activeAncestors,
    openIds,
    tabbableKey: treeTabbable,
    renamingKey,
    needle,
    handlers,
  };

  const keyActions: TreeKeyActions = {
    activate: (key) => {
      const { kind, id } = parseRowKey(key);
      if (kind === "script") actions.openScript(id);
      else toggleFolder(id);
    },
    isExpanded,
    setExpanded,
    rename: setRenamingKey,
    remove: (key) => {
      const { kind, id } = parseRowKey(key);
      if (kind === "script") actions.deleteScript(id);
      else actions.deleteFolder(id);
    },
  };

  const menuItems = useMemo((): readonly MenuItem[] => {
    if (!menu) return [];
    if (menu.key === "root") return ROOT_MENU;
    const { kind, id } = parseRowKey(menu.key);
    if (kind === "folder") {
      return folders.some((folder) => folder.id === id) ? folderMenu(folderDepth(folders, id) < MAX_FOLDER_DEPTH) : [];
    }
    const script = scripts.find((candidate) => candidate.id === id);
    if (!script) return [];
    const canMove = folders.length > 0 || script.folderId !== null;
    return scriptMenu(script, script.id === activeScriptId, openIds.has(script.id), canMove);
  }, [menu, scripts, folders, activeScriptId, openIds]);

  const closeMenu = useCallback(() => setMenu(null), []);

  const onMenuSelect = (action: string) => {
    if (!menu) return;
    const { key } = menu;
    setMenu(null);

    if (key === "root") {
      if (action === "new-script") actions.createScript(null);
      else if (action === "new-folder") actions.createFolder(null);
      return;
    }

    const { kind, id } = parseRowKey(key);
    if (kind === "folder") {
      if (action === "new-script") actions.createScript(id);
      else if (action === "new-folder") actions.createFolder(id);
      else if (action === "rename") setRenamingKey(key);
      else if (action === "delete") actions.deleteFolder(id);
      return;
    }

    switch (action) {
      case "open":
        actions.openScript(id);
        break;
      case "close":
        actions.closeScript(id);
        break;
      case "rename":
        setRenamingKey(key);
        break;
      case "duplicate":
        actions.duplicateScript(id);
        break;
      case "favorite":
        actions.toggleFavorite(id);
        break;
      case "move":
        actions.moveScript(id);
        break;
      case "save":
        actions.saveScript(id);
        break;
      case "discard":
        actions.discardChanges(id);
        break;
      case "delete":
        actions.deleteScript(id);
        break;
    }
  };

  const focusFirstRow = () => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [];
    [...rows].find((row) => !row.closest("[inert]"))?.focus();
  };

  const isEmptyWorkspace = scripts.length === 0 && folders.length === 0;
  const showFavorites = favorites.length > 0;
  const noResults = searching && favorites.length === 0 && isTreeEmpty(visibleTree);
  const menuTriggerId = menu ? (menu.key === "root" ? `${baseId}-list` : rowId(menu.key)) : "";

  return (
    <section aria-labelledby={`${baseId}-title`} className="flex min-h-0 flex-1 flex-col border-t border-border pt-3">
      <div className="flex items-center justify-between px-3 pb-2">
        <h2 id={`${baseId}-title`} className="text-[10px] font-semibold tracking-[0.12em] text-subtle uppercase">
          Scripts
        </h2>
        <span className="font-mono text-[10px] text-subtle" title={`${scripts.length} scripts, ${folders.length} folders`}>
          {scripts.length}
        </span>
      </div>

      <div className="px-2 pb-1.5">
        <div className="relative">
          <Icon
            name="search"
            size={13}
            className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-subtle"
          />
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder="Search scripts…"
            aria-label="Search scripts"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query !== "") {
                event.preventDefault();
                setQuery("");
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                focusFirstRow();
              } else if (event.key === "Enter") {
                event.preventDefault();
                const match = favorites[0] ?? firstScript(visibleTree);
                if (match && searching) actions.openScript(match.id);
              }
            }}
            className="h-7 w-full rounded border border-border bg-surface-secondary pr-7 pl-7 text-xs text-foreground transition-colors duration-[var(--dur-fast)] outline-none placeholder:text-subtle hover:border-border-strong focus:border-accent"
          />
          {query !== "" ? (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
              aria-label="Clear search"
              title="Clear search (Esc)"
              className="animate-fade-in absolute top-1/2 right-1 -translate-y-1/2 rounded p-1 text-subtle hover:bg-surface-raised hover:text-foreground"
            >
              <Icon name="close" size={12} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex gap-1 px-2 pb-2">
        <ToolbarButton icon="filePlus" label="New Script" title="New script (Ctrl+T)" onClick={() => actions.createScript(null)} />
        <ToolbarButton icon="folderPlus" label="New Folder" title="New folder" onClick={() => actions.createFolder(null)} />
      </div>

      <div
        ref={listRef}
        id={`${baseId}-list`}
        tabIndex={-1}
        onContextMenu={(event) => {
          if (event.defaultPrevented) return;
          event.preventDefault();
          setMenu({ key: "root", anchor: { x: event.clientX, y: event.clientY } });
        }}
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 outline-none"
      >
        {isEmptyWorkspace ? (
          <EmptyState title="No scripts yet" detail="Create your first script.">
            <button
              type="button"
              onClick={() => actions.createScript(null)}
              className="mt-3 inline-flex items-center gap-1.5 rounded border border-border-strong px-2.5 py-1 text-xs text-foreground transition-colors duration-[var(--dur-fast)] hover:border-accent hover:bg-surface-raised"
            >
              <Icon name="plus" size={12} />
              New Script
            </button>
          </EmptyState>
        ) : noResults ? (
          <EmptyState title="No matching scripts" detail={`Nothing is named like "${query.trim()}".`} />
        ) : (
          <>
            {showFavorites ? (
              <div className="mb-1.5">
                <SectionToggle
                  label="Favorites"
                  count={favorites.length}
                  open={favoritesOpen || searching}
                  onToggle={() => setFavoritesOpen((open) => !open)}
                />
                <div
                  inert={!(favoritesOpen || searching)}
                  style={{ gridTemplateRows: favoritesOpen || searching ? "1fr" : "0fr" }}
                  className="grid transition-[grid-template-rows] duration-[var(--dur-base)] ease-[var(--ease-out)]"
                >
                  <div
                    role="tree"
                    aria-label="Favorite scripts"
                    onKeyDown={(event) => handleTreeKeyDown(event, keyActions)}
                    className="min-h-0 overflow-hidden"
                  >
                    {favorites.map((script) => {
                      const key = favoriteKey(script.id);
                      return (
                        <ScriptRow
                          key={script.id}
                          rowKey={key}
                          domId={rowId(key)}
                          script={script}
                          depth={0}
                          isActive={script.id === activeScriptId}
                          isOpen={openIds.has(script.id)}
                          tabbable={favoritesTabbable === key}
                          renaming={renamingKey === key}
                          needle={needle}
                          variant="favorite"
                          handlers={handlers}
                        />
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : null}

            {showFavorites && !isTreeEmpty(visibleTree) ? (
              <h3 className="flex h-6 items-center px-1.5 text-[10px] font-semibold tracking-[0.12em] text-subtle uppercase">
                Workspace
              </h3>
            ) : null}

            <div role="tree" aria-label="Workspace scripts" onKeyDown={(event) => handleTreeKeyDown(event, keyActions)}>
              {visibleTree.folders.map((node) => (
                <FolderBranch key={node.folder.id} node={node} context={context} />
              ))}
              {visibleTree.scripts.map((script) => (
                <TreeScriptRow key={script.id} script={script} depth={0} context={context} />
              ))}
            </div>
          </>
        )}
      </div>

      <Menu
        open={menu !== null && menuItems.length > 0}
        items={menuItems}
        onSelect={onMenuSelect}
        onClose={closeMenu}
        labelledBy={menuTriggerId}
        {...(menu ? { anchor: menu.anchor } : {})}
      />
    </section>
  );
}

function ToolbarButton({
  icon,
  label,
  title,
  onClick,
}: {
  icon: IconName;
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded border border-border px-1.5 text-[11px] text-muted transition-colors duration-[var(--dur-fast)] hover:border-border-strong hover:bg-surface-raised hover:text-foreground"
    >
      <Icon name={icon} size={13} className="shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

function SectionToggle({
  label,
  count,
  open,
  onToggle,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="flex h-6 w-full items-center gap-1 rounded px-1.5 text-[10px] font-semibold tracking-[0.12em] text-subtle uppercase transition-colors duration-[var(--dur-fast)] hover:text-muted"
    >
      <Icon
        name="chevronRight"
        size={11}
        className={`transition-transform duration-[var(--dur-fast)] ease-[var(--ease-out)] ${open ? "rotate-90" : ""}`}
      />
      {label}
      <span className="ml-auto font-mono font-normal tracking-normal">{count}</span>
    </button>
  );
}

function EmptyState({ title, detail, children }: { title: string; detail: string; children?: ReactNode }) {
  return (
    <div className="animate-fade-in px-3 py-6 text-center">
      <p className="text-xs text-muted">{title}</p>
      <p className="mt-1 text-[11px] leading-relaxed break-words text-subtle">{detail}</p>
      {children}
    </div>
  );
}

/** Only the fields the sidebar renders; content changes while typing do not re-render it. */
function sameListedScripts(a: readonly ScriptDocument[], b: readonly ScriptDocument[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index]!;
    const y = b[index]!;
    if (
      x !== y &&
      (x.id !== y.id ||
        x.name !== y.name ||
        x.folderId !== y.folderId ||
        x.isFavorite !== y.isFavorite ||
        x.isDirty !== y.isDirty ||
        x.createdAt !== y.createdAt)
    ) {
      return false;
    }
  }
  return true;
}

export const ScriptManager = memo(
  ScriptManagerView,
  (previous, next) =>
    previous.folders === next.folders &&
    previous.openScriptIds === next.openScriptIds &&
    previous.activeScriptId === next.activeScriptId &&
    previous.actions === next.actions &&
    sameListedScripts(previous.scripts, next.scripts),
);
