import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Menu, type MenuAnchor, type MenuItem } from "@/components/ui/Menu";
import { createDiagnosticReporter } from "@/features/diagnostics/diagnostics";
import {
  ExplorerBranch,
  handleExplorerKeyDown,
  type ExplorerKeyActions,
  type ExplorerRowHandlers,
  type ExplorerTreeContext,
} from "@/features/explorer/ExplorerTree";
import {
  buildExplorerTree,
  explorerPath,
  filterExplorerTree,
  firstExplorerId,
  firstExplorerMatchId,
  formatExplorerPath,
  isExplorerTreeEmpty,
  visibleExplorerIds,
} from "@/features/explorer/explorerModel";
import { useExplorer } from "@/features/explorer/useExplorer";
import { copyText } from "@/lib/clipboard";
import { normalizeQuery } from "@/lib/search";

/** What the shell can ask the panel to do, e.g. from the command palette. */
export interface ExplorerPanelHandle {
  /** Moves focus to the tree, or to the search field when the tree is empty. */
  focusTree: () => void;
  focusSearch: () => void;
}

const diagnostics = createDiagnosticReporter("Explorer", "explorerPanel");

function nodeMenu(hasChildren: boolean, expanded: boolean): readonly MenuItem[] {
  return [
    { id: "inspect", label: "Inspect" },
    { id: "separator-copy", separator: true },
    { id: "copy-name", label: "Copy Name" },
    { id: "copy-path", label: "Copy Path" },
    { id: "separator-tree", separator: true },
    { id: "expand", label: "Expand", disabled: !hasChildren || expanded },
    { id: "collapse", label: "Collapse", disabled: !hasChildren || !expanded },
    { id: "expand-all", label: "Expand All" },
    { id: "collapse-all", label: "Collapse All" },
  ];
}

/**
 * The developer Explorer, in the sidebar next to where the script workspace
 * lives. The two trees never share state: this one browses objects a provider
 * reports, the script tree owns Nova's own documents.
 *
 * The panel renders the controller's model and asks the controller to change
 * it; the only state it keeps is its own search query and which row was last
 * focused, both of which are about this view and nothing else.
 */
export function ExplorerPanel({ ref, onInspect }: { ref?: Ref<ExplorerPanelHandle>; onInspect?: () => void }) {
  const { model, selectedId, expandedIds, controller } = useExplorer();
  const baseId = useId();

  const [query, setQuery] = useState("");
  const needle = normalizeQuery(useDeferredValue(query));
  const searching = needle !== "";
  const [menu, setMenu] = useState<{ id: string; anchor: MenuAnchor } | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const rowId = useCallback((id: string) => `${baseId}-${id}`, [baseId]);

  const tree = useMemo(() => buildExplorerTree(model), [model]);
  const visibleTree = useMemo(() => (searching ? filterExplorerTree(tree, needle) : tree), [tree, searching, needle]);

  /** While searching every branch is opened, so a match is never hidden behind a closed parent. */
  const isExpanded = useCallback(
    (id: string) => (searching ? true : expandedIds.has(id)),
    [searching, expandedIds],
  );

  const visibleIds = useMemo(() => visibleExplorerIds(visibleTree, isExpanded), [visibleTree, isExpanded]);
  const tabbableId = useMemo(() => {
    const available = new Set(visibleIds);
    return [focusId, selectedId].find((id) => id !== null && available.has(id)) ?? visibleIds[0] ?? null;
  }, [visibleIds, focusId, selectedId]);

  useImperativeHandle(
    ref,
    () => ({
      focusTree: () => {
        requestAnimationFrame(() => {
          const row = tabbableId === null ? null : document.getElementById(rowId(tabbableId));
          (row ?? searchRef.current)?.focus();
        });
      },
      focusSearch: () => requestAnimationFrame(() => searchRef.current?.focus()),
    }),
    [tabbableId, rowId],
  );

  // Keep the selected object in view when it is selected from somewhere else
  // (the breadcrumb, the command palette), not on every re-render.
  useEffect(() => {
    if (selectedId === null) return;
    document.getElementById(rowId(selectedId))?.firstElementChild?.scrollIntoView({ block: "nearest" });
  }, [selectedId, rowId]);

  // Collapsing or filtering can take away the row the keyboard was on — and a
  // context-menu action hands focus back to a row that is no longer there.
  // Rather than leaving focus on the document, put it on the row that took its
  // place.
  useEffect(() => {
    if (focusId === null || document.activeElement !== document.body) return;
    if (visibleIds.includes(focusId)) return;
    if (tabbableId !== null) document.getElementById(rowId(tabbableId))?.focus();
  }, [visibleIds, focusId, tabbableId, rowId]);

  const handlers = useMemo<ExplorerRowHandlers>(
    () => ({
      select: controller.select,
      toggle: controller.toggleExpanded,
      showMenu: (id, anchor) => setMenu({ id, anchor }),
      focusRow: setFocusId,
    }),
    [controller],
  );

  const keyActions = useMemo<ExplorerKeyActions>(() => {
    // A search holds every branch open, so nothing can be expanded or collapsed
    // underneath the filter; Right and Left then step through the hierarchy.
    const hasChildren = (id: string) => (model.nodes.get(id)?.childIds.length ?? 0) > 0;
    return {
      select: controller.select,
      clearSelection: controller.clearSelection,
      canExpand: (id) => !searching && hasChildren(id) && !expandedIds.has(id),
      canCollapse: (id) => !searching && hasChildren(id) && expandedIds.has(id),
      setExpanded: controller.setExpanded,
    };
  }, [controller, searching, expandedIds, model]);

  const context: ExplorerTreeContext = {
    rowId,
    isExpanded,
    selectedId,
    tabbableId,
    needle,
    handlers,
  };

  const menuNode = menu === null ? null : (model.nodes.get(menu.id) ?? null);
  const menuItems = useMemo(
    () => (menuNode === null ? [] : nodeMenu(menuNode.childIds.length > 0, isExpanded(menuNode.id))),
    [menuNode, isExpanded],
  );

  const copy = async (value: string, what: "name" | "path") => {
    const copied = await copyText(value);
    if (!copied) {
      diagnostics.warn(`The object ${what} could not be copied to the clipboard.`, { code: "CLIPBOARD_UNAVAILABLE" });
    }
  };

  const runMenuAction = (action: string) => {
    const node = menuNode;
    setMenu(null);
    if (!node) return;

    switch (action) {
      case "inspect":
        controller.reveal(node.id);
        controller.select(node.id);
        diagnostics.info(`Inspecting ${node.className} "${node.name}".`, {
          code: "EXPLORER_INSPECT",
          objectId: node.id,
        });
        onInspect?.();
        break;
      case "copy-name":
        void copy(node.name, "name");
        break;
      case "copy-path":
        void copy(formatExplorerPath(explorerPath(model, node.id)), "path");
        break;
      case "expand":
        controller.setExpanded(node.id, true);
        break;
      case "collapse":
        controller.setExpanded(node.id, false);
        break;
      case "expand-all":
        controller.expandAll();
        break;
      case "collapse-all":
        controller.collapseAll();
        break;
    }
  };

  const focusFirstRow = () => {
    listRef.current?.querySelector<HTMLElement>('[role="treeitem"]')?.focus();
  };

  const empty = model.count === 0;
  const noResults = searching && isExplorerTreeEmpty(visibleTree);

  return (
    <section
      aria-labelledby={`${baseId}-title`}
      className="flex min-h-0 flex-1 flex-col border-t border-border pt-3"
    >
      <div className="flex items-center justify-between gap-2 px-3 pb-2">
        <h2 id={`${baseId}-title`} className="text-[10px] font-semibold tracking-[0.12em] text-subtle uppercase">
          Explorer
        </h2>
        <span
          className="flex items-center gap-1.5 font-mono text-[10px] text-subtle"
          title={`${controller.provider.label}: ${controller.provider.description}`}
        >
          {controller.provider.mock ? (
            <span className="rounded-sm border border-warning/40 px-1 font-sans tracking-wide text-warning uppercase">
              Mock
            </span>
          ) : null}
          {model.count}
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
            placeholder="Search objects…"
            aria-label="Search Explorer objects"
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
              } else if (event.key === "Enter" && searching) {
                event.preventDefault();
                // The first row of a filtered tree is usually an object kept
                // for context, so Enter goes to the first actual match.
                const match = firstExplorerMatchId(visibleTree) ?? firstExplorerId(visibleTree);
                if (match !== null) {
                  controller.reveal(match);
                  controller.select(match);
                }
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
              aria-label="Clear Explorer search"
              title="Clear search (Esc)"
              className="animate-fade-in absolute top-1/2 right-1 -translate-y-1/2 rounded p-1 text-subtle hover:bg-surface-raised hover:text-foreground"
            >
              <Icon name="close" size={12} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex gap-1 px-2 pb-2">
        <ToolbarButton
          icon="expandAll"
          label="Expand All"
          title={searching ? "Everything is shown while searching" : "Expand every object"}
          disabled={searching}
          onClick={controller.expandAll}
        />
        <ToolbarButton
          icon="collapseAll"
          label="Collapse All"
          title={searching ? "Everything is shown while searching" : "Collapse every object"}
          disabled={searching}
          onClick={controller.collapseAll}
        />
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {empty ? (
          <EmptyState title="Nothing to explore" detail="The provider reported no objects." />
        ) : noResults ? (
          <EmptyState title="No matching objects" detail={`Nothing is named like "${query.trim()}".`} />
        ) : (
          <div
            role="tree"
            aria-label="Developer Explorer objects"
            aria-multiselectable={false}
            onKeyDown={(event) => handleExplorerKeyDown(event, keyActions)}
          >
            {visibleTree.roots.map((entry) => (
              <ExplorerBranch key={entry.node.id} entry={entry} context={context} />
            ))}
          </div>
        )}
      </div>

      <Menu
        open={menu !== null && menuItems.length > 0}
        items={menuItems}
        onSelect={runMenuAction}
        onClose={() => setMenu(null)}
        labelledBy={menu === null ? "" : rowId(menu.id)}
        {...(menu ? { anchor: menu.anchor } : {})}
      />
    </section>
  );
}

function ToolbarButton({
  icon,
  label,
  title,
  disabled,
  onClick,
}: {
  icon: IconName;
  label: string;
  title: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className="flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded border border-border px-1.5 text-[11px] text-muted transition-colors duration-[var(--dur-fast)] hover:border-border-strong hover:bg-surface-raised hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      <Icon name={icon} size={13} className="shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="animate-fade-in px-3 py-6 text-center">
      <p className="text-xs text-muted">{title}</p>
      <p className="mt-1 text-[11px] leading-relaxed break-words text-subtle">{detail}</p>
    </div>
  );
}
