import { useCallback, useEffect, useMemo, useState } from "react";
import { getLogHistory, subscribeToLogs, type LogEntry } from "@/lib/logger";

export interface ConsoleLog {
  entries: readonly LogEntry[];
  clear: () => void;
}

/**
 * Bridges `lib/logger` into the console panel. There is no second log
 * store: entries come from `subscribeToLogs`, and the buffer the logger already
 * keeps is replayed on mount so startup messages are not lost.
 *
 * The list is capped so a future high-volume log stream cannot grow the DOM
 * without bound.
 */
export function useConsoleLog(limit = 1000): ConsoleLog {
  const [entries, setEntries] = useState<readonly LogEntry[]>(() => getLogHistory().slice(-limit));

  useEffect(() => {
    const initial = getLogHistory().slice(-limit);
    setEntries(initial);

    let lastId = initial.length === 0 ? 0 : initial[initial.length - 1].id;

    return subscribeToLogs((entry) => {
      if (entry.id <= lastId) return;
      lastId = entry.id;

      setEntries((current) => {
        const next = [...current, entry];
        return next.length > limit ? next.slice(next.length - limit) : next;
      });
    });
  }, [limit]);

  const clear = useCallback(() => setEntries([]), []);

  return useMemo(() => ({ entries, clear }), [entries, clear]);
}
