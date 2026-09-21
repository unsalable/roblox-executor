import { memo, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { Highlight } from "@/components/ui/Highlight";
import { Icon, type IconName } from "@/components/ui/Icon";
import { RenameField } from "@/features/scripts/RenameField";
import type { FolderNode } from "@/features/scripts/tree";
import type { NameValidation } from "@/features/scripts/workspace";
import type { ScriptDocument } from "@/types/workspace";

/** Row identity inside the sidebar. A favorite script has a second row, so rows are keyed by location. */
export type RowKey = string;
export const scriptKey = (id: string): RowKey => `s:${id}`;
export const folderKey = (id: string): RowKey => `f:${id}`;
export const favoriteKey = (id: string): RowKey => `fav:${id}`;

export function parseRowKey(key: RowKey): { kind: "script" | "folder"; id: string } {
  if (key.startsWith("f:")) return { kind: "folder", id: key.slice(2) };
  return { kind: "script", id: key.slice(key.indexOf(":") + 1) };
}

export interface Anchor {
  x: number;
  y: number;
}

export interface TreeRowHandlers {
  openScript: (id: string) => void;
  closeScript: (id: string) => void;
  createScript: (folderId: string) => void;
  toggleFolder: (id: string) => void;
  startRename: (key: RowKey) => void;
  finishRename: (key: RowKey, restoreFocus: boolean) => void;
  renameScript: (id: string, name: string) => NameValidation;
  renameFolder: (id: string, name: string) => NameValidation;
  showMenu: (key: RowKey, anchor: Anchor) => void;
  focusRow: (key: RowKey) => void;
}

/** Everything a folder branch needs to render its rows. Rebuilt when any of it changes. */
export interface TreeContext {
  rowId: (key: RowKey) => string;
  isExpanded: (folderId: string) => boolean;
  activeScriptId: string | null;
  /** Folders containing the active script, so a collapsed one can say so. */
  activeAncestors: ReadonlySet<string>;
  openIds: ReadonlySet<string>;
  tabbableKey: RowKey | null;
  renamingKey: RowKey | null;
  needle: string;
  handlers: TreeRowHandlers;
}

const BASE_PADDING = 6;
const INDENT_STEP = 12;
/** Chevron plus gap; scripts reserve it so their icons line up with sibling folders. */
const TWISTIE = 18;
/** Deeper levels keep the last indentation so a hand-edited workspace cannot push rows off the sidebar. */
const MAX_VISUAL_DEPTH = 6;
/** Rows created this recently animate in; rows that merely re-mount (scrolling, filtering) do not. */
const RECENT_MS = 1500;

const rowPadding = (depth: number) => BASE_PADDING + Math.min(depth, MAX_VISUAL_DEPTH) * INDENT_STEP;

/** Where a context menu opens: at the pointer, or under the row for keyboard-invoked menus (reported at 0, 0). */
function contextAnchor(event: ReactMouseEvent<HTMLElement>): Anchor {
  if (event.clientX !== 0 || event.clientY !== 0) return { x: event.clientX, y: event.clientY };
  const row = event.currentTarget.querySelector(".tree-row") ?? event.currentTarget;
  const rect = row.getBoundingClientRect();
  return { x: rect.left + 16, y: rect.bottom + 2 };
}

/** Pointer-only shortcut on a hovered row. Keyboard users reach the same actions through the context menu. */
function RowButton({ icon, label, onClick }: { icon: IconName; label: string; onClick: (anchor: Anchor) => void }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      title={label}
      aria-label={label}
      onMouseDown={(event) => event.preventDefault()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        onClick({ x: rect.left, y: rect.bottom + 2 });
      }}
      className="rounded p-1 text-subtle transition-colors duration-[var(--dur-fast)] hover:bg-surface-raised hover:text-foreground"
    >
      <Icon name={icon} size={12} />
    </button>
  );
}

const rowBase =
  "tree-row group/row relative flex min-h-7 items-center gap-1.5 rounded pr-1.5 text-xs transition-colors duration-[var(--dur-fast)]";

interface ScriptRowProps {
  rowKey: RowKey;
  domId: string;
  script: ScriptDocument;
  depth: number;
  isActive: boolean;
  isOpen: boolean;
  tabbable: boolean;
  renaming: boolean;
  needle: string;
  /** Favorites rows show a star instead of the file icon. */
  variant: "tree" | "favorite";
  handlers: TreeRowHandlers;
}

/** Memoized: typing in the editor or toggling another row must not re-render every script row. */
export const ScriptRow = memo(function ScriptRow({
  rowKey,
  domId,
  script,
  depth,
  isActive,
  isOpen,
  tabbable,
  renaming,
  needle,
  variant,
  handlers,
}: ScriptRowProps) {
  const status = [
    isOpen ? "open" : null,
    script.isDirty ? "unsaved changes" : null,
    variant === "tree" && script.isFavorite ? "favorite" : null,
  ]
    .filter(Boolean)
    .join(", ");
  const recent = Date.now() - script.createdAt < RECENT_MS;

  const tone = isActive
    ? "bg-accent-soft text-foreground"
    : isOpen
      ? "text-muted hover:bg-surface-raised hover:text-foreground"
      : "text-subtle hover:bg-surface-raised hover:text-foreground";

  return (
    <div
      role="treeitem"
      id={domId}
      data-row-key={rowKey}
      aria-level={depth + 1}
      aria-selected={isActive}
      aria-label={script.name}
      {...(status ? { "aria-description": status } : {})}
      tabIndex={tabbable ? 0 : -1}
      onFocus={(event) => {
        if (event.target === event.currentTarget) handlers.focusRow(rowKey);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!renaming) handlers.showMenu(rowKey, contextAnchor(event));
      }}
      className={`tree-item outline-none ${recent || variant === "favorite" ? "animate-row-in" : ""}`}
    >
      <div
        title={script.isDirty ? `${script.name} — unsaved changes` : script.name}
        style={{ paddingLeft: rowPadding(depth) + TWISTIE }}
        onClick={renaming ? undefined : () => handlers.openScript(script.id)}
        onDoubleClick={renaming ? undefined : () => handlers.startRename(rowKey)}
        className={`${rowBase} ${tone} ${isOpen ? "hover:pr-12" : "hover:pr-7"}`}
      >
        <Icon
          name={variant === "favorite" ? "star" : "file"}
          filled={variant === "favorite"}
          size={14}
          className={`shrink-0 ${
            variant === "favorite" ? "text-warning" : isActive ? "text-accent" : isOpen ? "text-muted" : "text-subtle"
          }`}
        />
        {renaming ? (
          <RenameField
            initialValue={script.name}
            label={`Rename ${script.name}`}
            onSubmit={(name) => handlers.renameScript(script.id, name)}
            onDone={(restoreFocus) => handlers.finishRename(rowKey, restoreFocus)}
          />
        ) : (
          <>
            <span className="min-w-0 truncate">
              <Highlight text={script.name} needle={needle} />
            </span>
            {variant === "tree" && script.isFavorite ? (
              <Icon name="star" filled size={10} className="shrink-0 text-subtle" />
            ) : null}
            {script.isDirty ? (
              <span
                aria-hidden="true"
                className="ml-auto size-1.5 shrink-0 rounded-full bg-warning group-hover/row:opacity-0"
              />
            ) : null}
            <span
              aria-hidden="true"
              className="absolute inset-y-0 right-0.5 flex items-center opacity-0 transition-opacity duration-[var(--dur-fast)] group-hover/row:opacity-100"
            >
              <RowButton icon="more" label="More actions" onClick={(anchor) => handlers.showMenu(rowKey, anchor)} />
              {isOpen ? (
                <RowButton icon="close" label={`Close ${script.name}`} onClick={() => handlers.closeScript(script.id)} />
              ) : null}
            </span>
          </>
        )}
      </div>
    </div>
  );
});

/** One folder and, below it, its contents. Children stay mounted while collapsed so the height can animate. */
export function FolderBranch({ node, context }: { node: FolderNode; context: TreeContext }) {
  const { folder, depth } = node;
  const key = folderKey(folder.id);
  const { handlers } = context;
  const expanded = context.isExpanded(folder.id);
  const renaming = context.renamingKey === key;
  const isEmpty = node.folders.length === 0 && node.scripts.length === 0;
  const holdsActive = !expanded && context.activeAncestors.has(folder.id);
  const status = [
    isEmpty ? "empty" : null,
    !expanded && node.hasDirty ? "contains unsaved changes" : null,
    holdsActive ? "contains the active script" : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div
      role="treeitem"
      id={context.rowId(key)}
      data-row-key={key}
      data-folder-id={folder.id}
      aria-level={depth + 1}
      aria-expanded={expanded}
      aria-label={folder.name}
      {...(status ? { "aria-description": status } : {})}
      tabIndex={context.tabbableKey === key ? 0 : -1}
      onFocus={(event) => {
        if (event.target === event.currentTarget) handlers.focusRow(key);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!renaming) handlers.showMenu(key, contextAnchor(event));
      }}
      className={`tree-item outline-none ${Date.now() - folder.createdAt < RECENT_MS ? "animate-row-in" : ""}`}
    >
      <div
        title={folder.name}
        style={{ paddingLeft: rowPadding(depth) }}
        onClick={renaming ? undefined : () => handlers.toggleFolder(folder.id)}
        className={`${rowBase} text-muted hover:bg-surface-raised hover:pr-12 hover:text-foreground`}
      >
        <Icon
          name="chevronRight"
          size={12}
          className={`shrink-0 text-subtle transition-transform duration-[var(--dur-fast)] ease-[var(--ease-out)] ${
            expanded ? "rotate-90" : ""
          }`}
        />
        <Icon
          name={expanded ? "folderOpen" : "folder"}
          size={14}
          className={`shrink-0 ${holdsActive ? "text-accent" : "text-subtle"}`}
        />
        {renaming ? (
          <RenameField
            initialValue={folder.name}
            label={`Rename folder ${folder.name}`}
            onSubmit={(name) => handlers.renameFolder(folder.id, name)}
            onDone={(restoreFocus) => handlers.finishRename(key, restoreFocus)}
          />
        ) : (
          <>
            <span className="min-w-0 truncate">
              <Highlight text={folder.name} needle={context.needle} />
            </span>
            {!expanded && node.hasDirty ? (
              <span
                aria-hidden="true"
                className="ml-auto size-1.5 shrink-0 rounded-full bg-warning group-hover/row:opacity-0"
              />
            ) : null}
            <span
              aria-hidden="true"
              className="absolute inset-y-0 right-0.5 flex items-center opacity-0 transition-opacity duration-[var(--dur-fast)] group-hover/row:opacity-100"
            >
              <RowButton
                icon="filePlus"
                label={`New script in ${folder.name}`}
                onClick={() => handlers.createScript(folder.id)}
              />
              <RowButton icon="more" label="More actions" onClick={(anchor) => handlers.showMenu(key, anchor)} />
            </span>
          </>
        )}
      </div>

      <div
        role="group"
        inert={!expanded}
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
        className="grid transition-[grid-template-rows] duration-[var(--dur-base)] ease-[var(--ease-out)]"
      >
        <div className="relative min-h-0 overflow-hidden">
          <span
            aria-hidden="true"
            style={{ left: rowPadding(depth) + 5 }}
            className="pointer-events-none absolute inset-y-0.5 w-px bg-border"
          />
          {isEmpty ? (
            <p
              style={{ paddingLeft: rowPadding(depth + 1) + TWISTIE }}
              className="flex h-6 items-center text-[11px] text-subtle italic"
            >
              This folder is empty
            </p>
          ) : null}
          {node.folders.map((child) => (
            <FolderBranch key={child.folder.id} node={child} context={context} />
          ))}
          {node.scripts.map((script) => (
            <TreeScriptRow key={script.id} script={script} depth={depth + 1} context={context} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function TreeScriptRow({
  script,
  depth,
  context,
}: {
  script: ScriptDocument;
  depth: number;
  context: TreeContext;
}) {
  const key = scriptKey(script.id);
  return (
    <ScriptRow
      rowKey={key}
      domId={context.rowId(key)}
      script={script}
      depth={depth}
      isActive={script.id === context.activeScriptId}
      isOpen={context.openIds.has(script.id)}
      tabbable={context.tabbableKey === key}
      renaming={context.renamingKey === key}
      needle={context.needle}
      variant="tree"
      handlers={context.handlers}
    />
  );
}

export interface TreeKeyActions {
  /** Enter / Space: open a script or toggle a folder. */
  activate: (key: RowKey) => void;
  isExpanded: (folderId: string) => boolean;
  setExpanded: (folderId: string, expanded: boolean) => void;
  rename: (key: RowKey) => void;
  remove: (key: RowKey) => void;
}

/**
 * Keyboard model of an ARIA tree: arrows move between visible rows, Right and
 * Left expand, collapse or step into and out of folders, Home/End jump, and
 * F2 / Delete rename or delete the focused entry. Modified keys are left to
 * the application shortcuts.
 */
export function handleTreeKeyDown(event: ReactKeyboardEvent<HTMLElement>, actions: TreeKeyActions): void {
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  const item = event.target as HTMLElement;
  if (item.getAttribute("role") !== "treeitem" || !item.dataset.rowKey) return;

  const tree = event.currentTarget;
  const key = item.dataset.rowKey;
  const folderId = item.dataset.folderId;
  const visible = () =>
    [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')].filter((row) => !row.closest("[inert]"));
  const focus = (target: Element | null | undefined) => {
    event.preventDefault();
    if (target instanceof HTMLElement) target.focus();
  };

  switch (event.key) {
    case "ArrowDown":
    case "ArrowUp": {
      const rows = visible();
      focus(rows[rows.indexOf(item) + (event.key === "ArrowDown" ? 1 : -1)]);
      break;
    }
    case "Home":
      focus(visible()[0]);
      break;
    case "End":
      focus(visible().at(-1));
      break;
    case "ArrowRight":
      if (folderId === undefined) return;
      if (!actions.isExpanded(folderId)) {
        event.preventDefault();
        actions.setExpanded(folderId, true);
      } else {
        focus(item.querySelector('[role="group"] [role="treeitem"]'));
      }
      break;
    case "ArrowLeft":
      if (folderId !== undefined && actions.isExpanded(folderId)) {
        event.preventDefault();
        actions.setExpanded(folderId, false);
      } else {
        focus(item.parentElement?.closest('[role="treeitem"]'));
      }
      break;
    case "Enter":
    case " ":
      event.preventDefault();
      actions.activate(key);
      break;
    case "F2":
      event.preventDefault();
      actions.rename(key);
      break;
    case "Delete":
      event.preventDefault();
      actions.remove(key);
      break;
  }
}
