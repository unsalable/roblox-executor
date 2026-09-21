import type { Clock } from "@/lib/clock";

/**
 * Local pairing: a short-lived, single-use numeric code the user reads from
 * Nova and types into the Studio plugin. It is generated locally, never
 * persisted and never logged. Codes expire and lock out after too many wrong
 * attempts so a code cannot be brute-forced within its lifetime.
 */

export interface PairingCode {
  readonly code: string;
  readonly expiresAt: number;
}

export type PairingVerdict = "ok" | "invalid" | "expired" | "locked" | "none";

export interface PairingController {
  /** Opens a new pairing window, replacing and invalidating any previous code. */
  begin: () => PairingCode;
  /** The open pairing offer, or null when none is active. */
  current: () => PairingCode | null;
  /** Checks a submitted code. A correct code consumes the offer; wrong ones count toward lockout. */
  verify: (code: string) => PairingVerdict;
  /** Invalidates any open code (e.g. after a successful pairing or on stop). */
  clear: () => void;
}

export interface PairingOptions {
  clock: Clock;
  /** Random source in [0, 1); defaults to crypto-quality randomness. */
  random?: () => number;
  /** How long a code stays valid; a function is read each time an offer opens. */
  ttlMs?: number | (() => number);
  /** Wrong attempts allowed before the code is invalidated. */
  maxAttempts?: number;
  /** Number of decimal digits in a code. */
  digits?: number;
}

function secureRandom(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0]! / 0x1_0000_0000;
}

/** Generates a zero-padded numeric code of `digits` length from `random`. */
export function generatePairingCode(random: () => number, digits: number): string {
  const max = 10 ** digits;
  const value = Math.floor(random() * max) % max;
  return String(value).padStart(digits, "0");
}

export function createPairingController(options: PairingOptions): PairingController {
  const { clock } = options;
  const random = options.random ?? secureRandom;
  const ttl = () => {
    const configured = typeof options.ttlMs === "function" ? options.ttlMs() : options.ttlMs;
    return configured === undefined || !Number.isFinite(configured) || configured <= 0 ? 60_000 : configured;
  };
  const maxAttempts = options.maxAttempts ?? 5;
  const digits = options.digits ?? 6;

  let code: string | null = null;
  let expiresAt = 0;
  let attempts = 0;

  const clear = () => {
    code = null;
    expiresAt = 0;
    attempts = 0;
  };

  return {
    begin: () => {
      code = generatePairingCode(random, digits);
      expiresAt = clock.now() + ttl();
      attempts = 0;
      return { code, expiresAt };
    },
    current: () => (code === null ? null : { code, expiresAt }),
    verify: (submitted) => {
      if (code === null) return "none";
      if (clock.now() >= expiresAt) {
        clear();
        return "expired";
      }
      if (submitted === code) {
        clear();
        return "ok";
      }
      attempts += 1;
      if (attempts >= maxAttempts) {
        clear();
        return "locked";
      }
      return "invalid";
    },
    clear,
  };
}
