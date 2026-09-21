import {
  createEnvelope,
  decodeMessage,
  encodeMessage,
  type BridgeEnvelope,
  type BridgeMessageType,
} from "@/features/bridge/protocol";
import type { FakeBridgeTransport, PluginResponse } from "@/features/bridge/fakeTransport";

/**
 * A scripted stand-in for the Roblox Studio plugin, used by bridge tests. It
 * speaks the real protocol over the {@link FakeBridgeTransport} — hello, pair,
 * a poll loop, pong on ping — and lets a test decide how to answer an
 * execute_request. It fakes only the transport peer, never a Roblox runtime.
 */
export interface FakeStudioExecution {
  started?: boolean;
  output?: readonly { level: string; message: string }[];
  result?:
    | { status: "success"; outputSummary?: string }
    | { status: "cancelled" }
    | { status: "error"; message: string }
    /** Answer nothing at all, so Nova's own timeout has to deal with it. */
    | { status: "silent" };
}

export interface FakeStudioOptions {
  transport: FakeBridgeTransport;
  clientType?: string;
  clientVersion?: string;
  capabilities?: readonly string[];
  /** Decides how to answer an execute_request. Default: succeed after started + one output line. */
  onExecute?: (request: BridgeEnvelope) => FakeStudioExecution;
}

export interface FakeStudioClient {
  hello: () => Promise<BridgeEnvelope>;
  pair: (code: string) => Promise<BridgeEnvelope>;
  /** Runs one poll and dispatches whatever Nova pushed. Returns the pushed message, if any. */
  pump: () => Promise<BridgeEnvelope | null>;
  /** Sends one message of the test's choosing, for paths `pump` does not cover. */
  report: (type: BridgeMessageType, payload: Record<string, unknown>, requestId?: string) => Promise<PluginResponse>;
  disconnect: () => Promise<void>;
  readonly token: string | null;
  readonly received: readonly BridgeEnvelope[];
}

export function createFakeStudioClient(options: FakeStudioOptions): FakeStudioClient {
  const { transport } = options;
  let seq = 0;
  const messageId = () => `studio-${++seq}`;
  let token: string | null = null;
  const received: BridgeEnvelope[] = [];

  const send = (type: BridgeMessageType, payload: Record<string, unknown>, requestId?: string): Promise<PluginResponse> =>
    transport.pluginSend(
      encodeMessage(createEnvelope({ type, messageId: messageId(), timestamp: Date.now(), requestId, payload })),
      token,
    );

  const decodeResponse = (response: PluginResponse): BridgeEnvelope => {
    const decoded = decodeMessage(response.body);
    if (!decoded.ok) throw new Error(`Bad response: ${decoded.error.code}`);
    return decoded.envelope;
  };

  const handleExecute = async (request: BridgeEnvelope) => {
    const executionId = String(request.payload.executionId ?? "");
    const behavior = options.onExecute?.(request) ?? { started: true, result: { status: "success", outputSummary: "ok" } };
    if (behavior.started !== false) await send("execute_started", { executionId }, executionId);
    for (const line of behavior.output ?? []) await send("execute_output", { executionId, level: line.level, message: line.message }, executionId);
    const result = behavior.result ?? { status: "success" };
    if (result.status === "silent") return;
    if (result.status === "success") {
      await send("execute_result", { executionId, status: "success", ...(result.outputSummary === undefined ? {} : { outputSummary: result.outputSummary }) }, executionId);
    } else if (result.status === "cancelled") {
      await send("execute_result", { executionId, status: "cancelled" }, executionId);
    } else {
      await send("execute_error", { executionId, error: { code: "STUDIO_ERROR", message: result.message } }, executionId);
    }
  };

  return {
    hello: async () => {
      const response = await send("hello", {
        clientType: options.clientType ?? "roblox-studio",
        clientVersion: options.clientVersion ?? "1.0.0",
        capabilities: options.capabilities ?? ["execute"],
        protocolVersion: "NOVA_STUDIO_BRIDGE_V1",
      });
      return decodeResponse(response);
    },
    pair: async (code) => {
      const response = await send("pair_request", { code, clientType: options.clientType ?? "roblox-studio", clientVersion: options.clientVersion ?? "1.0.0", capabilities: options.capabilities ?? ["execute"] });
      const envelope = decodeResponse(response);
      if (envelope.type === "pair_response" && envelope.payload.ok === true && typeof envelope.payload.sessionToken === "string") {
        token = envelope.payload.sessionToken;
      }
      return envelope;
    },
    pump: async () => {
      const response = await transport.pluginPoll(token);
      if (response.status !== 200) return null;
      const envelope = decodeResponse(response);
      received.push(envelope);
      if (envelope.type === "ping") await send("pong", {}, envelope.requestId);
      else if (envelope.type === "execute_request") await handleExecute(envelope);
      return envelope;
    },
    report: (type, payload, requestId) => send(type, payload, requestId),
    disconnect: async () => {
      await send("disconnect", {});
    },
    get token() {
      return token;
    },
    get received() {
      return received;
    },
  };
}
