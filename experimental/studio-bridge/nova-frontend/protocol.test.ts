import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BRIDGE_MESSAGE_TYPES,
  byteLength,
  createEnvelope,
  decodeMessage,
  encodeMessage,
  MAX_MESSAGE_BYTES,
  MAX_SOURCE_BYTES,
  PROTOCOL_VERSION,
  readNumber,
  readString,
  readStringArray,
} from "@/features/bridge/protocol";

const envelope = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    protocol: PROTOCOL_VERSION,
    type: "ping",
    messageId: "m1",
    timestamp: 1700000000000,
    payload: {},
    ...overrides,
  });

describe("bridge protocol", () => {
  test("round-trips a message", () => {
    const message = createEnvelope({ type: "execute_request", messageId: "m1", timestamp: 42, requestId: "r1", payload: { source: "print('hi')" } });
    const decoded = decodeMessage(encodeMessage(message));

    assert.equal(decoded.ok, true);
    assert.deepEqual(decoded.ok && decoded.envelope, message);
    assert.equal(message.protocol, PROTOCOL_VERSION);
  });

  test("omits requestId when there is nothing to correlate", () => {
    const message = createEnvelope({ type: "ping", messageId: "m1", timestamp: 1 });
    assert.ok(!("requestId" in message));
    assert.deepEqual(message.payload, {});
  });

  test("every declared message type survives a round trip", () => {
    for (const type of BRIDGE_MESSAGE_TYPES) {
      const decoded = decodeMessage(encodeMessage(createEnvelope({ type, messageId: "m", timestamp: 1 })));
      assert.equal(decoded.ok && decoded.envelope.type, type);
    }
  });

  test("rejects data that is not JSON", () => {
    const decoded = decodeMessage("{not json");
    assert.equal(decoded.ok, false);
    assert.equal(!decoded.ok && decoded.error.code, "INVALID_MESSAGE");
  });

  test("rejects structurally malformed messages", () => {
    const cases: [string, string][] = [
      ["[]", "not an object"],
      [envelope({ type: "not_a_type" }), "unknown type"],
      [envelope({ type: undefined }), "missing type"],
      [envelope({ messageId: 7 }), "bad messageId"],
      [envelope({ messageId: "" }), "empty messageId"],
      [envelope({ timestamp: "soon" }), "bad timestamp"],
      [envelope({ payload: "text" }), "payload not an object"],
      [envelope({ payload: [] }), "payload is an array"],
      [envelope({ requestId: 5 }), "bad requestId"],
    ];

    for (const [raw, label] of cases) {
      const decoded = decodeMessage(raw);
      assert.equal(decoded.ok, false, label);
      assert.equal(!decoded.ok && decoded.error.code, "INVALID_MESSAGE", label);
    }
  });

  test("an incompatible protocol version is reported distinctly", () => {
    const decoded = decodeMessage(envelope({ protocol: "NOVA_STUDIO_BRIDGE_V2" }));
    assert.equal(decoded.ok, false);
    assert.equal(!decoded.ok && decoded.error.code, "UNSUPPORTED_PROTOCOL");
    assert.match(String(!decoded.ok && decoded.error.details), /NOVA_STUDIO_BRIDGE_V2/);
  });

  test("oversized messages are refused, not truncated", () => {
    const big = envelope({ payload: { source: "x".repeat(2048) } });
    const decoded = decodeMessage(big, { maxBytes: 1024 });
    assert.equal(decoded.ok, false);
    assert.equal(!decoded.ok && decoded.error.code, "REQUEST_TOO_LARGE");
    assert.ok(MAX_MESSAGE_BYTES > MAX_SOURCE_BYTES, "the envelope limit leaves room above the source limit");
  });

  test("byteLength counts UTF-8 bytes, not code units", () => {
    assert.equal(byteLength("abc"), 3);
    assert.equal(byteLength("é"), 2);
    assert.equal(byteLength("🙂"), 4);
  });

  test("payload readers are defensive about types", () => {
    const payload = { name: "Main.lua", lines: 12, tags: ["a", 3, "b"], wrong: {} };
    assert.equal(readString(payload, "name"), "Main.lua");
    assert.equal(readString(payload, "lines"), null);
    assert.equal(readString(payload, "missing"), null);
    assert.equal(readNumber(payload, "lines"), 12);
    assert.equal(readNumber(payload, "name"), null);
    assert.deepEqual(readStringArray(payload, "tags"), ["a", "b"]);
    assert.deepEqual(readStringArray(payload, "wrong"), []);
    assert.deepEqual(readStringArray(payload, "missing"), []);
  });
});
