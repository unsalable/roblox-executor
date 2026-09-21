import type { DebuggerProvider } from "@/features/debugger/types";
import type { ProfilerProvider } from "@/features/profiler/types";
import type { TargetProvider } from "@/features/target/types";

/**
 * The developer backend model: the adapter layer between Nova's tool
 * controllers and the provider implementations underneath them.
 *
 * ```text
 * Nova UI → tool controllers → provider interfaces → adapter layer → backend
 * ```
 *
 * A {@link DeveloperBackend} is one coherent set of developer providers with a
 * lifecycle of its own. It exists so the tool providers stop being three
 * unrelated implementation choices made in the composition root: they are the
 * providers *one* backend supplies, they are started and stopped together, and
 * the UI can ask what that backend supports instead of assuming.
 *
 * **Backend lifecycle is not target lifecycle.** A backend can be ready while
 * no target is there, and a target can be there while one of the tools is not
 * supported at all. The three facts stay separate everywhere:
 *
 * ```text
 * Backend ready   Target unavailable   Debugger unavailable   ← all valid together
 * ```
 *
 * Deliberately absent from every type here, as in every provider it composes:
 * process ids, process handles, memory addresses, module lists, executable
 * paths and evaluated code. This layer decides *which* implementation answers a
 * tool's questions; it grants no ability to reach outside Nova, and neither
 * backend shipped today reaches outside it — one simulates its answers and the
 * other gets them from a service in Nova's own process.
 */

/** The developer tools a backend supplies, in the order the UI lists them. */
export const DEVELOPER_TOOLS = ["target", "debugger", "profiler"] as const;

export type DeveloperTool = (typeof DEVELOPER_TOOLS)[number];

/**
 * Where a backend stands. One authoritative value, owned by the backend
 * controller; see `backendState.ts` for the transitions between them.
 *
 * - `created` — the backend has been composed and has not been started.
 * - `starting` — a start request is in flight.
 * - `ready` — the backend's providers may be used.
 * - `stopping` — the backend is being stopped.
 * - `stopped` — the backend was started and has been stopped again.
 * - `error` — the last lifecycle operation failed.
 */
export type BackendState = "created" | "starting" | "ready" | "stopping" | "stopped" | "error";

/**
 * How well one provider can do its job right now.
 *
 * - `healthy` — the provider is wired and reports nothing wrong.
 * - `degraded` — usable, but not everything it normally offers works.
 * - `unavailable` — the backend does not supply this tool, or it cannot be used yet.
 * - `error` — the provider reported a failure.
 */
export type ProviderHealth = "healthy" | "degraded" | "unavailable" | "error";

export type BackendErrorCode =
  /** The backend does not supply this provider at all. */
  | "PROVIDER_UNAVAILABLE"
  /** The backend was asked to start and the attempt did not succeed. */
  | "PROVIDER_START_FAILED"
  /** The backend was asked to stop and the attempt did not succeed. */
  | "PROVIDER_STOP_FAILED"
  /** The backend did not answer within the lifecycle timeout. */
  | "PROVIDER_TIMEOUT"
  /** The operation needs a capability this provider does not declare. */
  | "PROVIDER_CAPABILITY_UNSUPPORTED"
  /** The backend stopped, or a provider went away, while something depended on it. */
  | "PROVIDER_DISCONNECTED"
  /** The backend is not in a state that allows the operation. */
  | "PROVIDER_INVALID_STATE"
  /** The backend needs a local channel this build of Nova does not have. */
  | "PROVIDER_TRANSPORT_UNAVAILABLE"
  /** The backend would not accept the session Nova presented. */
  | "PROVIDER_AUTH_FAILED"
  /** The session the backend was using has ended and cannot be used again. */
  | "PROVIDER_SESSION_STALE"
  /** Nova and the backend do not agree on the protocol between them. */
  | "PROVIDER_PROTOCOL_MISMATCH";

export interface BackendError {
  code: BackendErrorCode;
  /** Short sentence suitable for the UI. */
  message: string;
  /** Technical context, shown in the console and the Developer Status panel. */
  details?: string;
}

/**
 * The one thing every developer provider says about itself, whichever tool it
 * serves. This is the common contract the adapter layer adds: the tools keep their own
 * behavioural interfaces — a target detects and injects, a debugger steps, a
 * profiler records — because those genuinely differ, while identity, honesty
 * about being simulated and a sentence for the UI are the same question every
 * time and are asked once here.
 */
export interface DeveloperProviderInfo {
  readonly tool: DeveloperTool;
  /** Display name, e.g. "Local Test Target". */
  readonly label: string;
  /** Machine-readable family, e.g. "local-test". */
  readonly providerType: string;
  /** True when the provider simulates its subject rather than observing one. */
  readonly simulated: boolean;
  /** One sentence the UI shows wherever the provider is named. */
  readonly description: string;
}

/** What a backend reports about one of its providers. */
export interface ProviderHealthReport {
  readonly tool: DeveloperTool;
  readonly health: ProviderHealth;
  /** Why it is not healthy, written for a developer. Null while it is. */
  readonly reason: string | null;
}

/**
 * What the target provider of this backend can do.
 *
 * Every flag here is derived from something that genuinely varies: whether the
 * backend supplies the tool at all, and what the provider declares about
 * itself. Nothing is listed that is true for every provider by construction.
 */
export interface TargetCapabilities {
  /** The backend supplies a target provider, so detection and injection exist. */
  readonly canConnect: boolean;
  /** The provider can stop an injection once it has started. */
  readonly canCancelInject: boolean;
}

export interface DebuggerCapabilities {
  /** The backend supplies a debugger provider, so sessions, stepping and breakpoints exist. */
  readonly canDebug: boolean;
  /** The provider can stop a run once it has started, which is what Pause needs. */
  readonly canPause: boolean;
}

export interface ProfilerCapabilities {
  /** The backend supplies a profiler provider, so recordings exist. */
  readonly canProfile: boolean;
}

/** Everything the UI may ask about what this backend supports. */
export interface BackendCapabilities {
  readonly target: TargetCapabilities;
  readonly debugger: DebuggerCapabilities;
  readonly profiler: ProfilerCapabilities;
}

/**
 * One row of backend-specific diagnostics: what a particular backend can say
 * about itself that the lifecycle model has no field for — its transport, its
 * protocol, its session.
 *
 * Label and value, because there is nothing general to say about what a backend
 * knows: the lifecycle, the capabilities and the health are already modelled,
 * and this is deliberately the least structured possible way to add the rest
 * rather than a second model that every backend then has to fit.
 *
 * **A secret never belongs in one.** These rows are rendered in the Developer
 * Status panel verbatim, so a value here is a value on screen: no token, no
 * credential and no path that the existing diagnostics do not already show.
 */
export interface BackendDiagnostic {
  readonly label: string;
  readonly value: string;
}

/** Identity of a backend, as the registry and the UI know it. */
export interface BackendDescriptor {
  /** Stable id, used as the persisted user preference, e.g. "local-mock". */
  readonly id: string;
  /** Display name, e.g. "Local Mock". */
  readonly label: string;
  /** True while every provider it supplies is a simulation. The UI must say so. */
  readonly simulated: boolean;
  /** One sentence the UI shows wherever the backend is named. */
  readonly description: string;
}

/**
 * The providers one backend supplies. `null` means this backend does not
 * support that tool — it is never a provider that pretends to work, and the
 * capability derived from it is false.
 */
export interface BackendProviders {
  readonly target: TargetProvider | null;
  readonly debugger: DebuggerProvider | null;
  readonly profiler: ProfilerProvider | null;
}

/** How a backend reports the end of a start request. */
export type BackendStartOutcome =
  | { status: "started" }
  | { status: "failed"; error: BackendError }
  | { status: "cancelled" };

/**
 * One coherent set of developer providers, behind one interface.
 *
 * The controller owns the state machine, the lifecycle timeouts, cancellation,
 * capabilities, health and what reaches the console; a backend only starts,
 * stops and describes itself and its providers.
 *
 * **Providers are handed over once, at construction, and never swapped.** A
 * backend's lifecycle changes whether its providers can be *used*, not which
 * objects they are, so the tool controllers — and with them the editor, the
 * open scripts and the breakpoints — are built once and survive a restart.
 */
export interface DeveloperBackend {
  readonly descriptor: BackendDescriptor;
  readonly providers: BackendProviders;
  /**
   * Makes the providers usable. Honours `signal`, and is only ever called from
   * the resting states, so it does not have to be idempotent itself.
   */
  start: (options: { signal: AbortSignal }) => Promise<BackendStartOutcome>;
  /** Stops the providers and ends whatever they hold. Safe to call when stopped. */
  stop: () => Promise<void>;
  /** How each tool is doing, one report per tool it knows about. Read synchronously. */
  getHealth: () => readonly ProviderHealthReport[];
  /**
   * What this backend can say about itself beyond the shared lifecycle model.
   * Optional: a backend with nothing of its own to report supplies none, and
   * the panel shows the section only when there is something in it. Read
   * synchronously, like {@link DeveloperBackend.getHealth}.
   */
  getDiagnostics?: () => readonly BackendDiagnostic[];
  /**
   * Tells the controller that this backend's own view of its health has moved
   * — which, for a backend that watches something, happens without anybody
   * asking.
   *
   * Optional, because the first backend did not need it: a backend whose health
   * only changes when a provider does is already covered by the provider's own
   * subscription. A backend that can *lose* what it is talking to is not, and
   * without this the panel would keep showing the last answer until something
   * unrelated happened to ask again.
   */
  subscribeHealth?: (listener: () => void) => () => void;
}

export interface BackendSnapshot {
  readonly state: BackendState;
  /** A lifecycle operation is in flight. */
  readonly busy: boolean;
  /** Epoch milliseconds the backend last became ready; null until it has been. */
  readonly readySince: number | null;
  readonly capabilities: BackendCapabilities;
  /** One entry per developer tool, in {@link DEVELOPER_TOOLS} order. */
  readonly health: readonly ProviderHealthReport[];
  /** The providers this backend supplies; a tool it does not supply is absent. */
  readonly providers: readonly DeveloperProviderInfo[];
  /** The latest failure, set while `state` is "error". */
  readonly error: BackendError | null;
  /** Epoch milliseconds `error` was recorded; null while there is none. */
  readonly errorAt: number | null;
  /** What this backend says about itself; empty when it says nothing. */
  readonly diagnostics: readonly BackendDiagnostic[];
}
