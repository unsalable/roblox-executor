/**
 * The Nova local service wire protocol, as the frontend speaks it.
 *
 * This module is pure: it defines the envelopes, the error taxonomy and the
 * limits, and it encodes and validates messages. It has no transport, clock or
 * randomness of its own, so every rule here is unit-tested without an
 * application, a service or an IPC bridge around it.
 *
 * The service's copy of these constants lives in
 * `src-tauri/src/local_service/protocol.rs`. Nothing at runtime could notice
 * the two drifting apart — a mismatched version would simply refuse every
 * request — so `protocolParity.test.ts` reads that file and compares them.
 *
 * Deliberately absent from every type here, as from the service itself: process
 * ids, process handles, memory addresses, module lists, executable paths and
 * evaluated code. The only secret that crosses this boundary is the session
 * token, and it appears in exactly one place — the handshake reply — and is
 * never put in a log line, a diagnostic or a persisted value.
 */

/** Bumped only on an incompatible change; both sides must agree on it exactly. */
export const LOCAL_SERVICE_PROTOCOL_VERSION = "NOVA_LOCAL_SERVICE_V1";

/** Largest message accepted in either direction, in bytes. */
export const LOCAL_SERVICE_MAX_MESSAGE_BYTES = 64 * 1024;

/** Every operation the service answers. */
export const LOCAL_SERVICE_OPS = ["handshake", "health", "attach", "detach", "shutdown"] as const;

export type LocalServiceOp = (typeof LOCAL_SERVICE_OPS)[number];

/** The one capability the service implements, and so the only one to require. */
export const LOCAL_SERVICE_CAPABILITY_TARGET = "target";

/**
 * Refusals the *service* produces. Each is the answer to exactly one rule, and
 * the names match `ErrorCode::as_str` in the Rust module one for one.
 */
export const LOCAL_SERVICE_WIRE_ERROR_CODES = [
  "MESSAGE_TOO_LARGE",
  "MESSAGE_MALFORMED",
  "PROTOCOL_UNSUPPORTED",
  "AUTH_REQUIRED",
  "AUTH_INVALID",
  "SESSION_STALE",
  "CAPABILITY_UNSUPPORTED",
  "OPERATION_UNSUPPORTED",
  "ALREADY_ATTACHED",
  "SERVICE_UNAVAILABLE",
] as const;

/**
 * Refusals the *client* produces, for the failures that never reach the
 * service. They are kept separate so a reader always knows which side decided:
 * a `TRANSPORT_FAILED` is Nova's own report about the bridge, while an
 * `AUTH_INVALID` is the service's answer.
 */
export const LOCAL_SERVICE_CLIENT_ERROR_CODES = [
  /** There is no IPC bridge: Nova is running in a plain browser. */
  "TRANSPORT_UNAVAILABLE",
  /** The IPC call itself failed. */
  "TRANSPORT_FAILED",
  /** The service did not answer within the request timeout. */
  "REQUEST_TIMEOUT",
  /** The answer was not a well-formed response envelope. */
  "RESPONSE_MALFORMED",
  /** The answer named a different request, so it belongs to nothing current. */
  "RESPONSE_MISMATCHED",
] as const;

export type LocalServiceWireErrorCode = (typeof LOCAL_SERVICE_WIRE_ERROR_CODES)[number];
export type LocalServiceClientErrorCode = (typeof LOCAL_SERVICE_CLIENT_ERROR_CODES)[number];
export type LocalServiceErrorCode = LocalServiceWireErrorCode | LocalServiceClientErrorCode;

export interface LocalServiceError {
  readonly code: LocalServiceErrorCode;
  /** Short sentence suitable for the UI. */
  readonly message: string;
  /** Technical context. Never a token, never a path. */
  readonly details?: string;
}

/** One request, as it goes on the wire. */
export interface LocalServiceRequest {
  readonly protocol: string;
  readonly op: LocalServiceOp;
  readonly requestId: string;
  /** Null only for a handshake, which is the operation that issues a session. */
  readonly sessionId: string | null;
  readonly token: string | null;
  readonly payload: Record<string, unknown>;
}

export type LocalServiceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: LocalServiceError };

/** What the service says it can do. Every flag is reported, including the false ones. */
export interface LocalServiceCapabilities {
  readonly target: boolean;
  readonly debugger: boolean;
  readonly profiler: boolean;
  readonly execute: boolean;
}

/** What a handshake returns, minus the token, which never leaves the session client. */
export interface LocalServiceSessionInfo {
  readonly sessionId: string;
  readonly service: { readonly name: string; readonly version: string; readonly protocol: string };
  readonly capabilities: LocalServiceCapabilities;
  /** Epoch milliseconds, as the service measured it. */
  readonly openedAt: number;
  /** How many sessions the service has issued since it started. */
  readonly sessionsIssued: number;
}

/** What one health request found. */
export interface LocalServiceHealth {
  readonly target: { readonly available: boolean; readonly ready: boolean; readonly version: string };
  readonly attached: boolean;
  readonly capabilities: LocalServiceCapabilities;
  readonly sessionId: string | null;
  readonly attachedAt: number | null;
  readonly sessionsIssued: number;
}

const WIRE_CODES = new Set<string>(LOCAL_SERVICE_WIRE_ERROR_CODES);

const encoder = new TextEncoder();

export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

/** Builds a well-formed request. */
export function createRequest(input: {
  op: LocalServiceOp;
  requestId: string;
  sessionId?: string | null;
  token?: string | null;
  payload?: Record<string, unknown>;
}): LocalServiceRequest {
  return {
    protocol: LOCAL_SERVICE_PROTOCOL_VERSION,
    op: input.op,
    requestId: input.requestId,
    sessionId: input.sessionId ?? null,
    token: input.token ?? null,
    payload: input.payload ?? {},
  };
}

export function encodeRequest(request: LocalServiceRequest): string {
  return JSON.stringify(request);
}

/**
 * Reads one answer.
 *
 * The order mirrors the service's own: size, then JSON, then the envelope
 * shape, then the protocol version, then the request it claims to answer. An
 * answer for a different request is refused rather than applied — that is the
 * client half of the rule that a stale reply can never affect a live request.
 *
 * It never throws: every failure is a structured {@link LocalServiceError}.
 */
export function decodeResponse(raw: string, requestId: string): LocalServiceResult<unknown> {
  if (byteLength(raw) > LOCAL_SERVICE_MAX_MESSAGE_BYTES) {
    return {
      ok: false,
      error: {
        code: "RESPONSE_MALFORMED",
        message: "The local service sent more than the protocol allows.",
        details: `the limit is ${LOCAL_SERVICE_MAX_MESSAGE_BYTES} bytes`,
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {
      ok: false,
      error: { code: "RESPONSE_MALFORMED", message: "The local service sent something that is not JSON." },
    };
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      error: { code: "RESPONSE_MALFORMED", message: "The local service sent something that is not a response." },
    };
  }

  if (parsed.protocol !== LOCAL_SERVICE_PROTOCOL_VERSION) {
    return {
      ok: false,
      error: {
        code: "PROTOCOL_UNSUPPORTED",
        message: "The local service speaks a different protocol version.",
        details: `expected ${LOCAL_SERVICE_PROTOCOL_VERSION}, received ${String(parsed.protocol).slice(0, 64)}`,
      },
    };
  }

  if (parsed.requestId !== requestId) {
    return {
      ok: false,
      error: {
        code: "RESPONSE_MISMATCHED",
        message: "The local service answered a different request.",
        details: "the answer was discarded",
      },
    };
  }

  if (parsed.ok === true) {
    if (!isRecord(parsed.payload)) {
      return {
        ok: false,
        error: { code: "RESPONSE_MALFORMED", message: "The local service sent an answer with no payload." },
      };
    }
    return { ok: true, value: parsed.payload };
  }

  if (parsed.ok !== false) {
    return {
      ok: false,
      error: { code: "RESPONSE_MALFORMED", message: "The local service sent an answer that is neither a result nor a refusal." },
    };
  }

  const error = readWireError(parsed.error);
  if (error === null) {
    return {
      ok: false,
      error: { code: "RESPONSE_MALFORMED", message: "The local service refused the request without saying why." },
    };
  }
  return { ok: false, error };
}

/** A refusal the service sent, or null when it is not one. */
function readWireError(value: unknown): LocalServiceError | null {
  if (!isRecord(value)) return null;
  const { code, message, details } = value;
  if (typeof code !== "string" || !WIRE_CODES.has(code)) return null;
  if (typeof message !== "string" || message === "") return null;
  return {
    code: code as LocalServiceWireErrorCode,
    message,
    ...(typeof details === "string" && details !== "" ? { details } : {}),
  };
}

function readCapabilities(value: unknown): LocalServiceCapabilities | null {
  if (!isRecord(value)) return null;
  const { target, debugger: debug, profiler, execute } = value;
  if (!isBoolean(target) || !isBoolean(debug) || !isBoolean(profiler) || !isBoolean(execute)) return null;
  return Object.freeze({ target, debugger: debug, profiler, execute });
}

/** Validates a handshake payload. The token is returned separately and is never part of the info. */
export function readSessionOpened(
  payload: unknown,
): { info: LocalServiceSessionInfo; token: string } | null {
  if (!isRecord(payload)) return null;
  const { sessionId, token, service, capabilities, openedAt, sessionsIssued } = payload;
  if (typeof sessionId !== "string" || sessionId === "") return null;
  if (typeof token !== "string" || token === "") return null;
  if (!isRecord(service)) return null;
  if (typeof service.name !== "string" || typeof service.version !== "string") return null;
  if (typeof service.protocol !== "string") return null;
  const read = readCapabilities(capabilities);
  if (read === null) return null;
  if (typeof openedAt !== "number" || !Number.isFinite(openedAt)) return null;
  if (typeof sessionsIssued !== "number" || !Number.isFinite(sessionsIssued)) return null;

  return {
    token,
    info: Object.freeze({
      sessionId,
      service: Object.freeze({ name: service.name, version: service.version, protocol: service.protocol }),
      capabilities: read,
      openedAt,
      sessionsIssued,
    }),
  };
}

/** Validates a health payload. */
export function readHealth(payload: unknown): LocalServiceHealth | null {
  if (!isRecord(payload)) return null;
  const { target, attached, capabilities, sessionId, attachedAt, sessionsIssued } = payload;
  if (!isRecord(target)) return null;
  if (!isBoolean(target.available) || !isBoolean(target.ready)) return null;
  if (typeof target.version !== "string" || target.version === "") return null;
  if (!isBoolean(attached)) return null;
  const read = readCapabilities(capabilities);
  if (read === null) return null;
  if (typeof sessionsIssued !== "number" || !Number.isFinite(sessionsIssued)) return null;

  return Object.freeze({
    target: Object.freeze({ available: target.available, ready: target.ready, version: target.version }),
    attached,
    capabilities: read,
    sessionId: typeof sessionId === "string" && sessionId !== "" ? sessionId : null,
    attachedAt: typeof attachedAt === "number" && Number.isFinite(attachedAt) ? attachedAt : null,
    sessionsIssued,
  });
}

/** Validates an attach payload. */
export function readAttached(payload: unknown): { attachedAt: number } | null {
  if (!isRecord(payload)) return null;
  if (payload.attached !== true) return null;
  const { attachedAt } = payload;
  if (typeof attachedAt !== "number" || !Number.isFinite(attachedAt)) return null;
  return { attachedAt };
}

/**
 * True when a refusal means the session this client holds is no longer the one
 * the service will act on. Every one of these is a lost session rather than a
 * failed operation, and they are the only refusals that end a session.
 */
export function isSessionLost(code: LocalServiceErrorCode): boolean {
  return code === "SESSION_STALE" || code === "AUTH_INVALID" || code === "AUTH_REQUIRED";
}
