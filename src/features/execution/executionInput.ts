import type { ExecutionInput } from "@/features/execution/types";

/** "auto" executes the selection when there is one and the full script otherwise. */
export type ExecuteCommand = "auto" | "full-script" | "selection";

export interface ExecuteTarget {
  /** The active script with its current content, or null when no script is open. */
  script: { id: string; name: string; content: string } | null;
  /** Text selected in the editor; empty when nothing is selected. */
  selectedText: string;
}

/**
 * Turns an Execute command into a request input, copying the text to run out
 * of the target. Strings are immutable, so the input cannot change when the
 * editor does.
 */
export function buildExecutionInput(command: ExecuteCommand, target: ExecuteTarget): ExecutionInput {
  const mode = command === "auto" ? (target.selectedText.length > 0 ? "selection" : "full-script") : command;
  const script = target.script === null ? null : { id: target.script.id, name: target.script.name };

  if (target.script === null) return { mode, script, source: null };
  return { mode, script, source: mode === "selection" ? target.selectedText : target.script.content };
}
