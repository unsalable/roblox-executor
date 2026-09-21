/**
 * The command palette's model.
 *
 * A command is an action the shell already has, named once so it can be found
 * by typing instead of by remembering where its button is. Nothing is listed
 * that does not exist: a command either runs a real handler or says why it
 * cannot right now.
 */

export const COMMAND_CATEGORIES = [
  "Workspace",
  "View",
  "Explorer",
  "Console",
  "Target",
  "Debugger",
  "Profiler",
  "Developer",
  "Updates",
  "Settings",
] as const;

export type CommandCategory = (typeof COMMAND_CATEGORIES)[number];

export interface Command {
  readonly id: string;
  /** What the palette lists, e.g. "Toggle Console". */
  readonly title: string;
  readonly category: CommandCategory;
  /** Extra words the search also matches, for commands known under another name. */
  readonly keywords?: readonly string[];
  /** The keyboard shortcut that runs the same action, when there is one. */
  readonly hint?: string;
  /** Why it cannot run right now. Undefined when it can. */
  readonly disabledReason?: string;
  readonly run: () => void;
}
