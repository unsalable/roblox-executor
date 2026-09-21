import { byteLength, LOCAL_SERVICE_MAX_MESSAGE_BYTES } from "@/features/backend/backends/localService/protocol";
import { callLocalService, runningInTauri } from "@/lib/tauri";

/**
 * How the frontend reaches the local service.
 *
 * There is exactly one production transport and it is Tauri's own application
 * IPC: the same channel the title bar already uses, between this window and the
 * Rust side of this process. No socket is opened, no address is bound, no port
 * is listened on and no host is named, so there is nothing for anything outside
 * Nova to connect to — not even on loopback.
 *
 * That is a property of the service rather than of the policy around it: the
 * Rust module opens nothing to connect to, which `protocolParity.test.ts`
 * checks by reading its source. The content security policy is the second
 * layer, not the guarantee — its `connect-src` allows the IPC endpoint and the
 * application's own origin, and no external host, so a request to one could not
 * be made from this window even if something tried.
 *
 * The interface exists so the session client can be driven by a fake in the
 * unit tests: the real bridge reads `window.__TAURI_INTERNALS__` and cannot run
 * under `node --test` at all.
 */

export const LOCAL_SERVICE_TRANSPORT_KIND = "Nova IPC";

export interface LocalServiceTransport {
  /** How this transport reaches the service, for the diagnostics rows. */
  readonly kind: string;
  /** False when there is no bridge at all, e.g. the frontend running in a browser. */
  readonly available: boolean;
  /** Sends one raw message and resolves with the raw answer. Rejects only when the bridge itself failed. */
  send: (message: string) => Promise<string>;
}

/**
 * The production transport.
 *
 * `available` is read from the same flag the rest of Nova uses, so
 * `npm run dev:web` reports an unavailable transport and an honest failure
 * instead of an exception from deep inside the Tauri API.
 */
export function createTauriLocalServiceTransport(): LocalServiceTransport {
  return {
    kind: LOCAL_SERVICE_TRANSPORT_KIND,
    available: runningInTauri,
    send: async (message) => {
      if (!runningInTauri) throw new Error("Nova is not running in its desktop shell.");
      // Refused here as well as in the service: an oversized message should
      // never reach the bridge in the first place. Measured in bytes, which is
      // what the service measures — `String.length` counts UTF-16 units and
      // would let a message through that the service then refuses.
      if (byteLength(message) > LOCAL_SERVICE_MAX_MESSAGE_BYTES) {
        throw new Error("The message is larger than the local service protocol allows.");
      }
      const answer = await callLocalService(message);
      if (typeof answer !== "string") {
        throw new Error("The local service answered with something that is not a message.");
      }
      return answer;
    },
  };
}
