import {
  LOCAL_SERVICE_CAPABILITY_TARGET,
  LOCAL_SERVICE_MAX_MESSAGE_BYTES,
  LOCAL_SERVICE_OPS,
  LOCAL_SERVICE_PROTOCOL_VERSION,
  byteLength,
  type LocalServiceOp,
  type LocalServiceWireErrorCode,
} from "@/features/backend/backends/localService/protocol";
import type { LocalServiceTransport } from "@/features/backend/backends/localService/transport";

/**
 * A stand-in for the Rust local service, for the unit tests.
 *
 * Test-only; never imported by application code, the same way
 * `lib/testing/fakeClock.ts` is not. The real service is
 * `src-tauri/src/local_service/`, is tested by `cargo test`, and is the one
 * that ships; this exists because `node --test` has no Tauri bridge, and
 * because the client's failure paths — a bridge that throws, a service that
 * never answers, an answer for the wrong request — cannot be produced by a
 * working service at all.
 *
 * **It implements the same rules in the same order**, and the ones that can be
 * compared as text are compared by `protocolParity.test.ts`. Where this and the
 * Rust service could still drift, the Rust tests are the authority: these tests
 * are about Nova's client, not about the service.
 *
 * The tokens it issues are counter-derived and deliberately guessable. They are
 * test data, they never leave this process, and the tests that check a token is
 * never logged or shown rely on being able to search for a known value.
 */

export type FakeLocalServiceFault =
  /** Answer normally. */
  | "none"
  /** The bridge itself fails, so the request never reaches the service. */
  | "throw"
  /** The request never reaches the service, so the client's deadline ends it. */
  | "silent"
  /** The service acts on the request and its answer is held until it is released. */
  | "withheld"
  /** The answer is not JSON. */
  | "garbage"
  /** The answer is larger than the protocol allows. */
  | "oversized"
  /** The answer names a different request. */
  | "mismatched"
  /** The answer claims another protocol version. */
  | "wrong-protocol";

export interface FakeLocalService {
  readonly transport: LocalServiceTransport;
  /** Every op the service was asked for, oldest first. */
  ops: () => readonly string[];
  /** Raw messages received, for the tests that inspect what was sent. */
  messages: () => readonly string[];
  /** The token of the open session, so a test can assert it never leaks. */
  currentToken: () => string | null;
  currentSessionId: () => string | null;
  isAttached: () => boolean;
  sessionsIssued: () => number;
  /**
   * Ends the open session without being asked — what a service restart, or a
   * session superseded by another window, looks like from Nova's side.
   */
  endSession: () => void;
  /** Detaches without being asked, leaving the session open. */
  loseAttachment: () => void;
  /** How the next answers behave. Applies until it is set back to "none". */
  setFault: (fault: FakeLocalServiceFault) => void;
  /** Delivers every answer held back by the "withheld" fault, oldest first. */
  releaseAnswers: () => void;
  /** Makes the handshake refuse, the way a service without the capability would. */
  setTargetCapability: (supported: boolean) => void;
}

export interface FakeLocalServiceOptions {
  /** False builds a transport that reports no bridge at all, like a browser. */
  available?: boolean;
  /** Milliseconds the service's own clock reports. Fixed, so answers are deterministic. */
  now?: () => number;
}

interface FakeSession {
  id: string;
  token: string;
  attached: boolean;
  attachedAt: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const OPS = new Set<string>(LOCAL_SERVICE_OPS);

export function createFakeLocalService(options: FakeLocalServiceOptions = {}): FakeLocalService {
  const available = options.available ?? true;
  const now = options.now ?? (() => 1_700_000_000_000);

  let session: FakeSession | null = null;
  let issued = 0;
  let fault: FakeLocalServiceFault = "none";
  let targetCapability = true;
  const ops: string[] = [];
  const messages: string[] = [];
  const held: (() => void)[] = [];

  const capabilities = () => ({
    target: targetCapability,
    debugger: false,
    profiler: false,
    execute: false,
  });

  const ok = (requestId: string, payload: Record<string, unknown>) =>
    JSON.stringify({ protocol: LOCAL_SERVICE_PROTOCOL_VERSION, requestId, ok: true, payload });

  const refuse = (requestId: string, code: LocalServiceWireErrorCode, message: string, details?: string) =>
    JSON.stringify({
      protocol: LOCAL_SERVICE_PROTOCOL_VERSION,
      requestId,
      ok: false,
      error: { code, message, ...(details === undefined ? {} : { details }) },
    });

  /** The same validation order the service uses: size, JSON, shape, version. */
  const answer = (raw: string): string => {
    messages.push(raw);

    if (byteLength(raw) > LOCAL_SERVICE_MAX_MESSAGE_BYTES) {
      return refuse("", "MESSAGE_TOO_LARGE", "The message is larger than the local service accepts.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return refuse("", "MESSAGE_MALFORMED", "The message is not a local service request.");
    }
    if (!isRecord(parsed)) return refuse("", "MESSAGE_MALFORMED", "The message is not a local service request.");

    const requestId = typeof parsed.requestId === "string" ? parsed.requestId : "";
    if (requestId === "") return refuse("", "MESSAGE_MALFORMED", "The message carries no request id.");
    if (typeof parsed.op !== "string") return refuse(requestId, "MESSAGE_MALFORMED", "The message names no operation.");
    if (parsed.protocol !== LOCAL_SERVICE_PROTOCOL_VERSION) {
      return refuse(
        requestId,
        "PROTOCOL_UNSUPPORTED",
        "The message uses a protocol version this service does not speak.",
        `expected ${LOCAL_SERVICE_PROTOCOL_VERSION}, received ${String(parsed.protocol)}`,
      );
    }

    const op = parsed.op;
    ops.push(op);

    if (op === "handshake") {
      const payload = isRecord(parsed.payload) ? parsed.payload : {};
      const required = Array.isArray(payload.capabilities) ? payload.capabilities : [];
      for (const entry of required) {
        if (typeof entry !== "string") {
          return refuse(requestId, "MESSAGE_MALFORMED", "A required capability is not a name.");
        }
        const supported = entry === LOCAL_SERVICE_CAPABILITY_TARGET && targetCapability;
        if (!supported) {
          return refuse(
            requestId,
            "CAPABILITY_UNSUPPORTED",
            "The local service does not implement a capability this session requires.",
            `requested ${entry}`,
          );
        }
      }

      issued += 1;
      session = { id: `session-${issued}`, token: `token-${issued}`, attached: false, attachedAt: null };
      return ok(requestId, {
        sessionId: session.id,
        token: session.token,
        service: { name: "Nova Local Service", version: "1", protocol: LOCAL_SERVICE_PROTOCOL_VERSION },
        capabilities: capabilities(),
        openedAt: now(),
        sessionsIssued: issued,
      });
    }

    const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : "";
    const token = typeof parsed.token === "string" ? parsed.token : "";
    if (sessionId === "" || token === "") {
      return refuse(requestId, "AUTH_REQUIRED", "This operation needs a local service session.");
    }
    if (session === null || sessionId !== session.id) {
      return refuse(requestId, "SESSION_STALE", "This session has been replaced by a newer one.");
    }
    if (token !== session.token) {
      return refuse(requestId, "AUTH_INVALID", "The session token was not accepted.");
    }
    if (!OPS.has(op)) {
      return refuse(requestId, "OPERATION_UNSUPPORTED", "The local service does not implement this operation.");
    }

    switch (op as LocalServiceOp) {
      case "health":
        return ok(requestId, {
          target: {
            available: true,
            ready: true,
            version: `Nova Local Service 1 (${LOCAL_SERVICE_PROTOCOL_VERSION})`,
          },
          attached: session.attached,
          capabilities: capabilities(),
          sessionId: session.id,
          attachedAt: session.attachedAt,
          sessionsIssued: issued,
        });
      case "attach": {
        if (session.attached) {
          return refuse(requestId, "ALREADY_ATTACHED", "This session is already attached to the local service.");
        }
        session.attached = true;
        session.attachedAt = now();
        return ok(requestId, { attached: true, attachedAt: session.attachedAt });
      }
      case "detach":
        session.attached = false;
        session.attachedAt = null;
        return ok(requestId, { attached: false });
      case "shutdown":
        session = null;
        return ok(requestId, { stopped: true });
      case "handshake":
        return refuse(requestId, "OPERATION_UNSUPPORTED", "Unreachable: handled above.");
    }
  };

  /** Applies the configured fault to an answer that would otherwise be sent. */
  const withFault = (raw: string, answered: string): Promise<string> => {
    switch (fault) {
      case "none":
        return Promise.resolve(answered);
      case "throw":
        return Promise.reject(new Error("the bridge is not answering"));
      case "silent":
        return new Promise<string>(() => undefined);
      case "withheld":
        return new Promise<string>((resolve) => {
          held.push(() => resolve(answered));
        });
      case "garbage":
        return Promise.resolve("<not json>");
      case "oversized":
        return Promise.resolve(
          JSON.stringify({
            protocol: LOCAL_SERVICE_PROTOCOL_VERSION,
            requestId: "",
            ok: true,
            payload: { pad: "x".repeat(LOCAL_SERVICE_MAX_MESSAGE_BYTES) },
          }),
        );
      case "mismatched":
        return Promise.resolve(
          JSON.stringify({
            protocol: LOCAL_SERVICE_PROTOCOL_VERSION,
            requestId: "someone-elses-request",
            ok: true,
            payload: {},
          }),
        );
      case "wrong-protocol": {
        const parsed = JSON.parse(raw) as { requestId?: string };
        return Promise.resolve(
          JSON.stringify({
            protocol: "NOVA_LOCAL_SERVICE_V0",
            requestId: parsed.requestId ?? "",
            ok: true,
            payload: {},
          }),
        );
      }
    }
  };

  return {
    transport: {
      kind: "Fake IPC",
      available,
      send: (message) => {
        if (!available) return Promise.reject(new Error("Nova is not running in its desktop shell."));
        // "silent" and "throw" both model a request that never arrives, so the
        // service neither records it nor acts on it. "withheld" is the other
        // half of the problem — the request lands and only the answer is lost —
        // and between them they cover both ways a round trip can go wrong.
        if (fault === "silent" || fault === "throw") {
          messages.push(message);
          return fault === "throw"
            ? Promise.reject(new Error("the bridge is not answering"))
            : new Promise<string>(() => undefined);
        }
        return withFault(message, answer(message));
      },
    },
    ops: () => ops,
    messages: () => messages,
    currentToken: () => session?.token ?? null,
    currentSessionId: () => session?.id ?? null,
    isAttached: () => session?.attached ?? false,
    sessionsIssued: () => issued,
    endSession: () => {
      session = null;
    },
    loseAttachment: () => {
      if (session !== null) {
        session.attached = false;
        session.attachedAt = null;
      }
    },
    setFault: (next) => {
      fault = next;
    },
    releaseAnswers: () => {
      for (const deliver of held.splice(0)) deliver();
    },
    setTargetCapability: (supported) => {
      targetCapability = supported;
    },
  };
}
