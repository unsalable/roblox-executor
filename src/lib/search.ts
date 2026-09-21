/**
 * Text matching for every searchable list in the shell: the script manager, the
 * developer Explorer and the command palette. One implementation, so a query
 * behaves the same wherever it is typed — trimmed, lowercased, substring.
 */

/** Trimmed and lowercased. An empty result means "no filter". */
export const normalizeQuery = (query: string): string => query.trim().toLowerCase();

/** Position of a normalized query inside a name, for highlighting. -1 when it does not occur. */
export function matchIndex(name: string, needle: string): number {
  return needle === "" ? -1 : name.toLowerCase().indexOf(needle);
}

/** True when a normalized, non-empty query occurs in `name`. */
export function matchesQuery(name: string, needle: string): boolean {
  return name.toLowerCase().includes(needle);
}
