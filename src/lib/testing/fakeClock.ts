import type { Clock, TimerId } from "@/lib/clock";

export interface FakeClock extends Clock {
  /** Moves time forward, running due timers in order and settling promises after each one. */
  advance: (ms: number) => Promise<void>;
  /** Lets pending promise callbacks run without moving time. */
  flush: () => Promise<void>;
  /** Timers scheduled and not yet run or cleared. */
  pendingTimers: () => number;
}

interface Timer {
  at: number;
  order: number;
  callback: () => void;
}

/** Deterministic clock for unit tests. Test-only; never imported by application code. */
export function createFakeClock(start = 1_700_000_000_000): FakeClock {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, Timer>();

  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  const nextDue = (limit: number): [number, Timer] | undefined => {
    let found: [number, Timer] | undefined;
    for (const entry of timers) {
      const [, timer] = entry;
      if (timer.at > limit) continue;
      if (!found || timer.at < found[1].at || (timer.at === found[1].at && timer.order < found[1].order)) found = entry;
    }
    return found;
  };

  return {
    now: () => now,
    setTimeout: (callback, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, ms), order: id, callback });
      return id;
    },
    clearTimeout: (id: TimerId) => {
      if (typeof id === "number") timers.delete(id);
    },
    advance: async (ms) => {
      const target = now + ms;
      await flush();
      for (let due = nextDue(target); due; due = nextDue(target)) {
        const [id, timer] = due;
        timers.delete(id);
        now = timer.at;
        timer.callback();
        await flush();
      }
      now = target;
      await flush();
    },
    flush,
    pendingTimers: () => timers.size,
  };
}
