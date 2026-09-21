import {
  byteLength,
  createRequest,
  decodeResponse,
  encodeRequest,
  isSessionLost,
  LOCAL_SERVICE_CAPABILITY_TARGET,
  LOCAL_SERVICE_MAX_MESSAGE_BYTES,
  readAttached,
  readHealth,
  readSessionOpened,
  type LocalServiceError,
  type LocalServiceHealth,
  type LocalServiceOp,
  type LocalServiceSessionInfo,
} from "@/features/backend/backends/localService/protocol";
import type { LocalServiceTransport } from "@/features/backend/backends/localService/transport";
import { systemClock, type Clock, type TimerId } from "@/lib/clock";
import { createId as createRandomId } from "@/lib/id";

/**
 * The client half of the local service session.
 *
 * It owns one thing the rest of Nova never sees: the session token the service
 * issued. The token lives in a closure variable here, is attached to every
 * request, and is never returned, logged, shown, persisted or put in a
 * diagnostic — {@link LocalServiceSessionInfo} deliberately has no field for
 * it, so there is nowhere for it to leak to by accident.
 *
 * Three protections live here rather than in the backend above, because they
 * are all properties of one request rather than of the lifecycle:
 *
 * - **a deadline**, so a service that never answers cannot hold a lifecycle
 *   operation open;
 * - **correlation**, so an answer that names a different request is discarded
 *   instead of applied (see `decodeResponse`);
 * - **a generation**, so an answer that arrives after the session it belonged
 *   to was replaced or closed can never touch the session that replaced it.
 *
 * Nothing here throws. Every failure — including a transport that is not there
 * at all — comes back as a structured code.
 */

/** How long one request may take before it is abandoned. */
export const LOCAL_SERVICE_REQUEST_TIMEOUT_MS = 4000;

export type LocalServiceCall<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "failed"; readonly error: LocalServiceError }
  | { readonly status: "cancelled" };

export interface LocalServiceSessionStats {
  /** Requests sent since this client was built, successful or not. */
  readonly requests: number;
  /** Round trip of the last answered request, in milliseconds; null before the first. */
  readonly lastLatencyMs: number | null;
  /** The last failure, kept for the diagnostics row. Null until one happens. */
  readonly lastError: LocalServiceError | null;
  /** How many sessions the service has issued, as of the last answer. */
  readonly sessionsIssued: number;
}

export interface LocalServiceSession {
  readonly transportKind: string;
  readonly transportAvailable: boolean;
  /** True while a session is open as far as this client knows. */
  isOpen: () => boolean;
  /** The open session, minus its token. Null when there is none. */
  getInfo: () => LocalServiceSessionInfo | null;
  getStats: () => LocalServiceSessionStats;
  /** Opens a session. Replaces one already open, the way the service does. */
  open: (options: { signal: AbortSignal }) => Promise<LocalServiceCall<LocalServiceSessionInfo>>;
  health: (options?: { signal?: AbortSignal }) => Promise<LocalServiceCall<LocalServiceHealth>>;
  attach: (options: { signal: AbortSignal }) => Promise<LocalServiceCall<{ attachedAt: number }>>;
  detach: () => Promise<LocalServiceCall<null>>;
  /** Ends the session on the service and forgets the token. Never throws. */
  close: () => Promise<void>;
  /** Forgets the session locally, without contacting the service. */
  forget: (reason: LocalServiceError) => void;
}

export interface LocalServiceSessionOptions {
  transport: LocalServiceTransport;
  clock?: Clock;
  createId?: () => string;
  requestTimeoutMs?: number;
}

interface OpenSession {
  readonly info: LocalServiceSessionInfo;
  readonly token: string;
}

type Raced<T> =
  | { status: "settled"; value: T }
  | { status: "failed"; error: unknown }
  | { status: "timeout" }
  | { status: "aborted" };

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Waits for `work`, a deadline or an abort, whichever comes first.
 *
 * The transport itself cannot be cancelled — an IPC call is already on its way
 * — so this stops *waiting* rather than stopping the call. That is exactly why
 * the generation guard exists: what comes back late has to be discarded, not
 * merely unawaited.
 */
function race<T>(work: Promise<T>, clock: Clock, ms: number, signal: AbortSignal | undefined): Promise<Raced<T>> {
  return new Promise<Raced<T>>((resolve) => {
    let settled = false;
    let timer: TimerId | null = null;

    const finish = (outcome: Raced<T>) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    function onAbort() {
      finish({ status: "aborted" });
    }

    work.then(
      (value) => finish({ status: "settled", value }),
      (error: unknown) => finish({ status: "failed", error }),
    );
    if (settled) return;

    if (signal?.aborted === true) {
      finish({ status: "aborted" });
      return;
    }
    timer = clock.setTimeout(() => {
      timer = null;
      finish({ status: "timeout" });
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createLocalServiceSession(options: LocalServiceSessionOptions): LocalServiceSession {
  const { transport } = options;
  const clock = options.clock ?? systemClock;
  const createId = options.createId ?? createRandomId;
  const requestTimeoutMs = options.requestTimeoutMs ?? LOCAL_SERVICE_REQUEST_TIMEOUT_MS;

  let session: OpenSession | null = null;
  /**
   * Bumped whenever the session this client holds changes identity. Every
   * request captures it before it is sent and checks it after, so an answer
   * that outlived its session is discarded rather than applied.
   */
  let generation = 0;
  let requests = 0;
  let lastLatencyMs: number | null = null;
  let lastError: LocalServiceError | null = null;
  let sessionsIssued = 0;

  const fail = <T>(error: LocalServiceError): LocalServiceCall<T> => {
    lastError = error;
    return { status: "failed", error };
  };

  const forget = (reason: LocalServiceError) => {
    session = null;
    generation += 1;
    lastError = reason;
  };

  /** Sends one request and reads the answer. Authenticated unless it is the handshake. */
  const send = async (
    op: LocalServiceOp,
    payload: Record<string, unknown>,
    call: { signal?: AbortSignal | undefined; authenticated: boolean },
  ): Promise<LocalServiceCall<unknown>> => {
    if (!transport.available) {
      return fail({
        code: "TRANSPORT_UNAVAILABLE",
        message: "Nova's local service is only reachable from the desktop application.",
        details: "There is no application IPC bridge in this window.",
      });
    }

    const active = session;
    if (call.authenticated && active === null) {
      return fail({
        code: "AUTH_REQUIRED",
        message: "There is no local service session.",
        details: `The ${op} request was not sent.`,
      });
    }

    const requestId = createId();
    const message = encodeRequest(
      createRequest({
        op,
        requestId,
        sessionId: call.authenticated && active !== null ? active.info.sessionId : null,
        token: call.authenticated && active !== null ? active.token : null,
        payload,
      }),
    );
    if (byteLength(message) > LOCAL_SERVICE_MAX_MESSAGE_BYTES) {
      // Refused before it is sent: the limit belongs to the protocol, not to
      // the bridge, and both sides enforce it.
      return fail({
        code: "MESSAGE_TOO_LARGE",
        message: "The request is larger than the local service protocol allows.",
        details: `the limit is ${LOCAL_SERVICE_MAX_MESSAGE_BYTES} bytes`,
      });
    }

    const sentAt = clock.now();
    const sentGeneration = generation;
    requests += 1;

    const raced = await race(transport.send(message), clock, requestTimeoutMs, call.signal);
    if (raced.status === "aborted") return { status: "cancelled" };
    if (raced.status === "timeout") {
      return fail({
        code: "REQUEST_TIMEOUT",
        message: "The local service did not answer in time.",
        details: `the ${op} request was abandoned after ${requestTimeoutMs} ms`,
      });
    }
    if (raced.status === "failed") {
      return fail({
        code: "TRANSPORT_FAILED",
        message: "Nova could not reach its local service.",
        details: describeError(raced.error),
      });
    }

    lastLatencyMs = Math.max(0, clock.now() - sentAt);

    // The answer outlived the session it was sent for. It is dropped whatever
    // it says: a late "attached" must not attach the session that replaced it.
    if (call.authenticated && sentGeneration !== generation) {
      return fail({
        code: "SESSION_STALE",
        message: "The local service session changed while the request was in flight.",
        details: `the ${op} answer was discarded`,
      });
    }

    const decoded = decodeResponse(raced.value, requestId);
    if (decoded.ok) return { status: "ok", value: decoded.value };

    if (call.authenticated && isSessionLost(decoded.error.code)) forget(decoded.error);
    return fail(decoded.error);
  };

  /** Ends a session this client no longer owns, without disturbing the live one. */
  const abandon = (orphan: OpenSession) => {
    const message = encodeRequest(
      createRequest({
        op: "shutdown",
        requestId: createId(),
        sessionId: orphan.info.sessionId,
        token: orphan.token,
        payload: {},
      }),
    );
    void Promise.resolve(transport.send(message)).catch(() => undefined);
  };

  return {
    transportKind: transport.kind,
    transportAvailable: transport.available,
    isOpen: () => session !== null,
    getInfo: () => session?.info ?? null,
    getStats: () => ({ requests, lastLatencyMs, lastError, sessionsIssued }),

    /**
     * Opens a session.
     *
     * The handshake is deliberately **not** abandoned when `signal` fires. Its
     * answer is the only thing that can say whether the service opened a
     * session at all, so dropping the request would be the one way to leave one
     * running that nobody owns. The signal ends the *waiting*; the request
     * itself runs on, and the generation guard below closes whatever it opened.
     *
     * Only called from a resting state — the controller's start is single
     * flight — so there is never a second handshake in the air beside this one.
     */
    open: ({ signal }) => {
      const sentGeneration = generation;

      const settled: Promise<LocalServiceCall<LocalServiceSessionInfo>> = send(
        "handshake",
        { client: "nova", capabilities: [LOCAL_SERVICE_CAPABILITY_TARGET] },
        { authenticated: false },
      ).then((answer) => {
        if (answer.status !== "ok") return answer;

        const opened = readSessionOpened(answer.value);
        if (opened === null) {
          return fail<LocalServiceSessionInfo>({
            code: "RESPONSE_MALFORMED",
            message: "The local service opened a session Nova could not read.",
          });
        }
        sessionsIssued = opened.info.sessionsIssued;

        // Whoever asked for this session has gone: the backend was stopped, or
        // the wait was abandoned. The session the service just opened belongs
        // to nobody, so it is ended rather than left behind.
        if (sentGeneration !== generation) {
          abandon({ info: opened.info, token: opened.token });
          return { status: "cancelled" };
        }

        session = { info: opened.info, token: opened.token };
        generation += 1;
        lastError = null;
        return { status: "ok", value: opened.info };
      });

      if (signal.aborted) {
        generation += 1;
        return Promise.resolve({ status: "cancelled" });
      }

      return new Promise<LocalServiceCall<LocalServiceSessionInfo>>((resolve) => {
        const onAbort = () => {
          // Bumped so the answer, whenever it lands, ends what it opened.
          generation += 1;
          resolve({ status: "cancelled" });
        };
        signal.addEventListener("abort", onAbort, { once: true });
        void settled.then(
          (result) => {
            signal.removeEventListener("abort", onAbort);
            resolve(result);
          },
          () => {
            signal.removeEventListener("abort", onAbort);
            resolve(fail({ code: "TRANSPORT_FAILED", message: "Nova could not reach its local service." }));
          },
        );
      });
    },

    health: async (call = {}) => {
      const answer = await send("health", {}, { signal: call.signal, authenticated: true });
      if (answer.status !== "ok") return answer;
      const health = readHealth(answer.value);
      if (health === null) {
        return fail({ code: "RESPONSE_MALFORMED", message: "The local service reported health Nova could not read." });
      }
      sessionsIssued = health.sessionsIssued;
      return { status: "ok", value: health };
    },

    attach: async ({ signal }) => {
      const answer = await send("attach", {}, { signal, authenticated: true });
      if (answer.status !== "ok") return answer;
      const attached = readAttached(answer.value);
      if (attached === null) {
        return fail({ code: "RESPONSE_MALFORMED", message: "The local service answered an attach Nova could not read." });
      }
      return { status: "ok", value: attached };
    },

    detach: async () => {
      const answer = await send("detach", {}, { authenticated: true });
      if (answer.status !== "ok") return answer;
      return { status: "ok", value: null };
    },

    close: async () => {
      const active = session;
      if (active === null) {
        // Nothing to end on the service, but a start in flight must still be
        // told that what it is opening is no longer wanted.
        generation += 1;
        return;
      }

      const mine = generation;
      const answer = await send("shutdown", {}, { authenticated: true });

      // A newer session was opened while the shutdown was in flight — a stop
      // the backend controller abandoned, overtaken by the start that replaced
      // it. The session this close was for is already gone; forgetting now
      // would tear down the one that took its place.
      if (mine !== generation) return;

      // Whatever the service answered, this client no longer holds a session:
      // the token is dropped here and cannot be used again.
      forget({ code: "SESSION_STALE", message: "The local service session was closed by Nova." });
      // A clean close is not a failure, so the diagnostics row is cleared —
      // but a shutdown that never landed is, and it stays visible.
      if (answer.status === "ok") lastError = null;
    },

    forget,
  };
}
