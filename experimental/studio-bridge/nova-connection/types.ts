export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "disconnecting" | "error";

export type ConnectionErrorCode =
  /** The provider refused or could not complete the connection. */
  | "CONNECTION_FAILED"
  /** The provider did not connect within the configured timeout. */
  | "CONNECTION_TIMEOUT"
  /** The attempt was abandoned, e.g. by a disconnect while connecting. */
  | "CONNECTION_ABORTED";

export interface ConnectionError {
  code: ConnectionErrorCode;
  message: string;
  details?: string;
}

export type ConnectionResult =
  | {
      ok: true;
      /** Round-trip time, or null when the provider cannot measure it. */
      latencyMs: number | null;
      /** True when `latencyMs` is test data rather than a measurement. */
      latencySimulated: boolean;
    }
  | { ok: false; error: ConnectionError };

/** A connection target. The controller owns state, timeouts and logging; a provider only connects. */
export interface ConnectionProvider {
  /** Display name, e.g. "Local Test". */
  readonly label: string;
  /** Machine-readable family, e.g. "studio-development"; absent for the mock. */
  readonly providerType?: string;
  connect: () => Promise<ConnectionResult>;
  /** Ends the connection, or abandons an attempt in progress (which then settles as not ok). */
  disconnect: () => Promise<void>;
  /** The provider's own view of its link. */
  getStatus: () => ConnectionStatus;
}

export interface ConnectionSnapshot {
  readonly status: ConnectionStatus;
  readonly latencyMs: number | null;
  readonly latencySimulated: boolean;
  /** Epoch milliseconds, set while connected. */
  readonly connectedAt: number | null;
  /** The latest failure, set while `status` is "error". */
  readonly error: ConnectionError | null;
}
