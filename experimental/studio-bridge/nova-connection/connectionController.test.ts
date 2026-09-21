import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createConnectionController, type ConnectionLog } from "@/features/connection/connectionController";
import {
  canTransitionConnection,
  CONNECTION_STATUSES,
  InvalidConnectionTransitionError,
  transitionConnection,
} from "@/features/connection/connectionState";
import {
  createMockConnectionProvider,
  type MockConnectionScenario,
} from "@/features/connection/providers/MockConnectionProvider";
import type { ConnectionProvider, ConnectionStatus } from "@/features/connection/types";
import { createFakeClock } from "@/lib/testing/fakeClock";

const CONNECT_MS = 300;
const DISCONNECT_MS = 100;
const OPTIONS = { timeoutMs: 2000 };

function recordingLog(): ConnectionLog & { lines: { level: string; message: string }[] } {
  const lines: { level: string; message: string }[] = [];
  const at = (level: string) => (message: string) => {
    lines.push({ level, message });
  };
  return { lines, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

function setup(scenario: MockConnectionScenario = "success") {
  const clock = createFakeClock();
  const log = recordingLog();
  const mock = createMockConnectionProvider({
    clock,
    scenario,
    connectMs: CONNECT_MS,
    disconnectMs: DISCONNECT_MS,
    slowConnectMs: 60_000,
    random: () => 0.5,
  });
  const calls = { connect: 0, disconnect: 0 };
  const provider: ConnectionProvider = {
    ...mock,
    connect: () => {
      calls.connect += 1;
      return mock.connect();
    },
    disconnect: () => {
      calls.disconnect += 1;
      return mock.disconnect();
    },
  };
  const controller = createConnectionController({ provider, clock, log });

  /** Status changes, starting from the initial disconnected state. */
  const statuses: ConnectionStatus[] = [];
  let last = controller.getSnapshot().status;
  controller.subscribe(() => {
    const { status } = controller.getSnapshot();
    if (status !== last) statuses.push(status);
    last = status;
  });

  /** A controller that says "connected" must be backed by a connected provider. */
  const assertConsistent = () => {
    if (controller.getSnapshot().status === "connected") assert.equal(mock.getStatus(), "connected");
    if (mock.getStatus() === "connected") assert.equal(controller.getSnapshot().status, "connected");
  };

  return { clock, log, mock, calls, controller, statuses, assertConsistent };
}

describe("connection state machine", () => {
  test("allows the documented lifecycle", () => {
    const path: ConnectionStatus[] = ["disconnected", "connecting", "connected", "disconnecting", "disconnected"];
    assert.equal(
      path.reduce((from, to) => transitionConnection(from, to)),
      "disconnected",
    );
    assert.equal(transitionConnection("connecting", "error"), "error");
    assert.equal(transitionConnection("error", "connecting"), "connecting");
    assert.equal(transitionConnection("error", "disconnected"), "disconnected");
    assert.equal(transitionConnection("connecting", "disconnecting"), "disconnecting");
  });

  test("rejects impossible transitions", () => {
    const invalid: [ConnectionStatus, ConnectionStatus][] = [
      ["disconnected", "connected"],
      ["disconnected", "disconnecting"],
      ["disconnected", "error"],
      ["connected", "connecting"],
      ["connected", "disconnected"],
      ["disconnecting", "connected"],
      ["disconnecting", "connecting"],
      ["error", "connected"],
    ];
    for (const [from, to] of invalid) {
      assert.throws(() => transitionConnection(from, to), InvalidConnectionTransitionError, `${from} → ${to}`);
    }
    for (const status of CONNECTION_STATUSES) assert.equal(canTransitionConnection(status, status), false);
  });
});

describe("connection controller", () => {
  test("starts disconnected, as after every restart", () => {
    const { controller, mock } = setup();
    assert.deepEqual(controller.getSnapshot(), {
      status: "disconnected",
      latencyMs: null,
      latencySimulated: false,
      connectedAt: null,
      error: null,
    });
    assert.equal(mock.getStatus(), "disconnected");
    assert.equal(controller.provider.label, "Local Test");
  });

  test("connect goes connecting → connected with simulated latency", async () => {
    const { controller, clock, log, statuses, assertConsistent } = setup();
    const connected = controller.connect(OPTIONS);

    assert.equal(controller.getSnapshot().status, "connecting");
    assertConsistent();
    await clock.advance(CONNECT_MS);

    assert.equal(await connected, true);
    assert.deepEqual(statuses, ["connecting", "connected"]);
    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.latencyMs, 12);
    assert.equal(snapshot.latencySimulated, true);
    assert.equal(snapshot.connectedAt, clock.now());
    assert.equal(snapshot.error, null);
    assert.equal(clock.pendingTimers(), 0, "the timeout timer is cleared");
    assertConsistent();
    assert.deepEqual(
      log.lines.filter((line) => line.level !== "debug").map((line) => line.message),
      ["Connecting to the Local Test provider", "Connected to the Local Test provider"],
    );
  });

  test("disconnect goes disconnecting → disconnected", async () => {
    const { controller, clock, statuses, log, assertConsistent } = setup();
    controller.connect(OPTIONS);
    await clock.advance(CONNECT_MS);

    const done = controller.disconnect();
    assert.equal(controller.getSnapshot().status, "disconnecting");
    await clock.advance(DISCONNECT_MS);
    await done;

    assert.deepEqual(statuses, ["connecting", "connected", "disconnecting", "disconnected"]);
    assert.equal(controller.getSnapshot().latencyMs, null);
    assert.equal(controller.getSnapshot().connectedAt, null);
    assert.ok(log.lines.some((line) => line.message === "Disconnected from the Local Test provider"));
    assertConsistent();
    assert.equal(clock.pendingTimers(), 0);
  });

  test("repeated connect does not start a second attempt", async () => {
    const { controller, clock, calls } = setup();
    const first = controller.connect(OPTIONS);
    assert.equal(await controller.connect(OPTIONS), false, "while connecting");
    await clock.advance(CONNECT_MS);
    assert.equal(await first, true);
    assert.equal(await controller.connect(OPTIONS), false, "while connected");

    assert.equal(calls.connect, 1);
    assert.equal(controller.getSnapshot().status, "connected");
  });

  test("repeated disconnect is harmless", async () => {
    const { controller, clock, calls, statuses } = setup();
    await controller.disconnect();
    assert.deepEqual(statuses, [], "disconnecting while disconnected changes nothing");
    assert.equal(calls.disconnect, 0);

    controller.connect(OPTIONS);
    await clock.advance(CONNECT_MS);
    const first = controller.disconnect();
    const second = controller.disconnect();
    await clock.advance(DISCONNECT_MS);
    await Promise.all([first, second]);

    assert.equal(calls.disconnect, 1);
    assert.deepEqual(statuses, ["connecting", "connected", "disconnecting", "disconnected"]);
  });

  test("a refused connection ends in error and can be retried", async () => {
    const { controller, clock, mock, log, assertConsistent } = setup("fail");
    const attempt = controller.connect(OPTIONS);
    await clock.advance(CONNECT_MS);

    assert.equal(await attempt, false);
    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.status, "error");
    assert.equal(snapshot.error?.code, "CONNECTION_FAILED");
    assert.notEqual(mock.getStatus(), "connected");
    assertConsistent();
    assert.ok(log.lines.some((line) => line.level === "error" && line.message.startsWith("Connection failed:")));

    mock.setScenario("success");
    const retry = controller.connect(OPTIONS);
    assert.equal(controller.getSnapshot().status, "connecting");
    assert.equal(controller.getSnapshot().error, null);
    await clock.advance(CONNECT_MS);
    assert.equal(await retry, true);
    assert.equal(controller.getSnapshot().status, "connected");
  });

  test("disconnect from error dismisses the failure", async () => {
    const { controller, clock } = setup("fail");
    controller.connect(OPTIONS);
    await clock.advance(CONNECT_MS);
    await controller.disconnect();
    assert.equal(controller.getSnapshot().status, "disconnected");
    assert.equal(controller.getSnapshot().error, null);
  });

  test("a provider that rejects is reported as a failed connection", async () => {
    const clock = createFakeClock();
    const provider: ConnectionProvider = {
      label: "Broken",
      connect: () => Promise.reject(new Error("socket closed")),
      disconnect: () => Promise.resolve(),
      getStatus: () => "disconnected",
    };
    const controller = createConnectionController({ provider, clock, log: recordingLog() });
    assert.equal(await controller.connect(OPTIONS), false);
    assert.equal(controller.getSnapshot().status, "error");
    assert.equal(controller.getSnapshot().error?.details, "socket closed");
    assert.equal(clock.pendingTimers(), 0);
  });

  test("a connection that exceeds the timeout fails and the attempt is abandoned", async () => {
    const { controller, clock, mock, assertConsistent } = setup("slow");
    const attempt = controller.connect(OPTIONS);

    await clock.advance(OPTIONS.timeoutMs - 1);
    assert.equal(controller.getSnapshot().status, "connecting");
    await clock.advance(1);

    assert.equal(await attempt, false);
    assert.equal(controller.getSnapshot().status, "error");
    assert.equal(controller.getSnapshot().error?.code, "CONNECTION_TIMEOUT");

    await clock.advance(DISCONNECT_MS);
    assert.equal(mock.getStatus(), "disconnected", "the provider attempt was abandoned");
    assert.equal(clock.pendingTimers(), 0, "no simulated connect is left running");
    await clock.advance(120_000);
    assert.equal(controller.getSnapshot().status, "error");
    assertConsistent();
  });

  test("disconnect while connecting cancels the attempt; its late result is ignored", async () => {
    const { controller, clock, log, statuses, assertConsistent } = setup();
    const attempt = controller.connect(OPTIONS);
    await clock.advance(CONNECT_MS / 2);

    const done = controller.disconnect();
    assert.equal(await attempt, false);
    await clock.advance(DISCONNECT_MS);
    await done;
    await clock.advance(CONNECT_MS * 2);

    assert.deepEqual(statuses, ["connecting", "disconnecting", "disconnected"]);
    assert.ok(log.lines.some((line) => line.message === "Connection attempt to the Local Test provider cancelled"));
    assertConsistent();
    assert.equal(clock.pendingTimers(), 0);
  });

  test("a late success from an abandoned attempt cannot mark the controller connected", async () => {
    const clock = createFakeClock();
    let finishConnect: (() => void) | undefined;
    const provider: ConnectionProvider = {
      label: "Stubborn",
      connect: () =>
        new Promise((resolve) => {
          finishConnect = () => resolve({ ok: true, latencyMs: 1, latencySimulated: true });
        }),
      disconnect: () => Promise.resolve(),
      getStatus: () => "connecting",
    };
    const controller = createConnectionController({ provider, clock, log: recordingLog() });

    controller.connect({ timeoutMs: 500 });
    await clock.advance(500);
    assert.equal(controller.getSnapshot().status, "error");

    finishConnect?.();
    await clock.flush();
    assert.equal(controller.getSnapshot().status, "error");
  });

  test("auto connect connects once when enabled", async () => {
    const { controller, clock, calls, log } = setup();
    const first = controller.autoConnect({ enabled: true, ...OPTIONS });
    const again = controller.autoConnect({ enabled: true, ...OPTIONS });

    assert.equal(controller.getSnapshot().status, "connecting");
    assert.ok(log.lines.some((line) => line.message === "Auto connect: connecting to the Local Test provider"));
    await clock.advance(CONNECT_MS);
    assert.equal(await first, true);
    assert.equal(await again, false);
    assert.equal(calls.connect, 1);
    assert.equal(controller.getSnapshot().status, "connected");
  });

  test("auto connect does nothing when disabled, including later calls", async () => {
    const { controller, calls } = setup();
    assert.equal(await controller.autoConnect({ enabled: false, ...OPTIONS }), false);
    assert.equal(await controller.autoConnect({ enabled: true, ...OPTIONS }), false);
    assert.equal(controller.getSnapshot().status, "disconnected");
    assert.equal(calls.connect, 0);
  });

  test("dispose abandons an attempt in progress and releases the provider", async () => {
    const { controller, clock, mock } = setup("slow");
    const attempt = controller.connect(OPTIONS);
    controller.dispose();
    assert.equal(await attempt, false);
    await clock.advance(DISCONNECT_MS);
    assert.equal(mock.getStatus(), "disconnected");
    assert.equal(clock.pendingTimers(), 0);
  });
});
