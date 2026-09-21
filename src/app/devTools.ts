import type { DebuggerController } from "@/features/debugger/debuggerController";
import type { ProfilerController } from "@/features/profiler/profilerController";
import { isTargetPresent } from "@/features/target/targetState";
import type { TargetStatus } from "@/features/target/types";

/**
 * The one link between the backend, the target and the developer tools.
 *
 * The debugger and the profiler have no target state and no backend state of
 * their own: they are told whether they have something to work against, and
 * nothing else. Three separate facts decide that, and they are never collapsed
 * into one:
 *
 * ```text
 * Backend ready?   the backend controller's lifecycle
 * Target present?  the target controller's status
 * Tool supported?  the backend's capabilities
 * ```
 *
 * ```text
 * Backend stopped              → Debugger unavailable, Profiler unavailable
 * Backend ready, no target     → Debugger unavailable, Profiler unavailable
 * Backend ready, target there  → Debugger ready, Profiler ready
 * Backend supplies no debugger → Debugger unavailable, whatever the target does
 * Target lost while active     → session stopped, recording stopped
 * ```
 *
 * A backend stopping and a target going away stay two different events with two
 * different sources; this is only where both answers meet.
 */

/** What the binding needs from the target controller, and nothing more. */
export interface DevToolsTargetSource {
  getStatus: () => TargetStatus;
  subscribe: (listener: () => void) => () => void;
}

/** What the binding needs from the backend controller, and nothing more. */
export interface DevToolsBackendSource {
  isReady: () => boolean;
  subscribe: (listener: () => void) => () => void;
}

/** Which tools the active backend supplies at all. */
export interface DevToolsSupport {
  debugger: boolean;
  profiler: boolean;
}

export interface DevToolsBinding {
  target: DevToolsTargetSource;
  /**
   * The backend the providers come from. Omitted, the tools follow the target
   * alone, which is all there was to follow before backends existed.
   */
  backend?: DevToolsBackendSource;
  /** Defaults to both supported, so a backend that supplies everything needs no flags. */
  supports?: DevToolsSupport;
  debug: Pick<DebuggerController, "setTargetPresent">;
  profiler: Pick<ProfilerController, "setTargetPresent">;
}

/** Applies what the tools have to work against, now and whenever it changes. */
export function bindDevToolsToTarget({ target, backend, supports, debug, profiler }: DevToolsBinding): () => void {
  const canDebug = supports?.debugger ?? true;
  const canProfile = supports?.profiler ?? true;

  const apply = () => {
    const usable = (backend?.isReady() ?? true) && isTargetPresent(target.getStatus());
    debug.setTargetPresent(usable && canDebug);
    profiler.setTargetPresent(usable && canProfile);
  };

  apply();
  const unwatchTarget = target.subscribe(apply);
  const unwatchBackend = backend?.subscribe(apply);

  return () => {
    unwatchTarget();
    unwatchBackend?.();
  };
}
