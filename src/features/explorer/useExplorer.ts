import { useMemo, useSyncExternalStore } from "react";
import { useAppServices } from "@/app/services";
import type { ExplorerController } from "@/features/explorer/explorerController";
import { explorerPath, findExplorerNode } from "@/features/explorer/explorerModel";
import type { ExplorerNode, ExplorerSnapshot } from "@/features/explorer/types";

/**
 * React's view of the Explorer controller. Components read state through these
 * hooks and never hold the model themselves, so a selection change re-renders
 * what depends on the selection and nothing else.
 */

export interface ExplorerView extends ExplorerSnapshot {
  controller: ExplorerController;
}

export function useExplorer(): ExplorerView {
  const { explorer } = useAppServices();
  const snapshot = useSyncExternalStore(explorer.subscribe, explorer.getSnapshot);
  return { ...snapshot, controller: explorer };
}

export interface ExplorerSelection {
  /** The selected object, or null when nothing is selected. */
  node: ExplorerNode | null;
  /** From the root down to the selection, inclusive. Empty when nothing is selected. */
  path: readonly ExplorerNode[];
}

/**
 * The shared developer selection. This is the object picked in the Explorer,
 * never the text selected in the editor.
 */
export function useExplorerSelection(): ExplorerSelection {
  const { explorer } = useAppServices();
  const snapshot = useSyncExternalStore(explorer.subscribe, explorer.getSnapshot);

  return useMemo(() => {
    const node = findExplorerNode(snapshot.model, snapshot.selectedId);
    return { node, path: node === null ? [] : explorerPath(snapshot.model, node.id) };
  }, [snapshot.model, snapshot.selectedId]);
}
