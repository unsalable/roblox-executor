import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { BridgeDelivery, BridgePollEvent, BridgeStartResult, BridgeTransport } from "@/features/bridge/transport";
import { logger } from "@/lib/logger";
import { runningInTauri } from "@/lib/tauri";

/**
 * The real transport: a thin wrapper over the Rust loopback relay. It carries
 * opaque message strings in both directions and holds no protocol knowledge of
 * its own — the session layer above it does all the interpreting.
 */

const EVENT_DELIVERY = "nova://bridge/delivery";
const EVENT_POLL = "nova://bridge/poll";
const EVENT_ERROR = "nova://bridge/error";

interface DeliveryPayload {
  deliveryId: number;
  body: string;
  token: string | null;
}

interface StartedPayload {
  address: string;
  port: number;
  protocol: string;
}

export function createTauriTransport(): BridgeTransport {
  const deliveryHandlers = new Set<(delivery: BridgeDelivery) => void>();
  const pollHandlers = new Set<(event: BridgePollEvent) => void>();
  const errorHandlers = new Set<(error: { message: string }) => void>();
  let unlisteners: UnlistenFn[] = [];

  const attach = async () => {
    if (unlisteners.length > 0) return;
    unlisteners = await Promise.all([
      listen<DeliveryPayload>(EVENT_DELIVERY, ({ payload }) => {
        const delivery: BridgeDelivery = {
          body: payload.body,
          token: payload.token,
          respond: (body) => {
            void invoke("bridge_respond", { deliveryId: payload.deliveryId, body }).catch((error: unknown) =>
              logger.debug("Bridge reply could not be delivered", error),
            );
          },
        };
        for (const handler of [...deliveryHandlers]) handler(delivery);
      }),
      listen<{ token: string | null }>(EVENT_POLL, ({ payload }) => {
        for (const handler of [...pollHandlers]) handler({ token: payload.token });
      }),
      listen<{ message: string }>(EVENT_ERROR, ({ payload }) => {
        for (const handler of [...errorHandlers]) handler({ message: payload.message });
      }),
    ]);
  };

  const detach = () => {
    for (const unlisten of unlisteners) unlisten();
    unlisteners = [];
  };

  return {
    kind: "tauri",

    start: async ({ port }): Promise<BridgeStartResult> => {
      if (!runningInTauri) {
        throw new Error("The Studio bridge needs the Nova desktop application; it cannot run in a browser preview.");
      }
      await attach();
      const started = await invoke<StartedPayload>("bridge_start", { port });
      return { address: started.address };
    },

    stop: async () => {
      if (!runningInTauri) return;
      try {
        await invoke("bridge_stop");
      } finally {
        detach();
      }
    },

    push: (message) => {
      void invoke("bridge_push", { message }).catch((error: unknown) =>
        logger.debug("Bridge message could not be queued", error),
      );
    },

    clearQueue: () => {
      void invoke("bridge_clear_queue").catch((error: unknown) =>
        logger.debug("Bridge queue could not be cleared", error),
      );
    },

    setAuthToken: (token) => {
      void invoke("bridge_set_token", { token }).catch((error: unknown) =>
        logger.debug("Bridge session token could not be applied", error),
      );
    },

    onDelivery: (handler) => {
      deliveryHandlers.add(handler);
      return () => {
        deliveryHandlers.delete(handler);
      };
    },
    onPoll: (handler) => {
      pollHandlers.add(handler);
      return () => {
        pollHandlers.delete(handler);
      };
    },
    onError: (handler) => {
      errorHandlers.add(handler);
      return () => {
        errorHandlers.delete(handler);
      };
    },
  };
}
