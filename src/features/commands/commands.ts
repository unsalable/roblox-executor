import type { Command } from "@/features/commands/types";
import { matchesQuery, normalizeQuery } from "@/lib/search";

/**
 * Searching and navigating a command list. Pure, so the palette's behaviour is
 * testable without rendering it.
 */

export const isCommandEnabled = (command: Command): boolean => command.disabledReason === undefined;

/** Higher is a better match. 0 means the command does not match at all. */
function score(command: Command, needle: string): number {
  const title = command.title.toLowerCase();
  if (title.startsWith(needle)) return 4;
  if (title.includes(needle)) return 3;
  if (command.keywords?.some((keyword) => matchesQuery(keyword, needle))) return 2;
  if (matchesQuery(command.category, needle)) return 1;
  return 0;
}

/**
 * The commands worth showing for a query, best match first. An empty query
 * keeps the list in its declared order, which groups related commands together.
 * Commands that cannot run stay in the list, so the palette can say why.
 */
export function filterCommands(commands: readonly Command[], query: string): readonly Command[] {
  const needle = normalizeQuery(query);
  if (needle === "") return commands;

  return commands
    .map((command, index) => ({ command, index, score: score(command, needle) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.command);
}

/**
 * The next command the arrow keys should land on, skipping the ones that
 * cannot run and wrapping at both ends. Returns -1 when nothing can run.
 */
export function nextCommandIndex(commands: readonly Command[], current: number, delta: number): number {
  if (commands.length === 0) return -1;

  const start = current < 0 || current >= commands.length ? (delta > 0 ? -1 : 0) : current;
  for (let step = 1; step <= commands.length; step += 1) {
    const index = (start + delta * step + commands.length * step) % commands.length;
    const command = commands[index];
    if (command && isCommandEnabled(command)) return index;
  }
  return -1;
}

/** The command a freshly opened or re-filtered list should highlight. */
export function firstCommandIndex(commands: readonly Command[]): number {
  return nextCommandIndex(commands, -1, 1);
}

/**
 * Which command the highlight should sit on: the one that was highlighted, as
 * long as it is still listed and can still run, and otherwise the first one
 * that can. Tracking the command rather than a position is what keeps the
 * highlight still while the list is rebuilt underneath it — the command list
 * is derived from target and Explorer state, which can change at any moment.
 */
export function resolveActiveIndex(commands: readonly Command[], activeId: string | null): number {
  const index = commands.findIndex((command) => command.id === activeId);
  const command = index === -1 ? undefined : commands[index];
  return command !== undefined && isCommandEnabled(command) ? index : firstCommandIndex(commands);
}

/**
 * Runs the command at `index`, if there is one there and it can run. `close` is
 * called first, so focus is restored before the command moves it somewhere
 * else. Returns the command that ran, or null.
 */
export function runCommandAt(commands: readonly Command[], index: number, close: () => void): Command | null {
  const command = index < 0 ? undefined : commands[index];
  if (command === undefined || !isCommandEnabled(command)) return null;

  close();
  command.run();
  return command;
}
