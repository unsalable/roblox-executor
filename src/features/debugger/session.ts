import type { DebugContext, DebugTarget } from "@/features/debugger/types";
import { explorerPath, formatExplorerPath } from "@/features/explorer/explorerModel";
import type { ExplorerModel } from "@/features/explorer/types";

/**
 * What a debug session is started with, built from state Nova already has.
 *
 * The script comes from the workspace and the context from the **shared
 * developer selection** — the object picked in the Explorer, the same one the
 * Property Inspector and the status bar read. The debugger does not keep a
 * selection of its own.
 */

/** Lines a script has. At least 1, so an empty script still has a first line. */
export function countScriptLines(content: string): number {
  if (content === "") return 1;
  return content.split("\n").length;
}

/** The debug target for a script, or null when there is no script to debug. */
export function debugTargetFromScript(
  script: { id: string; name: string; content: string } | null | undefined,
): DebugTarget | null {
  if (!script) return null;
  return { scriptId: script.id, scriptName: script.name, lineCount: countScriptLines(script.content) };
}

/** The debug context for the Explorer's selected object, or null when nothing is selected. */
export function debugContextFromExplorer(model: ExplorerModel, selectedId: string | null): DebugContext | null {
  if (selectedId === null) return null;
  const node = model.nodes.get(selectedId);
  if (!node) return null;

  return {
    objectId: node.id,
    name: node.name,
    className: node.className,
    path: formatExplorerPath(explorerPath(model, node.id)),
  };
}
