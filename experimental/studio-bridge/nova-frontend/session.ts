import {
  createEnvelope,
  decodeMessage,
  encodeMessage,
  MAX_MESSAGE_BYTES,
  MAX_SOURCE_BYTES,
  PROTOCOL_VERSION,
  readString,
  readStringArray,
  type BridgeEnvelope,
  type BridgeMessageType,
  type ProtocolError,
} from "@/features/bridge/protocol";
import { createPairingController, type PairingController } from "@/features/bridge/pairing";
import type { BridgeError, BridgeErrorCode, BridgeSnapshot, PairingInfo } from "@/features/bridge/types";
import type { BridgeTransport } from "@/features/bridge/transport";
import type {
  ExecutionError,
  ExecutionOutcome,
  ExecutionProviderHooks,
  ExecutionRequest,
} from "@/features/execution/types";
import { systemClock, type Clock, type TimerId } from "@/lib/clock";
import { createId as defaultCreateId, createSecret as defaultCreateSecret } from "@/lib/id";
import { logger } from "@/lib/logger";

export type BridgeLog = Pick<typeof logger, "debug" | "info" | "warn" | "error">;

export interface StudioBridgeOptions {
  transport: BridgeTransport;
  /** Nova's version, reported to the plugin and shown in diagnostics. */
  serverVersion: string;
  clock?: Clock;
  log?: BridgeLog;
  createId?: () => string;
  /** Source of the session token; full-entropy random by default. */
  createSecret?: () => string;
  random?: () => number;
  defaultPort?: number;
  pairingTtlMs?: number | (() => number);
  pairingMaxAttempts?: number;
  heartbeatIntervalMs?: number;
  /** No poll or pong within this long marks the Studio connection stale. */
  heartbeatTimeoutMs?: number;
}

/** Everything the studio execution provider needs from the bridge. */
export interface StudioBridge {
  getSnapshot: () => BridgeSnapshot;
  subscribe: (listener: () => void) => () => void;
  /** Starts the loopback listener. Resolves true once the bridge is listening. */
  start: (config?: { port?: number }) => Promise<boolean>;
  /** Stops the bridge, notifying a connected plugin where possible. */
  stop: () => Promise<void>;
  /** Opens (or refreshes) a single-use pairing offer and returns the code. */
  offerPairing: () => PairingInfo;
  /** Withdraws an open pairing offer without touching the bridge. */
  cancelPairing: () => void;
  /** Ends the Studio session but leaves the bridge listening for a new one. */
  disconnectStudio: () => Promise<void>;
  /** Runs one execution request over the bridge; settles as the plugin reports. */
  execute: (request: ExecutionRequest, hooks: ExecutionProviderHooks) => Promise<ExecutionOutcome>;
  /** Asks the plugin to cancel an execution; best-effort. */
  cancel: (executionId: string) => void;
  /** Stops timers and the transport and releases every pending execution. */
  dispose: () => void;
}

interface PendingExecution {
  hooks: ExecutionProviderHooks;
  resolve: (outcome: ExecutionOutcome) => void;
  settled: boolean;
}

const DEFAULT_PORT = 46682;

const initialSnapshot = (): BridgeSnapshot => ({
  phase: "stopped",
  studioConnected: false,
  listening: false,
  address: null,
  protocolVersion: PROTOCOL_VERSION,
  session: null,
  pairing: null,
  latencyMs: null,
  lastHeartbeatAt: null,
  error: null,
});

/**
 * The Nova side of the bridge protocol. It owns the lifecycle (listening ≠
 * connected), the pairing/authentication handshake, one active Studio session,
 * the heartbeat and staleness detection, execution request correlation and the
 * mapping of Studio events onto Nova's logger. It is written entirely against a
 * {@link BridgeTransport}, so the same logic is exercised by the fake transport
 * in tests and by the real loopback transport in the app.
 */
export function createStudioBridge(options: StudioBridgeOptions): StudioBridge {
  const { transport, serverVersion } = options;
  const clock = options.clock ?? systemClock;
  const log = options.log ?? logger;
  const newId = options.createId ?? defaultCreateId;
  const newSecret = options.createSecret ?? defaultCreateSecret;
  const defaultPort = options.defaultPort ?? DEFAULT_PORT;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 30_000;

  const pairing: PairingController = createPairingController({
    clock,
    ttlMs: options.pairingTtlMs ?? 60_000,
    maxAttempts: options.pairingMaxAttempts ?? 5,
    ...(options.random ? { random: options.random } : {}),
  });

  const listeners = new Set<() => void>();
  const unsubscribers: (() => void)[] = [];
  const pending = new Map<string, PendingExecution>();

  let snapshot = initialSnapshot();
  let token: string | null = null;
  let heartbeatTimer: TimerId | null = null;
  let stalenessTimer: TimerId | null = null;
  let pairingTimer: TimerId | null = null;
  let lastPing: { id: string; at: number } | null = null;

  const setSnapshot = (patch: Partial<BridgeSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of [...listeners]) listener();
  };

  const syncPairing = () => setSnapshot({ pairing: pairing.current() });

  const send = (type: BridgeMessageType, payload: Record<string, unknown> = {}, requestId?: string) => {
    transport.push(encodeMessage(createEnvelope({ type, messageId: newId(), timestamp: clock.now(), requestId, payload })));
  };

  const reply = (
    respond: (body: string) => void,
    type: BridgeMessageType,
    payload: Record<string, unknown>,
    requestId?: string,
  ) => {
    respond(encodeMessage(createEnvelope({ type, messageId: newId(), timestamp: clock.now(), requestId, payload })));
  };

  const clearPairingTimer = () => {
    if (pairingTimer !== null) clock.clearTimeout(pairingTimer);
    pairingTimer = null;
  };

  const clearTimers = () => {
    if (heartbeatTimer !== null) clock.clearTimeout(heartbeatTimer);
    if (stalenessTimer !== null) clock.clearTimeout(stalenessTimer);
    heartbeatTimer = null;
    stalenessTimer = null;
    lastPing = null;
    clearPairingTimer();
  };

  const rejectPending = (error: ExecutionError) => {
    for (const [, entry] of pending) {
      if (entry.settled) continue;
      entry.settled = true;
      entry.resolve({ status: "error", error });
    }
    pending.clear();
  };

  /** Ends the active Studio session (drop, stale, replace or graceful) and returns to the given phase. */
  const teardownSession = (error: BridgeError | null, nextPhase: "listening" | "stopped" | "error") => {
    const wasConnected = snapshot.studioConnected;
    clearTimers();
    token = null;
    // The token goes first: nothing can poll this session's queue any more, so
    // whatever is left in it is unreachable until the next session clears it.
    transport.setAuthToken(null);
    pairing.clear();
    rejectPending({
      code: "STUDIO_CONNECTION_LOST",
      message: "The Roblox Studio connection was lost.",
      ...(error?.details === undefined ? {} : { details: error.details }),
    });
    setSnapshot({
      phase: nextPhase,
      studioConnected: false,
      session: null,
      pairing: null,
      latencyMs: null,
      lastHeartbeatAt: null,
      error,
    });
    if (wasConnected) log.warn(`Studio disconnected${error ? `: ${error.message}` : ""}`);
  };

  const armStaleness = () => {
    if (stalenessTimer !== null) clock.clearTimeout(stalenessTimer);
    stalenessTimer = clock.setTimeout(() => {
      if (!snapshot.studioConnected) return;
      teardownSession(
        { code: "HEARTBEAT_TIMEOUT", message: "Studio stopped responding.", details: `No activity for ${heartbeatTimeoutMs} ms.` },
        "listening",
      );
    }, heartbeatTimeoutMs);
  };

  const scheduleHeartbeat = () => {
    if (heartbeatTimer !== null) clock.clearTimeout(heartbeatTimer);
    heartbeatTimer = clock.setTimeout(() => {
      if (!snapshot.studioConnected) return;
      const id = newId();
      lastPing = { id, at: clock.now() };
      send("ping", {}, id);
      scheduleHeartbeat();
    }, heartbeatIntervalMs);
  };

  const noteActivity = () => {
    if (snapshot.studioConnected) armStaleness();
  };

  const protocolError = (respond: (body: string) => void, error: ProtocolError, requestId?: string) => {
    reply(respond, "error", { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }, requestId);
  };

  // --- Inbound message handling -------------------------------------------

  const handleHello = (envelope: BridgeEnvelope, respond: (body: string) => void) => {
    const clientType = readString(envelope.payload, "clientType") ?? "unknown";
    const clientVersion = readString(envelope.payload, "clientVersion") ?? "unknown";
    const busy = snapshot.studioConnected;
    if (!busy && snapshot.phase === "listening") setSnapshot({ phase: "connecting" });
    log.info(busy ? `Rejected a second Studio client (${clientType})` : `Studio client saying hello: ${clientType} ${clientVersion}`);
    reply(
      respond,
      "hello_ack",
      {
        serverType: "nova",
        serverVersion,
        protocolVersion: PROTOCOL_VERSION,
        requiresPairing: true,
        pairingOpen: pairing.current() !== null,
        busy,
        maxSourceBytes: MAX_SOURCE_BYTES,
        heartbeatIntervalMs,
      },
      envelope.messageId,
    );
  };

  const handlePairRequest = (envelope: BridgeEnvelope, respond: (body: string) => void) => {
    if (snapshot.studioConnected) {
      reply(respond, "pair_response", { ok: false, error: { code: "SESSION_REPLACED", message: "A Studio session is already active." } }, envelope.messageId);
      log.warn("Rejected pairing: a Studio session is already active");
      return;
    }
    const code = readString(envelope.payload, "code") ?? "";
    const verdict = pairing.verify(code);
    syncPairing();
    if (verdict !== "ok") {
      const errorCode: BridgeErrorCode = verdict === "invalid" ? "AUTHENTICATION_FAILED" : "PAIRING_EXPIRED";
      reply(respond, "pair_response", { ok: false, error: { code: errorCode, message: "Pairing failed." } }, envelope.messageId);
      log.warn(`Pairing rejected (${verdict})`);
      if (snapshot.phase === "connecting" && !snapshot.studioConnected) setSnapshot({ phase: "listening" });
      return;
    }

    // Start clean: anything still queued belonged to a session that has ended
    // and must never reach this one.
    transport.clearQueue();
    token = newSecret();
    transport.setAuthToken(token);
    const sessionId = newId();
    const now = clock.now();
    setSnapshot({
      phase: "connected",
      studioConnected: true,
      error: null,
      pairing: null,
      lastHeartbeatAt: now,
      session: {
        id: sessionId,
        clientType: readString(envelope.payload, "clientType") ?? "unknown",
        clientVersion: readString(envelope.payload, "clientVersion") ?? "unknown",
        protocolVersion: PROTOCOL_VERSION,
        capabilities: readStringArray(envelope.payload, "capabilities"),
        connectedAt: now,
      },
    });
    reply(
      respond,
      "pair_response",
      { ok: true, sessionId, sessionToken: token, heartbeatIntervalMs, serverVersion },
      envelope.messageId,
    );
    log.info(`Studio paired — session ${sessionId.slice(0, 8)} connected`);
    armStaleness();
    scheduleHeartbeat();
  };

  const handlePong = (envelope: BridgeEnvelope) => {
    if (lastPing && envelope.requestId === lastPing.id) {
      const latencyMs = Math.max(0, clock.now() - lastPing.at);
      lastPing = null;
      setSnapshot({ latencyMs, lastHeartbeatAt: clock.now() });
    }
  };

  const forwardStudioLog = (envelope: BridgeEnvelope) => {
    const level = readString(envelope.payload, "level") ?? "info";
    const message = readString(envelope.payload, "message") ?? "";
    const line = `Studio: ${message}`;
    if (level === "error") log.error(line);
    else if (level === "warn" || level === "warning") log.warn(line);
    else if (level === "debug") log.debug(line);
    else log.info(line);
  };

  const withExecution = (envelope: BridgeEnvelope, run: (id: string, entry: PendingExecution) => void) => {
    const executionId = readString(envelope.payload, "executionId");
    if (executionId === null) return;
    const entry = pending.get(executionId);
    if (!entry || entry.settled) return;
    run(executionId, entry);
  };

  const settleExecution = (executionId: string, entry: PendingExecution, outcome: ExecutionOutcome) => {
    entry.settled = true;
    pending.delete(executionId);
    entry.resolve(outcome);
  };

  const dispatch = (envelope: BridgeEnvelope, respond: (body: string) => void) => {
    switch (envelope.type) {
      case "hello":
        handleHello(envelope, respond);
        return;
      case "pair_request":
        handlePairRequest(envelope, respond);
        return;
      default:
        break;
    }

    // Everything past the handshake requires an authenticated session.
    if (!snapshot.studioConnected) {
      protocolError(respond, { code: "SESSION_EXPIRED", message: "No active Studio session." }, envelope.messageId);
      return;
    }

    switch (envelope.type) {
      case "pong":
        handlePong(envelope);
        reply(respond, "pong", { ok: true }, envelope.messageId);
        return;
      case "studio_log":
      case "studio_error":
        forwardStudioLog(envelope);
        reply(respond, "hello_ack", { ok: true }, envelope.messageId);
        return;
      case "error": {
        // Studio telling us something went wrong on its side — most often that
        // a cancellation could not be honoured. Reported, never swallowed.
        const code = readString(envelope.payload, "code") ?? "STUDIO_ERROR";
        const detail = readString(envelope.payload, "message");
        log.warn(`Studio: ${code}${detail === null ? "" : ` — ${detail}`}`);
        reply(respond, "hello_ack", { ok: true }, envelope.messageId);
        return;
      }
      case "execute_started":
        withExecution(envelope, (_id, entry) => entry.hooks.onRunning());
        reply(respond, "hello_ack", { ok: true }, envelope.messageId);
        return;
      case "execute_output":
        withExecution(envelope, () => forwardStudioLog(envelope));
        reply(respond, "hello_ack", { ok: true }, envelope.messageId);
        return;
      case "execute_result":
        withExecution(envelope, (id, entry) => {
          const status = readString(envelope.payload, "status") ?? "success";
          if (status === "cancelled") {
            settleExecution(id, entry, { status: "cancelled" });
            return;
          }
          if (status === "error") {
            const message = readString(envelope.payload, "message") ?? "Studio reported an execution error.";
            settleExecution(id, entry, { status: "error", error: { code: "PROVIDER_ERROR", message } });
            return;
          }
          const summary = readString(envelope.payload, "outputSummary");
          settleExecution(id, entry, { status: "success", output: summary === null ? [] : [summary] });
        });
        reply(respond, "hello_ack", { ok: true }, envelope.messageId);
        return;
      case "execute_error":
        withExecution(envelope, (id, entry) => {
          const errorPayload = envelope.payload.error;
          const message = (typeof errorPayload === "object" && errorPayload !== null && typeof (errorPayload as { message?: unknown }).message === "string"
            ? (errorPayload as { message: string }).message
            : readString(envelope.payload, "message")) ?? "Studio reported an execution error.";
          const originalCode = typeof errorPayload === "object" && errorPayload !== null && typeof (errorPayload as { code?: unknown }).code === "string"
            ? (errorPayload as { code: string }).code
            : "STUDIO_ERROR";
          settleExecution(id, entry, {
            status: "error",
            error: { code: "PROVIDER_ERROR", message, details: `Studio code: ${originalCode}` },
          });
        });
        reply(respond, "hello_ack", { ok: true }, envelope.messageId);
        return;
      case "disconnect":
        reply(respond, "hello_ack", { ok: true }, envelope.messageId);
        teardownSession(null, "listening");
        return;
      default:
        protocolError(respond, { code: "UNKNOWN_REQUEST", message: `Unsupported message type: ${envelope.type}` }, envelope.messageId);
    }
  };

  const onDelivery = (delivery: { body: string; token: string | null; respond: (body: string) => void }) => {
    const decoded = decodeMessage(delivery.body, { maxBytes: MAX_MESSAGE_BYTES });
    if (!decoded.ok) {
      protocolError(delivery.respond, decoded.error);
      log.warn(`Rejected an invalid Studio message: ${decoded.error.code}`);
      return;
    }
    // The transport gates polls (which carry pushed messages); requests are
    // authenticated here, so an unpaired client can still complete the
    // handshake but can never act on an established session.
    const handshake = decoded.envelope.type === "hello" || decoded.envelope.type === "pair_request";
    if (snapshot.studioConnected && delivery.token !== token && !handshake) {
      protocolError(delivery.respond, { code: "AUTHENTICATION_FAILED", message: "Invalid session token." }, decoded.envelope.messageId);
      return;
    }
    noteActivity();
    dispatch(decoded.envelope, delivery.respond);
  };

  // --- Wiring --------------------------------------------------------------

  unsubscribers.push(
    transport.onDelivery(onDelivery),
    transport.onPoll(() => noteActivity()),
    transport.onError((error) => {
      log.error(`Bridge transport error: ${error.message}`);
      teardownSession({ code: "TRANSPORT_ERROR", message: "The bridge transport failed.", details: error.message }, "error");
    }),
  );

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    start: async (config) => {
      if (snapshot.listening) return true;
      const port = config?.port ?? defaultPort;
      setSnapshot({ phase: "starting", error: null });
      try {
        const { address } = await transport.start({ port });
        setSnapshot({ phase: "listening", listening: true, address });
        log.info(`Studio bridge listening on ${address}`);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code: BridgeErrorCode = /in use|EADDRINUSE|bind/i.test(message) ? "PORT_IN_USE" : "BRIDGE_START_FAILED";
        setSnapshot({ phase: "error", listening: false, error: { code, message: "The bridge could not start.", details: message } });
        log.error(`Bridge failed to start: ${message}`);
        return false;
      }
    },

    stop: async () => {
      if (!snapshot.listening && snapshot.phase === "stopped") return;
      if (snapshot.studioConnected) send("disconnect", { reason: "Nova is stopping the bridge." });
      setSnapshot({ phase: "stopping" });
      teardownSession(null, "stopped");
      await transport.stop();
      setSnapshot({ phase: "stopped", listening: false, address: null });
      log.info("Studio bridge stopped");
    },

    offerPairing: () => {
      const offer = pairing.begin();
      syncPairing();
      log.info("Pairing offer opened (the code is shown in Nova only)");

      // Drop the offer from the UI the moment it stops being usable, so a dead
      // code is never left on screen.
      clearPairingTimer();
      pairingTimer = clock.setTimeout(
        () => {
          pairingTimer = null;
          if (pairing.current()?.code !== offer.code) return;
          pairing.clear();
          syncPairing();
          log.info("Pairing offer expired");
        },
        Math.max(0, offer.expiresAt - clock.now()),
      );
      return offer;
    },

    cancelPairing: () => {
      if (pairing.current() === null) return;
      clearPairingTimer();
      pairing.clear();
      syncPairing();
      log.info("Pairing offer withdrawn");
    },

    disconnectStudio: async () => {
      if (!snapshot.studioConnected) return;
      // The notice stays queued for the plugin's parked poll; the session ends
      // immediately either way, so a plugin that never collects it simply finds
      // its next poll refused.
      send("disconnect", { reason: "Nova ended the session." });
      teardownSession(null, "listening");
    },

    execute: (request, hooks) =>
      new Promise<ExecutionOutcome>((resolve) => {
        if (!snapshot.studioConnected) {
          resolve({ status: "error", error: { code: "STUDIO_CONNECTION_LOST", message: "Not connected to Roblox Studio." } });
          return;
        }
        pending.set(request.executionId, { hooks, resolve, settled: false });
        send(
          "execute_request",
          {
            executionId: request.executionId,
            scriptId: request.scriptId,
            scriptName: request.scriptName,
            mode: request.mode,
            source: request.source,
            provider: "studio-development",
          },
          request.executionId,
        );
      }),

    cancel: (executionId) => {
      if (!snapshot.studioConnected) return;
      send("execute_cancel", { executionId }, executionId);
    },

    dispose: () => {
      for (const unsub of unsubscribers) unsub();
      unsubscribers.length = 0;
      listeners.clear();
      clearTimers();
      token = null;
      transport.setAuthToken(null);
      rejectPending({ code: "STUDIO_CONNECTION_LOST", message: "The bridge was disposed." });
      void transport.stop();
    },
  };
}
