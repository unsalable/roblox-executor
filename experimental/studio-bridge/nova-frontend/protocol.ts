/**
 * The Nova ⇄ Studio bridge wire protocol. This module is pure: it defines the
 * message envelope, encodes/decodes it and validates inbound data. It has no
 * transport, clock or randomness of its own, so it is fully unit-testable and
 * identical on both the Nova and (conceptually) the plugin side.
 */

/** Bumped only on an incompatible change; both sides must agree on it exactly. */
export const PROTOCOL_VERSION = "NOVA_STUDIO_BRIDGE_V1";

/**
 * Largest inbound source snapshot accepted, in bytes. Oversized execution
 * requests are refused with a structured error rather than truncated.
 */
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

/** Largest whole message accepted; the source plus envelope overhead. */
export const MAX_MESSAGE_BYTES = MAX_SOURCE_BYTES + 64 * 1024;

export const BRIDGE_MESSAGE_TYPES = [
  "hello",
  "hello_ack",
  "pair_request",
  "pair_response",
  "ping",
  "pong",
  "execute_request",
  "execute_started",
  "execute_output",
  "execute_result",
  "execute_error",
  "execute_cancel",
  "studio_log",
  "studio_error",
  "disconnect",
  "error",
] as const;

export type BridgeMessageType = (typeof BRIDGE_MESSAGE_TYPES)[number];

const MESSAGE_TYPE_SET = new Set<string>(BRIDGE_MESSAGE_TYPES);

/** Structured protocol failures. Never raw exceptions on the wire. */
export type ProtocolErrorCode =
  | "INVALID_MESSAGE"
  | "UNSUPPORTED_PROTOCOL"
  | "REQUEST_TOO_LARGE"
  | "AUTHENTICATION_FAILED"
  | "PAIRING_EXPIRED"
  | "INVALID_EXECUTION_REQUEST"
  | "UNKNOWN_REQUEST"
  | "SESSION_EXPIRED";

export interface ProtocolError {
  code: ProtocolErrorCode;
  message: string;
  details?: string;
}

/** The single message shape used in both directions. */
export interface BridgeEnvelope {
  /** Always {@link PROTOCOL_VERSION} for an accepted message. */
  readonly protocol: string;
  readonly type: BridgeMessageType;
  /** Unique per message; used to de-duplicate and to trace in the console. */
  readonly messageId: string;
  /** Epoch milliseconds set by the sender. */
  readonly timestamp: number;
  /** Correlates a response with the request that caused it, when applicable. */
  readonly requestId?: string;
  readonly payload: Record<string, unknown>;
}

export interface CreateEnvelopeInput {
  type: BridgeMessageType;
  messageId: string;
  timestamp: number;
  requestId?: string | undefined;
  payload?: Record<string, unknown>;
}

/** Builds a well-formed envelope. `requestId` is included only when provided. */
export function createEnvelope(input: CreateEnvelopeInput): BridgeEnvelope {
  return {
    protocol: PROTOCOL_VERSION,
    type: input.type,
    messageId: input.messageId,
    timestamp: input.timestamp,
    payload: input.payload ?? {},
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
  };
}

export function encodeMessage(envelope: BridgeEnvelope): string {
  return JSON.stringify(envelope);
}

const encoder = new TextEncoder();

export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

export type DecodeResult = { ok: true; envelope: BridgeEnvelope } | { ok: false; error: ProtocolError };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Parses and validates a raw inbound message. Structure, types and size are all
 * checked here so no caller has to trust the wire; the protocol version is
 * verified last so a version mismatch is reported distinctly.
 */
export function decodeMessage(raw: string, options: { maxBytes?: number } = {}): DecodeResult {
  const maxBytes = options.maxBytes ?? MAX_MESSAGE_BYTES;
  if (byteLength(raw) > maxBytes) {
    return { ok: false, error: { code: "REQUEST_TOO_LARGE", message: `Message exceeds ${maxBytes} bytes.` } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "INVALID_MESSAGE",
        message: "Message is not valid JSON.",
        details: error instanceof Error ? error.message : String(error),
      },
    };
  }

  if (!isRecord(parsed)) return invalid("Message is not an object.");
  if (typeof parsed.type !== "string" || !MESSAGE_TYPE_SET.has(parsed.type)) {
    return invalid("Message type is missing or unknown.", `type: ${String(parsed.type)}`);
  }
  if (typeof parsed.messageId !== "string" || parsed.messageId === "") return invalid("Message id is missing.");
  if (typeof parsed.timestamp !== "number" || !Number.isFinite(parsed.timestamp)) {
    return invalid("Message timestamp is missing or not a number.");
  }
  if (parsed.requestId !== undefined && typeof parsed.requestId !== "string") {
    return invalid("Message requestId must be a string when present.");
  }
  if (!isRecord(parsed.payload)) return invalid("Message payload must be an object.");

  if (parsed.protocol !== PROTOCOL_VERSION) {
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_PROTOCOL",
        message: "The peer speaks an incompatible bridge protocol.",
        details: `expected ${PROTOCOL_VERSION}, received ${String(parsed.protocol)}`,
      },
    };
  }

  const envelope: BridgeEnvelope = {
    protocol: PROTOCOL_VERSION,
    type: parsed.type as BridgeMessageType,
    messageId: parsed.messageId,
    timestamp: parsed.timestamp,
    payload: parsed.payload,
    ...(typeof parsed.requestId === "string" ? { requestId: parsed.requestId } : {}),
  };
  return { ok: true, envelope };
}

function invalid(message: string, details?: string): DecodeResult {
  return { ok: false, error: details === undefined ? { code: "INVALID_MESSAGE", message } : { code: "INVALID_MESSAGE", message, details } };
}

/** Reads a required string field from a payload, or returns null. */
export function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

/** Reads a required finite number field from a payload, or returns null. */
export function readNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Reads an array-of-strings field, dropping non-string entries; missing → []. */
export function readStringArray(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
