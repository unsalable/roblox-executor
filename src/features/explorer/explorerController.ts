import { createDiagnosticReporter, type DiagnosticReporter } from "@/features/diagnostics/diagnostics";
import {
  buildExplorerModel,
  explorerAncestorIds,
  hasExplorerChildren,
} from "@/features/explorer/explorerModel";
import type {
  ExplorerModel,
  ExplorerProvider,
  ExplorerProviderInfo,
  ExplorerSnapshot,
} from "@/features/explorer/types";

/**
 * The Explorer controller: the single source of truth for the resolved
 * hierarchy, the developer selection and which objects are expanded.
 *
 * The selection lives here rather than in a view because four surfaces share
 * it — the tree, the Property Inspector, the diagnostics it reports and the
 * command palette. It is session state and is never persisted: a selection is
 * about the objects a provider is reporting right now.
 *
 * This selection has nothing to do with the text selected in the Monaco editor.
 * They are different concepts and never meet.
 */
export interface ExplorerController {
  readonly provider: ExplorerProviderInfo;
  /** Stable between changes, so `useSyncExternalStore` can compare it. */
  getSnapshot: () => ExplorerSnapshot;
  subscribe: (listener: () => void) => () => void;
  /** Selects an object, or clears the selection with null. An unknown id clears it. */
  select: (id: string | null) => void;
  clearSelection: () => void;
  isExpanded: (id: string) => boolean;
  setExpanded: (id: string, expanded: boolean) => void;
  toggleExpanded: (id: string) => void;
  /** Expands every object that has children. */
  expandAll: () => void;
  /** Collapses everything, leaving the roots as the only rows. */
  collapseAll: () => void;
  /** Expands the objects above `id`, so it can be seen. Does not select it. */
  reveal: (id: string) => void;
  /** Reads the provider again. Selection and expansion survive for objects that are still there. */
  reload: () => void;
  dispose: () => void;
}

export interface ExplorerControllerOptions {
  provider: ExplorerProvider;
  /** Test seam. Defaults to the Explorer diagnostics reporter. */
  report?: DiagnosticReporter;
}

/** How many model issues are reported individually before they are summarized. */
const ISSUE_REPORT_LIMIT = 5;

/**
 * Whether two expansion sets hold the same objects. Comparing sizes would be
 * wrong: a hierarchy that changes shape can produce a different set of the same
 * size, and the change would then be dropped.
 */
function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

export function createExplorerController({ provider, report }: ExplorerControllerOptions): ExplorerController {
  const diagnostics = report ?? createDiagnosticReporter("Explorer", "explorerController");
  const listeners = new Set<() => void>();

  let snapshot: ExplorerSnapshot = {
    model: buildExplorerModel([]),
    selectedId: null,
    expandedIds: new Set<string>(),
  };

  const publish = () => {
    for (const listener of listeners) listener();
  };

  const update = (patch: Partial<ExplorerSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    publish();
  };

  const reportIssues = (model: ExplorerModel) => {
    for (const issue of model.issues.slice(0, ISSUE_REPORT_LIMIT)) {
      switch (issue.kind) {
        case "duplicate-id":
          diagnostics.warn("An object was reported twice and the second copy was dropped.", {
            code: "EXPLORER_DUPLICATE_ID",
            objectId: issue.id,
          });
          break;
        case "missing-parent":
          diagnostics.warn("An object names a parent that was not reported, so it is shown at the root.", {
            code: "EXPLORER_MISSING_PARENT",
            objectId: issue.id,
          });
          break;
        case "parent-cycle":
          diagnostics.warn("The parents of an object lead back to it, so the loop was broken at it.", {
            code: "EXPLORER_PARENT_CYCLE",
            objectId: issue.id,
          });
          break;
      }
    }

    const hidden = model.issues.length - ISSUE_REPORT_LIMIT;
    if (hidden > 0) {
      diagnostics.warn(`${hidden} further hierarchy problems were repaired the same way.`, {
        code: "EXPLORER_ISSUES_TRUNCATED",
      });
    }
  };

  /** Builds the model from the provider and keeps whatever state still applies. */
  const load = (reason: "start" | "reload" | "provider") => {
    let model: ExplorerModel;
    try {
      model = buildExplorerModel(provider.read());
    } catch (error) {
      diagnostics.error("The Explorer provider could not be read.", { code: "EXPLORER_PROVIDER_FAILED", data: error });
      model = buildExplorerModel([]);
    }

    // Expansion only ever describes objects that can be expanded, so an object
    // that lost its children cannot stay in the set and claim to be open.
    const expandable = (id: string) => {
      const node = model.nodes.get(id);
      return node !== undefined && hasExplorerChildren(node);
    };

    const expandedIds = new Set<string>();
    for (const id of snapshot.expandedIds) {
      if (expandable(id)) expandedIds.add(id);
    }
    // First read: show the roots opened, so the tree is not one closed line.
    if (reason === "start") for (const id of model.rootIds) if (expandable(id)) expandedIds.add(id);

    const selectedId = snapshot.selectedId !== null && model.nodes.has(snapshot.selectedId) ? snapshot.selectedId : null;
    if (selectedId === null && snapshot.selectedId !== null) {
      diagnostics.info("The selected object is no longer reported, so the selection was cleared.", {
        code: "EXPLORER_SELECTION_LOST",
        objectId: snapshot.selectedId,
      });
    }

    snapshot = { model, selectedId, expandedIds };
    reportIssues(model);
    if (reason !== "start") publish();
  };

  load("start");
  const unsubscribeProvider = provider.subscribe(() => load("provider"));

  const setExpanded = (id: string, expanded: boolean) => {
    const node = snapshot.model.nodes.get(id);
    if (!node || !hasExplorerChildren(node)) return;
    if (snapshot.expandedIds.has(id) === expanded) return;

    const expandedIds = new Set(snapshot.expandedIds);
    if (expanded) expandedIds.add(id);
    else expandedIds.delete(id);
    update({ expandedIds });
  };

  return {
    provider: {
      label: provider.label,
      providerType: provider.providerType,
      mock: provider.mock,
      description: provider.description,
    },
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    select: (id) => {
      if (id === null) {
        if (snapshot.selectedId !== null) update({ selectedId: null });
        return;
      }
      if (!snapshot.model.nodes.has(id)) {
        diagnostics.debug("An object that is not in the hierarchy was selected, so the selection was cleared.", {
          code: "EXPLORER_UNKNOWN_OBJECT",
          objectId: id,
        });
        if (snapshot.selectedId !== null) update({ selectedId: null });
        return;
      }
      if (snapshot.selectedId !== id) update({ selectedId: id });
    },
    clearSelection: () => {
      if (snapshot.selectedId !== null) update({ selectedId: null });
    },
    isExpanded: (id) => snapshot.expandedIds.has(id),
    setExpanded,
    toggleExpanded: (id) => setExpanded(id, !snapshot.expandedIds.has(id)),
    expandAll: () => {
      const expandedIds = new Set<string>();
      for (const node of snapshot.model.nodes.values()) {
        if (hasExplorerChildren(node)) expandedIds.add(node.id);
      }
      if (!sameIds(expandedIds, snapshot.expandedIds)) update({ expandedIds });
    },
    collapseAll: () => {
      if (snapshot.expandedIds.size > 0) update({ expandedIds: new Set<string>() });
    },
    reveal: (id) => {
      const ancestors = explorerAncestorIds(snapshot.model, id);
      const expandedIds = new Set(snapshot.expandedIds);
      for (const ancestorId of ancestors) expandedIds.add(ancestorId);
      if (!sameIds(expandedIds, snapshot.expandedIds)) update({ expandedIds });
    },
    reload: () => load("reload"),
    dispose: () => {
      unsubscribeProvider();
      listeners.clear();
    },
  };
}
