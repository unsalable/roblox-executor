import { memo, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { Highlight } from "@/components/ui/Highlight";
import { Icon } from "@/components/ui/Icon";
import type { MenuAnchor } from "@/components/ui/Menu";
import { explorerClassIcon } from "@/features/explorer/classIcons";
import type { ExplorerNode, ExplorerTreeNode } from "@/features/explorer/types";

/**
 * The Explorer tree rows and their keyboard model.
 *
 * The structure is the ARIA tree the script manager also uses — a `treeitem`
 * that contains its own `group` — but this is a separate implementation on
 * purpose: the developer Explorer selects objects, while the script tree opens,
 * renames and deletes documents. Sharing one component would mean one of them
 * carrying the other's actions.
 *
 * Children are mounted only while their parent is expanded, so a large
 * hierarchy costs what is on screen rather than what exists.
 */

const BASE_PADDING = 6;
const INDENT_STEP = 12;
/** Chevron plus gap; leaves reserve it so their icons line up with sibling parents. */
const TWISTIE = 18;
/** Deeper levels keep the last indentation, so a deep hierarchy cannot push rows out of the panel. */
const MAX_VISUAL_DEPTH = 6;

const rowPadding = (depth: number) => BASE_PADDING + Math.min(depth, MAX_VISUAL_DEPTH) * INDENT_STEP;

export interface ExplorerRowHandlers {
  select: (id: string) => void;
  toggle: (id: string) => void;
  showMenu: (id: string, anchor: MenuAnchor) => void;
  focusRow: (id: string) => void;
}

export interface ExplorerTreeContext {
  rowId: (id: string) => string;
  isExpanded: (id: string) => boolean;
  selectedId: string | null;
  /** Roving tabindex: exactly one row is in the tab order. */
  tabbableId: string | null;
  /** Normalized query, for highlighting. */
  needle: string;
  handlers: ExplorerRowHandlers;
}

/** Where a context menu opens: at the pointer, or under the row for keyboard-invoked menus (reported at 0, 0). */
function contextAnchor(event: ReactMouseEvent<HTMLElement>): MenuAnchor {
  if (event.clientX !== 0 || event.clientY !== 0) return { x: event.clientX, y: event.clientY };
  const row = event.currentTarget.querySelector(".tree-row") ?? event.currentTarget;
  const rect = row.getBoundingClientRect();
  return { x: rect.left + 16, y: rect.bottom + 2 };
}

interface ExplorerRowProps {
  node: ExplorerNode;
  hasChildren: boolean;
  expanded: boolean;
  selected: boolean;
  needle: string;
  handlers: ExplorerRowHandlers;
}

/**
 * The row itself. Memoized, so selecting an object re-renders the row that lost
 * the selection and the row that gained it rather than the hierarchy.
 */
const ExplorerRow = memo(function ExplorerRow({
  node,
  hasChildren,
  expanded,
  selected,
  needle,
  handlers,
}: ExplorerRowProps) {
  return (
    <div
      title={`${node.name} — ${node.className}`}
      style={{ paddingLeft: rowPadding(node.depth) + (hasChildren ? 0 : TWISTIE) }}
      onClick={() => handlers.select(node.id)}
      onDoubleClick={() => {
        if (hasChildren) handlers.toggle(node.id);
      }}
      className={`tree-row group/row flex min-h-7 items-center gap-1.5 rounded pr-1.5 text-xs transition-colors duration-[var(--dur-fast)] ${
        selected ? "bg-accent-soft text-foreground" : "text-muted hover:bg-surface-raised hover:text-foreground"
      }`}
    >
      {hasChildren ? (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          title={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation();
            handlers.toggle(node.id);
          }}
          className="-ml-0.5 shrink-0 rounded p-0.5 text-subtle transition-colors duration-[var(--dur-fast)] hover:text-foreground"
        >
          <Icon
            name="chevronRight"
            size={12}
            className={`transition-transform duration-[var(--dur-fast)] ease-[var(--ease-out)] ${
              expanded ? "rotate-90" : ""
            }`}
          />
        </button>
      ) : null}

      <Icon
        name={explorerClassIcon(node.className)}
        size={14}
        className={`shrink-0 ${selected ? "text-accent" : "text-subtle"}`}
      />
      <span className="min-w-0 truncate">
        <Highlight text={node.name} needle={needle} />
      </span>
    </div>
  );
});

/**
 * One object and, while it is expanded, the objects inside it. The `group` is
 * rendered inside the `treeitem` it belongs to, so the hierarchy assistive
 * technology sees is the hierarchy on screen.
 */
export function ExplorerBranch({ entry, context }: { entry: ExplorerTreeNode; context: ExplorerTreeContext }) {
  const { node, children } = entry;
  const hasChildren = children.length > 0;
  const expanded = hasChildren && context.isExpanded(node.id);
  const selected = context.selectedId === node.id;

  return (
    <div
      role="treeitem"
      id={context.rowId(node.id)}
      data-node-id={node.id}
      aria-level={node.depth + 1}
      aria-selected={selected}
      aria-label={node.name}
      {...{ "aria-description": node.className }}
      {...(hasChildren ? { "aria-expanded": expanded } : {})}
      tabIndex={context.tabbableId === node.id ? 0 : -1}
      onFocus={(event) => {
        if (event.target === event.currentTarget) context.handlers.focusRow(node.id);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        context.handlers.select(node.id);
        context.handlers.showMenu(node.id, contextAnchor(event));
      }}
      className="tree-item outline-none"
    >
      <ExplorerRow
        node={node}
        hasChildren={hasChildren}
        expanded={expanded}
        selected={selected}
        needle={context.needle}
        handlers={context.handlers}
      />

      {expanded ? (
        <div role="group" className="relative">
          <span
            aria-hidden="true"
            style={{ left: rowPadding(node.depth) + 6 }}
            className="pointer-events-none absolute inset-y-0 w-px bg-border"
          />
          {children.map((child) => (
            <ExplorerBranch key={child.node.id} entry={child} context={context} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export interface ExplorerKeyActions {
  select: (id: string) => void;
  clearSelection: () => void;
  /** True when Right should open the object rather than step into it. */
  canExpand: (id: string) => boolean;
  /** True when Left should close the object rather than step out of it. */
  canCollapse: (id: string) => boolean;
  setExpanded: (id: string, expanded: boolean) => void;
}

/**
 * The keyboard model of an ARIA tree: arrows move between rows, Right and Left
 * expand, collapse or step into and out of an object, Home and End jump, Enter
 * and Space select and Escape clears the selection. Modified keys are left to
 * the application shortcuts.
 *
 * Right and Left ask whether the object *can* be opened or closed rather than
 * whether it looks open, so while a search holds every branch open they move
 * through the hierarchy instead of doing nothing.
 */
export function handleExplorerKeyDown(event: ReactKeyboardEvent<HTMLElement>, actions: ExplorerKeyActions): void {
  if (event.ctrlKey || event.altKey || event.metaKey) return;

  const item = event.target as HTMLElement;
  const id = item.dataset.nodeId;
  if (item.getAttribute("role") !== "treeitem" || id === undefined) return;

  const tree = event.currentTarget;
  const rows = () => [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  const focus = (target: Element | null | undefined) => {
    event.preventDefault();
    if (target instanceof HTMLElement) target.focus();
  };

  switch (event.key) {
    case "ArrowDown":
    case "ArrowUp": {
      const visible = rows();
      focus(visible[visible.indexOf(item) + (event.key === "ArrowDown" ? 1 : -1)]);
      break;
    }
    case "Home":
      focus(rows()[0]);
      break;
    case "End":
      focus(rows().at(-1));
      break;
    case "ArrowRight":
      if (actions.canExpand(id)) {
        event.preventDefault();
        actions.setExpanded(id, true);
      } else {
        focus(item.querySelector('[role="group"] [role="treeitem"]'));
      }
      break;
    case "ArrowLeft":
      if (actions.canCollapse(id)) {
        event.preventDefault();
        actions.setExpanded(id, false);
      } else {
        focus(item.parentElement?.closest('[role="treeitem"]'));
      }
      break;
    case "Enter":
    case " ":
      event.preventDefault();
      actions.select(id);
      break;
    case "Escape":
      event.preventDefault();
      actions.clearSelection();
      break;
  }
}
