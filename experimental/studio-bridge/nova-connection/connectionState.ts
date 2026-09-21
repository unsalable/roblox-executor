import type { ConnectionStatus } from "@/features/connection/types";

/**
 * The connection state machine. Every launch starts at disconnected; the
 * state is never persisted, so a stale "connected" cannot survive a restart.
 */
const TRANSITIONS: Record<ConnectionStatus, readonly ConnectionStatus[]> = {
  disconnected: ["connecting"],
  // Disconnecting while connecting abandons the attempt.
  connecting: ["connected", "error", "disconnecting"],
  connected: ["disconnecting"],
  disconnecting: ["disconnected"],
  // Retry, or dismiss the failure.
  error: ["connecting", "disconnected"],
};

export const CONNECTION_STATUSES = Object.keys(TRANSITIONS) as ConnectionStatus[];

export function canTransitionConnection(from: ConnectionStatus, to: ConnectionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidConnectionTransitionError extends Error {
  readonly from: ConnectionStatus;
  readonly to: ConnectionStatus;

  constructor(from: ConnectionStatus, to: ConnectionStatus) {
    super(`Invalid connection transition: ${from} → ${to}`);
    this.name = "InvalidConnectionTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function transitionConnection(from: ConnectionStatus, to: ConnectionStatus): ConnectionStatus {
  if (!canTransitionConnection(from, to)) throw new InvalidConnectionTransitionError(from, to);
  return to;
}
