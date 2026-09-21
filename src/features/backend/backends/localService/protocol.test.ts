import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  byteLength,
  createRequest,
  decodeResponse,
  encodeRequest,
  isSessionLost,
  LOCAL_SERVICE_CLIENT_ERROR_CODES,
  LOCAL_SERVICE_MAX_MESSAGE_BYTES,
  LOCAL_SERVICE_OPS,
  LOCAL_SERVICE_PROTOCOL_VERSION,
  LOCAL_SERVICE_WIRE_ERROR_CODES,
  readAttached,
  readHealth,
  readSessionOpened,
} from "@/features/backend/backends/localService/protocol";

/**
 * The wire protocol, on its own.
 *
 * Nothing here has a transport, a clock or a session: these are the rules that
 * decide whether a message may be trusted at all, and they are the half of the
 * agreement Nova is responsible for. The service's half is tested by
 * `cargo test`, and `protocolParity.test.ts` checks the two agree on the
 * constants that cannot be checked at runtime.
 *
 * What is deliberately checked here rather than anywhere else: that a malformed
 * answer is refused rather than half-read, and that every reader rejects a
 * payload with a field of the wrong type instead of producing a value with
 * `undefined` in it.
 */

const REQUEST_ID = "request-1";

const response = (body: Record<string, unknown>) =>
  JSON.stringify({ protocol: LOCAL_SERVICE_PROTOCOL_VERSION, requestId: REQUEST_ID, ...body });

const openedPayload = () => ({
  sessionId: "session-1",
  token: "token-1",
  service: { name: "Nova Local Service", version: "1", protocol: LOCAL_SERVICE_PROTOCOL_VERSION },
  capabilities: { target: true, debugger: false, profiler: false, execute: false },
  openedAt: 1_700_000_000_000,
  sessionsIssued: 1,
});

const healthPayload = () => ({
  target: { available: true, ready: true, version: "Nova Local Service 1" },
  attached: false,
  capabilities: { target: true, debugger: false, profiler: false, execute: false },
  sessionId: "session-1",
  attachedAt: null,
  sessionsIssued: 1,
});

describe("the local service request envelope", () => {
  test("a request names the protocol, the operation and the request it is", () => {
    const request = createRequest({ op: "health", requestId: REQUEST_ID, sessionId: "s", token: "t" });
    assert.deepEqual(request, {
      protocol: LOCAL_SERVICE_PROTOCOL_VERSION,
      op: "health",
      requestId: REQUEST_ID,
      sessionId: "s",
      token: "t",
      payload: {},
    });
  });

  test("a handshake carries no session, because it is the request that issues one", () => {
    const request = createRequest({ op: "handshake", requestId: REQUEST_ID });
    assert.equal(request.sessionId, null);
    assert.equal(request.token, null);
  });

  test("every operation has a name and they are all distinct", () => {
    assert.equal(new Set(LOCAL_SERVICE_OPS).size, LOCAL_SERVICE_OPS.length);
    assert.ok(LOCAL_SERVICE_OPS.includes("handshake"));
  });

  test("no error code is claimed by both sides", () => {
    const wire = new Set<string>(LOCAL_SERVICE_WIRE_ERROR_CODES);
    for (const code of LOCAL_SERVICE_CLIENT_ERROR_CODES) {
      assert.ok(!wire.has(code), `${code} must belong to exactly one side`);
    }
  });

  test("byte length counts bytes, not characters", () => {
    assert.equal(byteLength("abc"), 3);
    assert.ok(byteLength("→") > 1, "a multi-byte character costs more than one byte");
  });

  test("encoding a request round-trips through JSON", () => {
    const request = createRequest({ op: "attach", requestId: REQUEST_ID, sessionId: "s", token: "t" });
    assert.deepEqual(JSON.parse(encodeRequest(request)), request);
  });
});

describe("reading what the local service answered", () => {
  test("a successful answer yields its payload", () => {
    const decoded = decodeResponse(response({ ok: true, payload: { attached: true } }), REQUEST_ID);
    assert.equal(decoded.ok, true);
    assert.deepEqual(decoded.ok ? decoded.value : null, { attached: true });
  });

  test("a refusal yields the service's own code", () => {
    const decoded = decodeResponse(
      response({ ok: false, error: { code: "AUTH_INVALID", message: "no", details: "why" } }),
      REQUEST_ID,
    );
    assert.equal(decoded.ok, false);
    assert.equal(decoded.ok ? null : decoded.error.code, "AUTH_INVALID");
    assert.equal(decoded.ok ? null : decoded.error.details, "why");
  });

  test("an answer naming a different request is discarded, not applied", () => {
    const decoded = decodeResponse(response({ ok: true, payload: {} }), "request-2");
    assert.equal(decoded.ok, false);
    assert.equal(decoded.ok ? null : decoded.error.code, "RESPONSE_MISMATCHED");
  });

  test("an answer in another protocol version is refused distinctly", () => {
    const raw = JSON.stringify({ protocol: "NOVA_LOCAL_SERVICE_V0", requestId: REQUEST_ID, ok: true, payload: {} });
    const decoded = decodeResponse(raw, REQUEST_ID);
    assert.equal(decoded.ok ? null : decoded.error.code, "PROTOCOL_UNSUPPORTED");
  });

  test("anything that is not a well-formed answer is refused rather than half-read", () => {
    const cases: [string, string][] = [
      ["<not json>", "not JSON at all"],
      ["[]", "an array"],
      ["null", "null"],
      [response({ ok: true }), "a result with no payload"],
      [response({ ok: true, payload: "text" }), "a payload that is not an object"],
      [response({ ok: "yes", payload: {} }), "neither a result nor a refusal"],
      [response({ ok: false }), "a refusal with no error"],
      [response({ ok: false, error: { code: "NOPE", message: "m" } }), "a code the protocol does not define"],
      [response({ ok: false, error: { code: "AUTH_INVALID" } }), "a refusal with no message"],
      [response({ ok: false, error: { code: "AUTH_INVALID", message: "" } }), "a refusal with an empty message"],
    ];
    for (const [raw, why] of cases) {
      const decoded = decodeResponse(raw, REQUEST_ID);
      assert.equal(decoded.ok, false, why);
      assert.equal(decoded.ok ? null : decoded.error.code, "RESPONSE_MALFORMED", why);
    }
  });

  test("an answer larger than the protocol allows is refused without being parsed", () => {
    const raw = "x".repeat(LOCAL_SERVICE_MAX_MESSAGE_BYTES + 1);
    const decoded = decodeResponse(raw, REQUEST_ID);
    assert.equal(decoded.ok ? null : decoded.error.code, "RESPONSE_MALFORMED");
  });
});

describe("reading a handshake", () => {
  test("a complete handshake yields the session, and the token separately", () => {
    const opened = readSessionOpened(openedPayload());
    assert.ok(opened !== null);
    assert.equal(opened.token, "token-1");
    assert.equal(opened.info.sessionId, "session-1");
    assert.equal(opened.info.capabilities.debugger, false);
    assert.equal(opened.info.sessionsIssued, 1);
  });

  test("the session a handshake yields has no field a token could live in", () => {
    const opened = readSessionOpened(openedPayload());
    assert.ok(opened !== null);
    assert.ok(!Object.keys(opened.info).includes("token"), "the info must not carry the secret");
    assert.ok(!JSON.stringify(opened.info).includes("token-1"), "and must not contain it anywhere");
  });

  test("a handshake missing any part of itself is not read at all", () => {
    const required = ["sessionId", "token", "service", "capabilities", "openedAt", "sessionsIssued"] as const;
    for (const field of required) {
      const payload: Record<string, unknown> = openedPayload();
      delete payload[field];
      assert.equal(readSessionOpened(payload), null, `without ${field}`);
    }
    assert.equal(readSessionOpened({ ...openedPayload(), sessionId: "" }), null, "an empty session id");
    assert.equal(readSessionOpened({ ...openedPayload(), token: "" }), null, "an empty token");
    assert.equal(readSessionOpened({ ...openedPayload(), openedAt: "soon" }), null, "a non-numeric timestamp");
    assert.equal(
      readSessionOpened({ ...openedPayload(), capabilities: { target: true } }),
      null,
      "a partial capability set",
    );
    assert.equal(readSessionOpened(null), null);
  });
});

describe("reading health and attachment", () => {
  test("a complete health report is read", () => {
    const health = readHealth(healthPayload());
    assert.ok(health !== null);
    assert.equal(health.target.available, true);
    assert.equal(health.attached, false);
    assert.equal(health.sessionId, "session-1");
    assert.equal(health.attachedAt, null);
  });

  test("health with a field of the wrong type is refused rather than guessed at", () => {
    for (const payload of [
      { ...healthPayload(), target: { available: "yes", ready: true, version: "v" } },
      { ...healthPayload(), target: { available: true, ready: true, version: "" } },
      { ...healthPayload(), attached: "no" },
      { ...healthPayload(), capabilities: null },
      { ...healthPayload(), sessionsIssued: "one" },
    ]) {
      assert.equal(readHealth(payload), null, JSON.stringify(payload).slice(0, 60));
    }
  });

  test("an attachment is only read when the service says it happened", () => {
    assert.deepEqual(readAttached({ attached: true, attachedAt: 5 }), { attachedAt: 5 });
    assert.equal(readAttached({ attached: false, attachedAt: 5 }), null);
    assert.equal(readAttached({ attached: true }), null);
    assert.equal(readAttached({ attached: true, attachedAt: "now" }), null);
  });
});

describe("which refusals mean the session is gone", () => {
  test("exactly the three that describe a session rather than an operation", () => {
    assert.ok(isSessionLost("SESSION_STALE"));
    assert.ok(isSessionLost("AUTH_INVALID"));
    assert.ok(isSessionLost("AUTH_REQUIRED"));
    for (const code of ["ALREADY_ATTACHED", "OPERATION_UNSUPPORTED", "REQUEST_TIMEOUT", "TRANSPORT_FAILED"] as const) {
      assert.ok(!isSessionLost(code), `${code} is a failed operation, not a lost session`);
    }
  });
});
