/** Opaque timer handle; only the clock that created it can clear it. */
export type TimerId = unknown;

/**
 * Time source and timers for code that has to be testable without waiting in
 * real time. Production code uses `systemClock`; tests pass a fake one.
 */
export interface Clock {
  /** Epoch milliseconds. */
  now: () => number;
  setTimeout: (callback: () => void, ms: number) => TimerId;
  clearTimeout: (id: TimerId) => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (id) => {
    if (id !== null && id !== undefined) globalThis.clearTimeout(id as Parameters<typeof globalThis.clearTimeout>[0]);
  },
};
