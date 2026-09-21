import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createFakeStudioClient } from "@/features/bridge/fakeStudio";
import { createFakeTransport, type FakeBridgeTransport } from "@/features/bridge/fakeTransport";
import { createPairingController } from "@/features/bridge/pairing";
import { createEnvelope, decodeMessage, encodeMessage, MAX_MESSAGE_BYTES, PROTOCOL_VERSION } from "@/features/bridge/protocol";
import { createStudioBridge, type BridgeLog, type StudioBridge } from "@/features/bridge/session";
import { createFakeClock, type FakeClock } from "@/lib/testing/fakeClock";

const HEARTBEAT_MS = 10_000;
const STALE_MS = 30_000;
const PAIRING_TTL = 60_000;

interface LogLine {
  level: keyof BridgeLog;
  message: string;
}

function recordingLog(): BridgeLog & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  const at = (level: keyof BridgeLog) => (message: string) => {
    lines.push({ level, message });
  };
  return { lines, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

interface Harness {
  bridge: StudioBridge;
  transport: FakeBridgeTransport;
  clock: FakeClock;
  log: BridgeLog & { lines: LogLine[] };
}

function setup(): Harness {
  const clock = createFakeClock();
  const log = recordingLog();
  const transport = createFakeTransport();
  let counter = 0;
  const bridge = createStudioBridge({
    transport,
    clock,
    log,
    serverVersion: "test",
    createId: () => `id-${++counter}`,
    createSecret: () => `secret-${"a".repeat(48)}-${++counter}`,
    random: () => 0.481273,
    heartbeatIntervalMs: HEARTBEAT_MS,
    heartbeatTimeoutMs: STALE_MS,
    pairingTtlMs: PAIRING_TTL,
  });
  return { bridge, transport, clock, log };
}

/** Starts the bridge, opens pairing and pairs a fake plugin. */
async function connected(harness: Harness) {
  await harness.bridge.start({ port: 1234 });
  const { code } = harness.bridge.offerPairing();
  const studio = createFakeStudioClient({ transport: harness.transport });
  await studio.hello();
  const response = await studio.pair(code);
  return { studio, code, response };
}

describe("studio bridge lifecycle", () => {
  test("starts stopped and never claims a connection it does not have", () => {
    const { bridge } = setup();
    const snapshot = bridge.getSnapshot();
    assert.equal(snapshot.phase, "stopped");
    assert.equal(snapshot.listening, false);
    assert.equal(snapshot.studioConnected, false);
    assert.equal(snapshot.session, null);
    assert.equal(snapshot.address, null);
    assert.equal(snapshot.protocolVersion, PROTOCOL_VERSION);
  });

  test("listening is not the same state as connected", async () => {
    const { bridge, log } = setup();
    assert.equal(await bridge.start({ port: 1234 }), true);

    const snapshot = bridge.getSnapshot();
    assert.equal(snapshot.phase, "listening");
    assert.equal(snapshot.listening, true);
    assert.equal(snapshot.studioConnected, false, "no Studio has connected yet");
    assert.ok(log.lines.some((line) => line.message.startsWith("Studio bridge listening")));
  });

  test("starting twice keeps one listener", async () => {
    const { bridge } = setup();
    await bridge.start({ port: 1234 });
    const address = bridge.getSnapshot().address;
    assert.equal(await bridge.start({ port: 1234 }), true);
    assert.equal(bridge.getSnapshot().address, address);
  });

  test("stopping twice is harmless", async () => {
    const { bridge } = setup();
    await bridge.start({ port: 1234 });
    await bridge.stop();
    await bridge.stop();
    assert.equal(bridge.getSnapshot().phase, "stopped");
    assert.equal(bridge.getSnapshot().listening, false);
  });

  test("a bind failure is reported as a structured bridge error", async () => {
    const clock = createFakeClock();
    const transport = createFakeTransport();
    transport.start = () => Promise.reject(new Error("address already in use"));
    const bridge = createStudioBridge({ transport, clock, log: recordingLog(), serverVersion: "test" });

    assert.equal(await bridge.start({ port: 1234 }), false);
    const snapshot = bridge.getSnapshot();
    assert.equal(snapshot.phase, "error");
    assert.equal(snapshot.error?.code, "PORT_IN_USE");
    assert.equal(snapshot.listening, false);
  });

  test("subscribers are notified on every state change", async () => {
    const { bridge } = setup();
    let notifications = 0;
    const unsubscribe = bridge.subscribe(() => {
      notifications += 1;
    });
    await bridge.start({ port: 1234 });
    assert.ok(notifications >= 2, "starting and listening both publish");
    unsubscribe();
    const seen = notifications;
    await bridge.stop();
    assert.equal(notifications, seen, "unsubscribed listeners stop hearing");
  });
});

describe("studio bridge handshake and pairing", () => {
  test("hello answers with server metadata and demands pairing", async () => {
    const { bridge, transport } = setup();
    await bridge.start({ port: 1234 });
    const studio = createFakeStudioClient({ transport });

    const ack = await studio.hello();
    assert.equal(ack.type, "hello_ack");
    assert.equal(ack.payload.requiresPairing, true);
    assert.equal(ack.payload.protocolVersion, PROTOCOL_VERSION);
    assert.equal(ack.payload.serverType, "nova");
    assert.equal(ack.payload.busy, false);
    assert.equal(bridge.getSnapshot().phase, "connecting", "a plugin is handshaking");
    assert.equal(bridge.getSnapshot().studioConnected, false);
  });

  test("a correct pairing code establishes an authenticated session", async () => {
    const harness = setup();
    const { studio, response } = await connected(harness);

    assert.equal(response.type, "pair_response");
    assert.equal(response.payload.ok, true);
    assert.equal(typeof response.payload.sessionToken, "string");
    assert.ok(studio.token && studio.token.length >= 16, "the session token is long and random");

    const snapshot = harness.bridge.getSnapshot();
    assert.equal(snapshot.phase, "connected");
    assert.equal(snapshot.studioConnected, true);
    assert.equal(snapshot.session?.clientType, "roblox-studio");
    assert.equal(snapshot.pairing, null, "the code is single use and is cleared");
  });

  test("the pairing code never reaches the log", async () => {
    const harness = setup();
    const { code } = await connected(harness);
    for (const line of harness.log.lines) {
      assert.ok(!line.message.includes(code), `code leaked in: ${line.message}`);
    }
  });

  test("a wrong code is refused and does not connect", async () => {
    const harness = setup();
    await harness.bridge.start({ port: 1234 });
    const { code } = harness.bridge.offerPairing();
    const studio = createFakeStudioClient({ transport: harness.transport });
    await studio.hello();

    const wrong = code === "000000" ? "111111" : "000000";
    const response = await studio.pair(wrong);
    assert.equal(response.payload.ok, false);
    assert.deepEqual((response.payload.error as { code: string }).code, "AUTHENTICATION_FAILED");
    assert.equal(harness.bridge.getSnapshot().studioConnected, false);
    assert.equal(studio.token, null);
  });

  test("an expired code no longer pairs", async () => {
    const harness = setup();
    await harness.bridge.start({ port: 1234 });
    const { code } = harness.bridge.offerPairing();
    await harness.clock.advance(PAIRING_TTL);

    const studio = createFakeStudioClient({ transport: harness.transport });
    await studio.hello();
    const response = await studio.pair(code);

    assert.equal(response.payload.ok, false);
    assert.equal((response.payload.error as { code: string }).code, "PAIRING_EXPIRED");
    assert.equal(harness.bridge.getSnapshot().studioConnected, false);
  });

  test("repeated wrong codes lock the offer out", async () => {
    const harness = setup();
    await harness.bridge.start({ port: 1234 });
    const { code } = harness.bridge.offerPairing();
    const studio = createFakeStudioClient({ transport: harness.transport });
    await studio.hello();

    for (let attempt = 0; attempt < 5; attempt += 1) await studio.pair("999999");
    const response = await studio.pair(code);

    assert.equal(response.payload.ok, false, "the real code is dead after the lockout");
    assert.equal((response.payload.error as { code: string }).code, "PAIRING_EXPIRED");
    assert.equal(harness.bridge.getSnapshot().studioConnected, false);
  });

  test("pairing without an open offer is refused", async () => {
    const harness = setup();
    await harness.bridge.start({ port: 1234 });
    const studio = createFakeStudioClient({ transport: harness.transport });
    await studio.hello();

    const response = await studio.pair("123456");
    assert.equal(response.payload.ok, false);
    assert.equal(harness.bridge.getSnapshot().studioConnected, false);
  });

  test("only one Studio session is active at a time", async () => {
    const harness = setup();
    await connected(harness);

    const second = createFakeStudioClient({ transport: harness.transport, clientType: "other-studio" });
    const ack = await second.hello();
    assert.equal(ack.payload.busy, true, "the second client is told Nova is taken");

    harness.bridge.offerPairing();
    const response = await second.pair(harness.bridge.getSnapshot().pairing?.code ?? "");
    assert.equal(response.payload.ok, false);
    assert.equal((response.payload.error as { code: string }).code, "SESSION_REPLACED");
    assert.equal(harness.bridge.getSnapshot().session?.clientType, "roblox-studio", "the first session survives");
  });
});

describe("studio bridge authentication", () => {
  test("an unauthenticated client cannot poll for pushed messages", async () => {
    const harness = setup();
    await connected(harness);

    const response = await harness.transport.pluginPoll("not-the-token");
    assert.equal(response.status, 401);
  });

  test("a wrong token cannot act on an established session", async () => {
    const harness = setup();
    await connected(harness);

    const forged = encodeMessage(createEnvelope({ type: "execute_started", messageId: "x", timestamp: 1, payload: { executionId: "e1" } }));
    const response = await harness.transport.pluginSend(forged, "stolen-token");
    const decoded = decodeMessage(response.body);

    assert.equal(decoded.ok && decoded.envelope.type, "error");
    assert.equal(decoded.ok && decoded.envelope.payload.code, "AUTHENTICATION_FAILED");
    assert.equal(harness.bridge.getSnapshot().studioConnected, true, "the real session is untouched");
  });

  test("the handshake still works while another session holds the bridge", async () => {
    const harness = setup();
    await connected(harness);

    const second = createFakeStudioClient({ transport: harness.transport, clientType: "other-studio" });
    const ack = await second.hello();
    assert.equal(ack.payload.busy, true, "a second plugin is told the bridge is taken, not silently dropped");
  });

  test("protocol messages are refused before a session exists", async () => {
    const harness = setup();
    await harness.bridge.start({ port: 1234 });

    const message = encodeMessage(createEnvelope({ type: "execute_started", messageId: "x", timestamp: 1, payload: { executionId: "e1" } }));
    const response = await harness.transport.pluginSend(message, null);
    const decoded = decodeMessage(response.body);

    assert.equal(decoded.ok && decoded.envelope.type, "error");
    assert.equal(decoded.ok && decoded.envelope.payload.code, "SESSION_EXPIRED");
  });

  test("malformed messages are rejected without crashing the bridge", async () => {
    const harness = setup();
    const { studio } = await connected(harness);

    const malformed = ["", "{", "[]", JSON.stringify({ protocol: "OTHER", type: "ping", messageId: "1", timestamp: 1, payload: {} })];
    for (const raw of malformed) {
      const response = await harness.transport.pluginSend(raw, studio.token);
      const decoded = decodeMessage(response.body);
      assert.equal(decoded.ok && decoded.envelope.type, "error", `raw: ${raw}`);
    }

    assert.equal(harness.bridge.getSnapshot().studioConnected, true, "the session is unaffected");
  });

  test("an oversized message is refused rather than truncated", async () => {
    const harness = setup();
    const { studio } = await connected(harness);

    const huge = encodeMessage(
      createEnvelope({ type: "execute_output", messageId: "x", timestamp: 1, payload: { message: "x".repeat(MAX_MESSAGE_BYTES + 1024) } }),
    );
    const response = await harness.transport.pluginSend(huge, studio.token);
    const decoded = decodeMessage(response.body);

    assert.equal(decoded.ok && decoded.envelope.payload.code, "REQUEST_TOO_LARGE");
    assert.equal(harness.bridge.getSnapshot().studioConnected, true);
  });
});

describe("studio bridge heartbeat", () => {
  test("ping/pong measures real round-trip latency", async () => {
    const harness = setup();
    const { studio } = await connected(harness);

    await harness.clock.advance(HEARTBEAT_MS);
    const pushed = await studio.pump();
    assert.equal(pushed?.type, "ping");

    const snapshot = harness.bridge.getSnapshot();
    assert.equal(snapshot.latencyMs, 0, "the fake clock does not advance during the round trip");
    assert.equal(snapshot.lastHeartbeatAt, harness.clock.now());
  });

  test("a Studio that stops answering is detected and disconnected", async () => {
    const harness = setup();
    await connected(harness);

    await harness.clock.advance(STALE_MS - 1);
    assert.equal(harness.bridge.getSnapshot().studioConnected, true);

    await harness.clock.advance(1);
    const snapshot = harness.bridge.getSnapshot();
    assert.equal(snapshot.studioConnected, false);
    assert.equal(snapshot.phase, "listening", "the bridge stays up and can be paired again");
    assert.equal(snapshot.error?.code, "HEARTBEAT_TIMEOUT");
  });

  test("polling keeps the session alive", async () => {
    const harness = setup();
    const { studio } = await connected(harness);

    for (let round = 0; round < 4; round += 1) {
      await harness.clock.advance(HEARTBEAT_MS);
      await studio.pump();
    }

    assert.equal(harness.bridge.getSnapshot().studioConnected, true);
  });

  test("a graceful plugin disconnect returns the bridge to listening", async () => {
    const harness = setup();
    const { studio } = await connected(harness);

    await studio.disconnect();

    const snapshot = harness.bridge.getSnapshot();
    assert.equal(snapshot.studioConnected, false);
    assert.equal(snapshot.phase, "listening");
    assert.equal(snapshot.error, null, "a requested disconnect is not an error");
  });

  test("a transport failure tears the session down", async () => {
    const harness = setup();
    await connected(harness);

    harness.transport.crash("listener closed");

    const snapshot = harness.bridge.getSnapshot();
    assert.equal(snapshot.studioConnected, false);
    assert.equal(snapshot.phase, "error");
    assert.equal(snapshot.error?.code, "TRANSPORT_ERROR");
  });

  test("stopping the bridge clears timers and the session", async () => {
    const harness = setup();
    await connected(harness);
    await harness.bridge.stop();

    assert.equal(harness.clock.pendingTimers(), 0, "no heartbeat or staleness timer is left running");
    assert.equal(harness.bridge.getSnapshot().studioConnected, false);
    assert.equal(harness.bridge.getSnapshot().phase, "stopped");
  });
});

describe("pairing controller", () => {
  test("codes are single use", () => {
    const clock = createFakeClock();
    const pairing = createPairingController({ clock, random: () => 0.5, ttlMs: 1000, maxAttempts: 3 });
    const { code } = pairing.begin();

    assert.equal(pairing.verify(code), "ok");
    assert.equal(pairing.current(), null);
    assert.equal(pairing.verify(code), "none", "the same code cannot be replayed");
  });

  test("codes expire", async () => {
    const clock = createFakeClock();
    const pairing = createPairingController({ clock, random: () => 0.5, ttlMs: 1000, maxAttempts: 3 });
    const { code } = pairing.begin();
    await clock.advance(1000);
    assert.equal(pairing.verify(code), "expired");
  });

  test("wrong attempts lock the code out before it can be guessed", () => {
    const clock = createFakeClock();
    const pairing = createPairingController({ clock, random: () => 0.5, ttlMs: 10_000, maxAttempts: 3 });
    const { code } = pairing.begin();

    assert.equal(pairing.verify("000001"), "invalid");
    assert.equal(pairing.verify("000002"), "invalid");
    assert.equal(pairing.verify("000003"), "locked");
    assert.equal(pairing.verify(code), "none");
  });

  test("a new offer replaces the previous code", () => {
    const clock = createFakeClock();
    let value = 0.111111;
    const pairing = createPairingController({ clock, random: () => value, ttlMs: 10_000 });
    const first = pairing.begin();
    value = 0.222222;
    const second = pairing.begin();

    assert.notEqual(first.code, second.code);
    assert.equal(pairing.verify(first.code), "invalid");
  });

  test("codes are six digits", () => {
    const clock = createFakeClock();
    for (const value of [0, 0.5, 0.999999]) {
      const pairing = createPairingController({ clock, random: () => value });
      assert.match(pairing.begin().code, /^\d{6}$/);
    }
  });
});
