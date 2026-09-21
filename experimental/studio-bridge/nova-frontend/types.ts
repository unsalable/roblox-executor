import type { PROTOCOL_VERSION } from "@/features/bridge/protocol";

/** Identifies the real provider family in metadata; see {@link BridgeSnapshot}. */
export const STUDIO_PROVIDER_TYPE = "studio-development";

/**
 * The bridge lifecycle Nova owns. Listening (Nova is waiting for Studio) is
 * deliberately distinct from connected (a Studio plugin has completed the
 * handshake): the bridge being up never implies execution is available.
 */
export type BridgePhase = "stopped" | "starting" | "listening" | "connecting" | "connected" | "stopping" | "error";

export type BridgeErrorCode =
  | "BRIDGE_START_FAILED"
  | "PORT_IN_USE"
  | "TRANSPORT_ERROR"
  | "PAIRING_EXPIRED"
  | "AUTHENTICATION_FAILED"
  | "UNSUPPORTED_PROTOCOL"
  | "HEARTBEAT_TIMEOUT"
  | "STUDIO_DISCONNECTED"
  | "SESSION_REPLACED";

export interface BridgeError {
  code: BridgeErrorCode;
  message: string;
  details?: string;
}

/** What a connected Studio plugin told us about itself during the handshake. */
export interface BridgeSessionInfo {
  readonly id: string;
  readonly clientType: string;
  readonly clientVersion: string;
  readonly protocolVersion: string;
  readonly capabilities: readonly string[];
  /** Epoch milliseconds. */
  readonly connectedAt: number;
}

/** A live pairing offer. The secret code is here so the UI can show it; it is never logged. */
export interface PairingInfo {
  readonly code: string;
  /** Epoch milliseconds after which the code no longer pairs. */
  readonly expiresAt: number;
}

export interface BridgeSnapshot {
  readonly phase: BridgePhase;
  /** A Studio plugin has completed the handshake and is authenticated. */
  readonly studioConnected: boolean;
  /** The transport is bound and accepting plugin connections. */
  readonly listening: boolean;
  /** Loopback address the bridge is bound to, e.g. "127.0.0.1:46682". */
  readonly address: string | null;
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly session: BridgeSessionInfo | null;
  /** The pairing offer awaiting a plugin, or null when none is open. */
  readonly pairing: PairingInfo | null;
  /** Real round-trip time of the last heartbeat, in milliseconds. */
  readonly latencyMs: number | null;
  /** Epoch milliseconds of the last successful heartbeat. */
  readonly lastHeartbeatAt: number | null;
  readonly error: BridgeError | null;
}
