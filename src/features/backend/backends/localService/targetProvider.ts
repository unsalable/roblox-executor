import {
  isSessionLost,
  type LocalServiceError,
  type LocalServiceHealth,
} from "@/features/backend/backends/localService/protocol";
import type { LocalServiceSession } from "@/features/backend/backends/localService/session";
import type {
  InjectOutcome,
  InjectRequest,
  TargetDetection,
  TargetDiagnostics,
  TargetError,
  TargetProvider,
} from "@/features/target/types";
import { systemClock, type Clock, type TimerId } from "@/lib/clock";

/**
 * The target the Local Service backend supplies: the backend's own local
 * service session.
 *
 * **What this target is, stated plainly.** It is not another application, and
 * Nova does not look for one. The thing being detected is the local service
 * that runs beside this window, in this process; the thing "Inject" does is ask
 * that service to attach the open session, which is a state change inside the
 * service and nothing else. No process is enumerated, opened, read or written,
 * no library is loaded into anything, no memory outside this application is
 * touched, no shell is invoked, no executable is launched and no network
 * endpoint is contacted.
 *
 * It reports `simulated: false` because none of that is pretended: the session
 * exists, the service issued it, the attachment is real state that survives
 * this window being asked about it again, and every answer here came back over
 * the IPC bridge rather than from a timer.
 *
 * Three rules the target controller imposes are load-bearing here:
 * `getDiagnostics()` is a synchronous read of cached state that never throws;
 * the session flag flips *before* an outcome is resolved and at the *start* of
 * a disconnect; and availability is announced on a deferred task, never from
 * inside `detect`, `inject` or `disconnect`.
 */

export const LOCAL_SERVICE_TARGET_LABEL = "Local Service Session";
export const LOCAL_SERVICE_TARGET_TYPE = "local-service";

export interface LocalServiceTargetProvider extends TargetProvider {
  /**
   * Applies what a health check found and announces the change, if there is
   * one. Null means the backend has no session to report on.
   */
  applyHealth: (health: LocalServiceHealth | null) => void;
  /** What this provider currently believes, without asking the service. */
  getDetection: () => TargetDetection;
  /** True while Nova holds an attachment on the service. */
  isAttached: () => boolean;
  /** Epoch milliseconds of the current attachment, as the service measured it. */
  getAttachedAt: () => number | null;
  /** Drops the deferred announcement, if one is pending. */
  dispose: () => void;
}

export interface LocalServiceTargetProviderOptions {
  session: LocalServiceSession;
  clock?: Clock;
}

/**
 * Turns a local service refusal into the target vocabulary.
 *
 * Every code is mapped deliberately: a lost session is a disconnect, a protocol
 * or size disagreement is a misconfiguration, and an absent bridge is an absent
 * provider. Nothing falls into a generic bucket, because the UI picks the next
 * action it offers from this code.
 */
function toTargetError(error: LocalServiceError): TargetError {
  const details = error.details === undefined ? error.message : `${error.message} (${error.details})`;

  switch (error.code) {
    // The three `isSessionLost` codes. Written out rather than branched on, so
    // the compiler still proves every code has a mapping.
    case "SESSION_STALE":
    case "AUTH_INVALID":
    case "AUTH_REQUIRED":
      return { code: "TARGET_DISCONNECTED", message: `The ${LOCAL_SERVICE_TARGET_LABEL} ended.`, details };
    case "ALREADY_ATTACHED":
      return { code: "ALREADY_INJECTED", message: "This session is already attached.", details };
    case "TRANSPORT_UNAVAILABLE":
      return {
        code: "PROVIDER_UNAVAILABLE",
        message: "Nova's local service is only reachable from the desktop application.",
        details,
      };
    case "PROTOCOL_UNSUPPORTED":
    case "MESSAGE_TOO_LARGE":
    case "MESSAGE_MALFORMED":
    case "RESPONSE_MALFORMED":
    case "RESPONSE_MISMATCHED":
    case "CAPABILITY_UNSUPPORTED":
    case "OPERATION_UNSUPPORTED":
      return {
        code: "PROVIDER_MISCONFIGURED",
        message: "Nova and its local service do not agree on the protocol.",
        details,
      };
    case "SERVICE_UNAVAILABLE":
    case "REQUEST_TIMEOUT":
    case "TRANSPORT_FAILED":
      return { code: "INJECTION_FAILED", message: `The ${LOCAL_SERVICE_TARGET_LABEL} could not be attached.`, details };
  }
}

export function createLocalServiceTargetProvider(
  options: LocalServiceTargetProviderOptions,
): LocalServiceTargetProvider {
  const { session } = options;
  const clock = options.clock ?? systemClock;

  let available = false;
  let ready = false;
  let version: string | null = null;
  /** Nova's own attachment, not the service's opinion of it. */
  let attached = false;
  let attachedAt: number | null = null;
  let announceTimer: TimerId | null = null;
  const queued: TargetDetection[] = [];

  const listeners = new Set<(detection: TargetDetection) => void>();

  const detection = (): TargetDetection => ({ available, ready, targetVersion: available ? version : null });

  /**
   * Announces on a deferred task.
   *
   * The target controller forbids a synchronous announcement from inside
   * `detect`, `inject` or `disconnect`: it would re-enter the state machine
   * from within an operation that has not finished settling, and an illegal
   * transition thrown from there leaves a request that never resolves.
   *
   * **Every change is queued, and none is coalesced.** The controller reacts to
   * transitions, not to the latest value: the target going away is what ends a
   * session, so a "gone" followed closely by a "back" has to arrive as two
   * announcements. Collapsing them into the newer one would leave Nova
   * believing it was still attached across a restart.
   */
  const announce = () => {
    queued.push(detection());
    if (announceTimer !== null) return;
    announceTimer = clock.setTimeout(() => {
      announceTimer = null;
      for (const current of queued.splice(0)) {
        for (const listener of [...listeners]) listener(current);
      }
    }, 0);
  };

  /**
   * Takes in what a health check found. Returns true when what the controller
   * would be told has changed.
   *
   * An attachment the service no longer has, while Nova still believes it does,
   * is reported as the target going away rather than as a target that is merely
   * "not ready": only `available: false` ends a session in the controller, and
   * leaving Nova thinking it is attached to something it is not would be the
   * one dishonest state this provider could reach.
   */
  const absorb = (health: LocalServiceHealth | null): boolean => {
    const before = detection();

    if (health === null) {
      available = false;
      ready = false;
      version = null;
      attached = false;
      attachedAt = null;
    } else {
      const lostAttachment = attached && !health.attached;
      available = health.target.available && !lostAttachment;
      ready = health.target.ready && !lostAttachment;
      version = health.target.version;
      // Nova's own attachment is authoritative, and a health report can only
      // ever take it away. Adopting one Nova never asked for would put the
      // target controller in "injected" without an injection ever having
      // happened — the one state this provider must not be able to invent.
      attached = attached && health.attached;
      attachedAt = attached ? health.attachedAt : null;
    }

    const after = detection();
    return (
      before.available !== after.available ||
      before.ready !== after.ready ||
      before.targetVersion !== after.targetVersion
    );
  };

  return {
    label: LOCAL_SERVICE_TARGET_LABEL,
    providerType: LOCAL_SERVICE_TARGET_TYPE,
    simulated: false,
    // Real: an attach in flight is abandoned, and an attachment the service
    // completed after the abort is undone rather than kept.
    supportsCancel: true,

    detect: async () => {
      const answer = await session.health();
      if (answer.status === "ok") {
        // Silent on purpose: the controller applies what this pass returns, so
        // announcing the same thing again would report it twice.
        absorb(answer.value);
        return detection();
      }
      if (answer.status === "failed" && isSessionLost(answer.error.code)) absorb(null);
      return detection();
    },

    inject: async (_request: InjectRequest, { signal }): Promise<InjectOutcome> => {
      const answer = await session.attach({ signal });

      if (answer.status === "cancelled") {
        // The abort stopped Nova waiting, not the request. If the service did
        // attach, the attachment is undone rather than left behind, so a
        // cancelled injection never leaves a session Nova does not admit to.
        void session.detach();
        return { status: "cancelled" };
      }
      if (answer.status === "failed") {
        if (isSessionLost(answer.error.code)) {
          absorb(null);
          announce();
        } else {
          // The attach may have reached the service and succeeded there while
          // the answer was lost — a deadline, a failed bridge, an answer Nova
          // could not read. Nova is reporting a failure, so the attachment must
          // not survive it; the detach is the same compensation a cancellation
          // makes, and it is harmless when nothing was attached.
          void session.detach();
        }
        return { status: "failed", error: toTargetError(answer.error) };
      }

      // Synchronously, before the outcome resolves: the controller reads
      // `getDiagnostics().session` in the same turn it applies this result.
      attached = true;
      attachedAt = answer.value.attachedAt;
      available = true;
      ready = true;
      return { status: "injected" };
    },

    disconnect: async () => {
      // Synchronously, at the start: a timeout resolves the request the instant
      // this is called and reads the session flag straight afterwards.
      attached = false;
      attachedAt = null;
      await session.detach();
    },

    getDiagnostics: (): TargetDiagnostics => {
      const { lastLatencyMs } = session.getStats();
      return {
        provider: LOCAL_SERVICE_TARGET_LABEL,
        providerType: LOCAL_SERVICE_TARGET_TYPE,
        simulated: false,
        transport: session.transportKind,
        session: attached ? "active" : "inactive",
        latency: lastLatencyMs === null ? null : `${lastLatencyMs} ms`,
        targetVersion: available ? version : null,
      };
    },

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    applyHealth: (health) => {
      if (absorb(health)) announce();
    },
    getDetection: detection,
    isAttached: () => attached,
    getAttachedAt: () => attachedAt,
    dispose: () => {
      if (announceTimer !== null) clock.clearTimeout(announceTimer);
      announceTimer = null;
      queued.length = 0;
      listeners.clear();
    },
  };
}
