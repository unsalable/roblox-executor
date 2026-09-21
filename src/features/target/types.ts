/**
 * The external-target model.
 *
 * A target is whatever Nova attaches to before it can execute anything. Nova
 * owns the workflow — detection, the inject action, the session, diagnostics,
 * history and every timeout — while a {@link TargetProvider} owns the actual
 * attach mechanism. That split is the point: the provider is a replaceable
 * implementation boundary, and neither provider shipped today reaches outside
 * Nova — one simulates its target, and the other's target is the local service
 * running in Nova's own process.
 */

/**
 * Where the target stands. One authoritative value, owned by the target
 * controller; see `targetState.ts` for the transitions between them.
 *
 * - `unavailable` — no target is visible.
 * - `detected` — the provider can see a target but has not declared it usable.
 * - `ready` — the provider considers it ready for the next action.
 * - `injecting` — an inject request is in flight.
 * - `injected` — the provider reported the target operation completed.
 * - `disconnecting` — the session is being ended.
 * - `error` — the last inject request failed, or the target was lost.
 * - `cancelled` — the last inject request was cancelled.
 */
export type TargetStatus =
  | "unavailable"
  | "detected"
  | "ready"
  | "injecting"
  | "injected"
  | "disconnecting"
  | "error"
  | "cancelled";

/**
 * The session (transport) axis, deliberately kept apart from {@link TargetStatus}.
 * A session existing is not the same fact as an injection having completed, and
 * the UI shows them separately even while one provider drives both.
 */
export type TargetSession = "inactive" | "active";

export type TargetErrorCode =
  /** There is no target to act on. */
  | "TARGET_UNAVAILABLE"
  /** A target is visible but the provider does not consider it ready. */
  | "TARGET_NOT_READY"
  /** An inject request arrived while the target was already injected. */
  | "ALREADY_INJECTED"
  /** The provider attempted the operation and it did not succeed. */
  | "INJECTION_FAILED"
  /** The provider did not finish within the configured timeout. */
  | "INJECTION_TIMEOUT"
  /** The request was cancelled before it completed. */
  | "INJECTION_CANCELLED"
  /** The target went away: unexpectedly, or while a request was in flight. */
  | "TARGET_DISCONNECTED"
  /** No provider is configured, or it refused to start. */
  | "PROVIDER_UNAVAILABLE"
  /** The provider is configured in a way it cannot work with. */
  | "PROVIDER_MISCONFIGURED";

export interface TargetError {
  code: TargetErrorCode;
  /** Short sentence suitable for the UI. */
  message: string;
  /** Technical context, shown in the console and diagnostics. */
  details?: string;
}

/** What one detection pass found. */
export interface TargetDetection {
  readonly available: boolean;
  /** The provider considers the target ready for the next action. */
  readonly ready: boolean;
  /** Version the target reports about itself, when it reports one. */
  readonly targetVersion: string | null;
}

/**
 * Everything a provider may say about itself.
 *
 * Deliberately absent, for every provider: process ids, memory addresses,
 * loaded modules, executable paths and handles. Nova's diagnostics report what
 * Nova itself knows, never data read out of another process.
 */
export interface TargetDiagnostics {
  readonly provider: string;
  readonly providerType: string;
  /** True while the provider is a simulation. The UI must say so where it shows state. */
  readonly simulated: boolean;
  /** How the provider reaches its target, e.g. "Local". */
  readonly transport: string;
  readonly session: TargetSession;
  /** Human-readable latency, e.g. "Simulated"; null when the provider cannot measure one. */
  readonly latency: string | null;
  /** Version reported by the target, e.g. "Test Target v1"; null when unknown. */
  readonly targetVersion: string | null;
}

/**
 * An accepted inject request. It models Nova's workflow and nothing else:
 * there is no address, handle, module or process field here, and there is no
 * script — injecting never depends on one.
 */
export interface InjectRequest {
  readonly requestId: string;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  readonly providerType: string;
}

/** How a provider reports the end of an inject request. */
export type InjectOutcome =
  | { status: "injected" }
  | { status: "failed"; error: TargetError }
  | { status: "cancelled" };

export interface InjectResult {
  readonly requestId: string;
  readonly success: boolean;
  readonly cancelled: boolean;
  readonly durationMs: number;
  /** Set exactly when the request did not succeed. */
  readonly error: TargetError | null;
  /** The provider's own diagnostics as they were when the request ended. */
  readonly diagnostics: TargetDiagnostics;
}

/**
 * The attach mechanism, behind one interface. The controller owns state,
 * timeouts, cancellation, history and logging; a provider detects, injects,
 * disconnects and reports on itself.
 *
 * Diagnostics are read synchronously and availability is pushed through
 * {@link TargetProvider.subscribe}, so the UI stays event-driven and nothing
 * polls a target.
 */
export interface TargetProvider {
  /** Display name, e.g. "Local Test Target". */
  readonly label: string;
  /** Machine-readable family, e.g. "local-test". */
  readonly providerType: string;
  /** True when this provider simulates its target rather than attaching to one. */
  readonly simulated: boolean;
  /**
   * False when the provider cannot stop an injection once it has started. Such
   * a provider is never reported as cancelled; the controller answers
   * `unsupported` instead of claiming a cancellation that did not happen.
   */
  readonly supportsCancel: boolean;
  /** Looks for the target once. */
  detect: () => Promise<TargetDetection>;
  /** Runs one inject request, honouring `signal` when it supports cancellation. */
  inject: (request: InjectRequest, options: { signal: AbortSignal }) => Promise<InjectOutcome>;
  /** Ends the session. Safe to call when there is none. */
  disconnect: () => Promise<void>;
  getDiagnostics: () => TargetDiagnostics;
  /** Availability changes the provider notices by itself. */
  subscribe: (listener: (detection: TargetDetection) => void) => () => void;
}

export type TargetHistoryStatus = "injected" | "failed" | "timeout" | "cancelled" | "disconnected";

/**
 * A finished target operation, as kept for this session. It holds workflow
 * metadata only: no script source, no process data.
 */
export interface TargetHistoryEntry {
  readonly requestId: string;
  /** Epoch milliseconds. */
  readonly startedAt: number;
  readonly provider: string;
  readonly status: TargetHistoryStatus;
  /** Null for entries that measure nothing, such as a disconnect. */
  readonly durationMs: number | null;
  readonly error: { code: TargetErrorCode; message: string } | null;
}

export interface TargetSnapshot {
  readonly status: TargetStatus;
  /** A detection pass is in flight. */
  readonly detecting: boolean;
  readonly session: TargetSession;
  /** The request in flight, or the last one to finish; null before the first. */
  readonly request: InjectRequest | null;
  /** Result of `request`, set once it has ended. */
  readonly result: InjectResult | null;
  /** Cancellation was requested and the provider has not stopped yet. */
  readonly cancelling: boolean;
  /** The latest failure, set while `status` is "error". */
  readonly error: TargetError | null;
  readonly diagnostics: TargetDiagnostics;
  /** Newest first. */
  readonly history: readonly TargetHistoryEntry[];
}
