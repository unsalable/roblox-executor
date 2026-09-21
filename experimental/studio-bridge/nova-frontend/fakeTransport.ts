import type { BridgeDelivery, BridgePollEvent, BridgeStartResult, BridgeTransport } from "@/features/bridge/transport";

/**
 * An in-memory {@link BridgeTransport} that behaves exactly like the loopback
 * relay — same token gate on polls, same push queue and long-poll parking — but
 * needs no networking, no Rust and no Roblox Studio. Tests drive
 * the "plugin" side through {@link FakeBridgeTransport.pluginSend} and
 * {@link FakeBridgeTransport.pluginPoll}.
 */
export interface PluginResponse {
  status: number;
  body: string;
}

export interface FakeBridgeTransport extends BridgeTransport {
  readonly kind: "fake";
  /** Plugin → Nova request. Resolves with Nova's reply, or a transport status. */
  pluginSend: (body: string, token: string | null) => Promise<PluginResponse>;
  /** Plugin long-poll. Resolves with a pushed message (200) or a status when none/refused. */
  pluginPoll: (token: string | null) => Promise<PluginResponse>;
  /** Simulates a transport-level failure. */
  crash: (message: string) => void;
}

interface ParkedPoll {
  token: string | null;
  resolve: (response: PluginResponse) => void;
}

export function createFakeTransport(): FakeBridgeTransport {
  let started = false;
  let authToken: string | null = null;
  const pushQueue: string[] = [];
  const parkedPolls: ParkedPoll[] = [];

  const deliveryHandlers = new Set<(delivery: BridgeDelivery) => void>();
  const pollHandlers = new Set<(event: BridgePollEvent) => void>();
  const errorHandlers = new Set<(error: { message: string }) => void>();

  const drainParked = (response: PluginResponse) => {
    while (parkedPolls.length > 0) parkedPolls.shift()!.resolve(response);
  };

  return {
    kind: "fake",

    start: (): Promise<BridgeStartResult> => {
      started = true;
      return Promise.resolve({ address: "fake://loopback" });
    },

    stop: (): Promise<void> => {
      started = false;
      authToken = null;
      pushQueue.length = 0;
      drainParked({ status: 410, body: "" });
      return Promise.resolve();
    },

    push: (message) => {
      const waiting = parkedPolls.shift();
      if (waiting) waiting.resolve({ status: 200, body: message });
      else pushQueue.push(message);
    },

    clearQueue: () => {
      pushQueue.length = 0;
    },

    setAuthToken: (token) => {
      authToken = token;
    },

    onDelivery: (handler) => {
      deliveryHandlers.add(handler);
      return () => deliveryHandlers.delete(handler);
    },
    onPoll: (handler) => {
      pollHandlers.add(handler);
      return () => pollHandlers.delete(handler);
    },
    onError: (handler) => {
      errorHandlers.add(handler);
      return () => errorHandlers.delete(handler);
    },

    pluginSend: (body, token) => {
      if (!started) return Promise.resolve({ status: 503, body: "" });
      // Requests always reach the session, which authenticates them itself:
      // the handshake has to work before a token exists. Only polls, which
      // carry pushed messages, are gated by the transport.
      return new Promise<PluginResponse>((resolve) => {
        let answered = false;
        const delivery: BridgeDelivery = {
          body,
          token,
          respond: (reply) => {
            if (answered) return;
            answered = true;
            resolve({ status: 200, body: reply });
          },
        };
        for (const handler of [...deliveryHandlers]) handler(delivery);
      });
    },

    pluginPoll: (token) => {
      if (!started) return Promise.resolve({ status: 410, body: "" });
      if (authToken === null || token !== authToken) return Promise.resolve({ status: 401, body: "" });

      for (const handler of [...pollHandlers]) handler({ token } satisfies BridgePollEvent);

      const queued = pushQueue.shift();
      if (queued !== undefined) return Promise.resolve({ status: 200, body: queued });

      return new Promise<PluginResponse>((resolve) => {
        parkedPolls.push({ token, resolve });
      });
    },

    crash: (message) => {
      for (const handler of [...errorHandlers]) handler({ message });
    },
  };
}
