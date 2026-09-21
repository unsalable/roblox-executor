import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createFakeStudioClient, type FakeStudioClient } from "@/features/bridge/fakeStudio";
import { createFakeTransport } from "@/features/bridge/fakeTransport";
import { createStudioBridge, type BridgeLog } from "@/features/bridge/session";
import {
  bridgePhaseToConnectionStatus,
  createStudioConnectionProvider,
  createStudioExecutionProvider,
  STUDIO_CONNECTION_LABEL,
} from "@/features/bridge/studioProvider";
import { STUDIO_PROVIDER_TYPE } from "@/features/bridge/types";
import { createConnectionController } from "@/features/connection/connectionController";
import { createExecutionController } from "@/features/execution/executionController";
import type { ExecutionInput, ExecutionPhase } from "@/features/execution/types";
import { createFakeClock } from "@/lib/testing/fakeClock";

const TIMEOUT_MS = 5000;
const OPTIONS = { timeoutMs: TIMEOUT_MS };
const CONNECT_OPTIONS = { timeoutMs: 5000 };

interface LogLine {
  level: string;
  message: string;
}

function recordingLog(): BridgeLog & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  const at = (level: string) => (message: string) => {
    lines.push({ level, message });
  };
  return { lines, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

const input = (source = "print('hello from Nova')"): ExecutionInput => ({
  mode: "full-script",
  script: { id: "script-1", name: "Main.lua" },
  source,
});

function setup(options: { onExecute?: Parameters<typeof createFakeStudioClient>[0]["onExecute"] } = {}) {
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
    createSecret: () => `secret-${++counter}`,
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 30_000,
  });

  const connection = createConnectionController({
    provider: createStudioConnectionProvider(bridge, { getPort: () => 52700 }),
    clock,
    log,
  });
  let executionCounter = 0;
  const execution = createExecutionController({
    provider: createStudioExecutionProvider(bridge),
    isConnected: () => bridge.getSnapshot().studioConnected,
    clock,
    log,
    createId: () => `exec-${++executionCounter}`,
  });

  const phases: ExecutionPhase[] = [];
  let last = execution.getSnapshot().phase;
  execution.subscribe(() => {
    const { phase } = execution.getSnapshot();
    if (phase !== last) phases.push(phase);
    last = phase;
  });

  // Everything Nova pushes toward the plugin, so tests can assert on the wire.
  const pushed: { type: string; payload: Record<string, unknown> }[] = [];
  const push = transport.push;
  transport.push = (message) => {
    pushed.push(JSON.parse(message) as { type: string; payload: Record<string, unknown> });
    push(message);
  };

  const studio = createFakeStudioClient({
    transport,
    ...(options.onExecute ? { onExecute: options.onExecute } : {}),
  });

  /** Brings the bridge up and pairs the fake plugin, as the UI flow would. */
  const connectStudio = async (client: FakeStudioClient = studio) => {
    await connection.connect(CONNECT_OPTIONS);
    const { code } = bridge.offerPairing();
    await client.hello();
    await client.pair(code);
  };

  return { clock, log, transport, bridge, connection, execution, studio, phases, pushed, connectStudio };
}

describe("studio bridge ↔ execution controller", () => {
  test("the provider identifies itself through metadata, not hardcoded UI strings", () => {
    const { execution, connection } = setup();
    assert.equal(execution.provider.label, STUDIO_CONNECTION_LABEL);
    assert.equal(execution.provider.providerType, STUDIO_PROVIDER_TYPE);
    assert.equal(execution.provider.requiresConnection, true);
    assert.equal(execution.provider.supportsCancel, true);
    assert.equal(connection.provider.label, STUDIO_CONNECTION_LABEL);
    assert.equal(connection.provider.providerType, STUDIO_PROVIDER_TYPE);
  });

  test("bridge phases map onto the connection status the UI already understands", () => {
    assert.equal(bridgePhaseToConnectionStatus("stopped"), "disconnected");
    assert.equal(bridgePhaseToConnectionStatus("starting"), "connecting");
    assert.equal(bridgePhaseToConnectionStatus("listening"), "connected");
    assert.equal(bridgePhaseToConnectionStatus("connected"), "connected");
    assert.equal(bridgePhaseToConnectionStatus("stopping"), "disconnecting");
    assert.equal(bridgePhaseToConnectionStatus("error"), "error");
  });

  test("a listening bridge alone does not allow execution", async () => {
    const { connection, execution, bridge } = setup();
    assert.equal(await connection.connect(CONNECT_OPTIONS), true);
    assert.equal(bridge.getSnapshot().listening, true);
    assert.equal(bridge.getSnapshot().studioConnected, false);

    const submission = execution.execute(input(), OPTIONS);
    assert.equal(submission.accepted, false);
    assert.equal(!submission.accepted && submission.error.code, "NOT_CONNECTED");
    assert.match(String(!submission.accepted && submission.error.message), /Roblox Studio/);
  });

  test("the full path: pair, execute, receive output, complete", async () => {
    const { execution, studio, phases, connectStudio, log, bridge } = setup({
      onExecute: () => ({
        started: true,
        output: [
          { level: "info", message: "Delivered Main.lua to ServerStorage/Nova" },
          { level: "warn", message: "Studio does not evaluate the source" },
        ],
        result: { status: "success", outputSummary: "Delivered 1 script (24 lines)." },
      }),
    });

    await connectStudio();
    assert.equal(bridge.getSnapshot().studioConnected, true);

    const submission = execution.execute(input(), OPTIONS);
    assert.equal(submission.accepted, true);
    if (!submission.accepted) return;

    // The plugin picks the request up on its poll and answers it.
    await studio.pump();
    const result = await submission.result;

    assert.equal(result.success, true);
    assert.deepEqual(phases, ["preparing", "running", "success"]);
    assert.deepEqual(result.output, ["Delivered 1 script (24 lines)."]);
    assert.equal(execution.getSnapshot().history.length, 1);
    assert.equal(execution.getSnapshot().history[0]?.provider, STUDIO_CONNECTION_LABEL);
    assert.equal(execution.getSnapshot().history[0]?.status, "success");

    // Studio output reached the Nova console, labelled as coming from Studio.
    assert.ok(log.lines.some((line) => line.level === "info" && line.message === "Studio: Delivered Main.lua to ServerStorage/Nova"));
    assert.ok(log.lines.some((line) => line.level === "warn" && line.message === "Studio: Studio does not evaluate the source"));
  });

  test("the request carries only what execution needs", async () => {
    const { execution, transport, connectStudio } = setup();
    await connectStudio();

    const pushed: string[] = [];
    const original = transport.push;
    transport.push = (message) => {
      pushed.push(message);
      original(message);
    };

    execution.execute(input("print(1)"), OPTIONS);
    const request = JSON.parse(pushed[0]!) as { type: string; payload: Record<string, unknown> };

    assert.equal(request.type, "execute_request");
    assert.deepEqual(Object.keys(request.payload).sort(), ["executionId", "mode", "provider", "scriptId", "scriptName", "source"]);
    assert.equal(request.payload.source, "print(1)");
    assert.equal(request.payload.provider, "studio-development");
  });

  test("a Studio-side failure becomes a structured execution error", async () => {
    const { execution, studio, phases, connectStudio } = setup({
      onExecute: () => ({ started: true, result: { status: "error", message: "ServerStorage is locked." } }),
    });
    await connectStudio();

    const submission = execution.execute(input(), OPTIONS);
    assert.equal(submission.accepted, true);
    if (!submission.accepted) return;
    await studio.pump();
    const result = await submission.result;

    assert.equal(result.success, false);
    assert.equal(result.error?.code, "PROVIDER_ERROR");
    assert.equal(result.error?.message, "ServerStorage is locked.");
    assert.match(String(result.error?.details), /STUDIO_ERROR/);
    assert.deepEqual(phases, ["preparing", "running", "error"]);
  });

  test("cancellation is reported as cancelled only when Studio confirms it", async () => {
    const { execution, studio, phases, connectStudio } = setup({
      onExecute: () => ({ started: true, result: { status: "cancelled" } }),
    });
    await connectStudio();

    const submission = execution.execute(input(), OPTIONS);
    assert.equal(submission.accepted, true);
    if (!submission.accepted) return;

    assert.equal(execution.cancel(), "requested");
    assert.equal(execution.getSnapshot().cancelling, true);
    await studio.pump();
    const result = await submission.result;

    assert.equal(result.cancelled, true);
    assert.equal(result.success, false);
    assert.deepEqual(phases, ["preparing", "running", "cancelled"]);
    assert.equal(execution.getSnapshot().history[0]?.status, "cancelled");
  });

  test("a cancellation Studio cannot honour is reported, not pretended", async () => {
    const { execution, studio, pushed, log, connectStudio } = setup({
      onExecute: () => ({ started: true, result: { status: "silent" as const } }),
    });
    await connectStudio();

    const submission = execution.execute(input(), { timeoutMs: 60_000 });
    assert.equal(submission.accepted, true);
    if (!submission.accepted) return;
    await studio.pump();

    assert.equal(execution.cancel(), "requested");
    const cancel = pushed.find((message) => message.type === "execute_cancel");
    assert.ok(cancel, "Nova asked Studio to cancel");
    const executionId = String(cancel.payload.executionId);

    // Studio answers that this work cannot be interrupted.
    await studio.report("error", {
      code: "CANCEL_UNSUPPORTED",
      message: "Delivering a script is a single write and cannot be interrupted.",
      executionId,
    });

    assert.ok(
      log.lines.some((line) => line.level === "warn" && line.message.includes("CANCEL_UNSUPPORTED")),
      "the refusal reaches the console",
    );
    assert.equal(execution.getSnapshot().phase, "running", "the execution is still running, as Studio said");

    // It then finishes normally rather than being recorded as cancelled.
    await studio.report("execute_result", { executionId, status: "success", outputSummary: "Delivered." });
    const result = await submission.result;
    assert.equal(result.success, true);
    assert.equal(result.cancelled, false, "a cancellation that did not happen is never reported as one");
    assert.equal(execution.getSnapshot().history[0]?.status, "success");
  });

  test("a Studio that never answers ends in the controller's timeout, and its late reply is ignored", async () => {
    const { execution, studio, clock, phases, connectStudio } = setup({
      onExecute: () => ({ started: true, result: { status: "silent" as const } }),
    });
    await connectStudio();

    const submission = execution.execute(input(), OPTIONS);
    assert.equal(submission.accepted, true);
    if (!submission.accepted) return;

    await studio.pump(); // execute_started only
    await clock.advance(TIMEOUT_MS);
    const result = await submission.result;

    assert.equal(result.success, false);
    assert.equal(result.error?.code, "EXECUTION_TIMEOUT");
    assert.deepEqual(phases, ["preparing", "running", "error"]);

    // A result that arrives after the timeout cannot revive the execution.
    const before = execution.getSnapshot();
    await clock.advance(1000);
    assert.equal(execution.getSnapshot().phase, before.phase);
    assert.equal(execution.getSnapshot().history.length, 1);
  });

  test("losing Studio mid-execution fails the execution instead of leaving it stuck", async () => {
    const { execution, studio, clock, connectStudio, bridge, phases } = setup({
      onExecute: () => ({ started: true, result: { status: "silent" as const } }),
    });
    await connectStudio();

    // A generous execution timeout, so the heartbeat is what notices first.
    const submission = execution.execute(input(), { timeoutMs: 60_000 });
    assert.equal(submission.accepted, true);
    if (!submission.accepted) return;
    await studio.pump();

    // Studio stops polling: the heartbeat goes stale.
    await clock.advance(30_000);
    const result = await submission.result;

    assert.equal(result.success, false);
    assert.equal(result.error?.code, "STUDIO_CONNECTION_LOST");
    assert.deepEqual(phases, ["preparing", "running", "error"]);
    assert.equal(bridge.getSnapshot().studioConnected, false);
    assert.equal(bridge.getSnapshot().listening, true, "the bridge stays up for a reconnect");
  });

  test("after a reconnect nothing is replayed and a new execution works", async () => {
    const { execution, transport, bridge, connectStudio, clock } = setup();
    await connectStudio();

    await clock.advance(30_000); // Studio goes away
    assert.equal(bridge.getSnapshot().studioConnected, false);

    const pushedAfterLoss: string[] = [];
    const original = transport.push;
    transport.push = (message) => {
      pushedAfterLoss.push(message);
      original(message);
    };

    const second = createFakeStudioClient({ transport });
    const { code } = bridge.offerPairing();
    await second.hello();
    await second.pair(code);

    assert.equal(bridge.getSnapshot().studioConnected, true);
    assert.equal(pushedAfterLoss.length, 0, "reconnecting never re-sends an old execution");
    assert.equal(execution.getSnapshot().history.length, 0);

    const submission = execution.execute(input(), OPTIONS);
    assert.equal(submission.accepted, true);
    if (!submission.accepted) return;
    await second.pump();
    assert.equal((await submission.result).success, true);
  });

  test("disconnecting stops the bridge and blocks execution again", async () => {
    const { execution, connection, bridge, connectStudio } = setup();
    await connectStudio();

    await connection.disconnect();

    assert.equal(bridge.getSnapshot().listening, false);
    assert.equal(bridge.getSnapshot().studioConnected, false);
    assert.equal(connection.getSnapshot().status, "disconnected");
    const submission = execution.execute(input(), OPTIONS);
    assert.equal(!submission.accepted && submission.error.code, "NOT_CONNECTED");
  });

  test("a large script is carried end to end", async () => {
    const { execution, studio, connectStudio } = setup({
      onExecute: (request) => ({
        started: true,
        result: { status: "success", outputSummary: `Received ${String(request.payload.source).length} characters.` },
      }),
    });
    await connectStudio();

    const big = "-- padding\n".repeat(50_000); // ~550 KB
    const submission = execution.execute(input(big), OPTIONS);
    assert.equal(submission.accepted, true);
    if (!submission.accepted) return;
    await studio.pump();
    const result = await submission.result;

    assert.equal(result.success, true);
    assert.deepEqual(result.output, [`Received ${big.length} characters.`]);
  });
});
