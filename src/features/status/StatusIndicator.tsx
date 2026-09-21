import type { BackendState, ProviderHealth } from "@/features/backend/types";
import type { DebugState } from "@/features/debugger/types";
import type { ExecutionPhase } from "@/features/execution/types";
import type { ProfilerState } from "@/features/profiler/types";
import type { TargetSession, TargetStatus } from "@/features/target/types";

export interface StatusDescriptor {
  label: string;
  /** Text colour token class. */
  tone: string;
  /** Dot treatment. Shape differs per state so colour is not the only signal. */
  shape: "filled" | "ring" | "cross" | "pulse" | "square";
}

/** The injection axis: what the provider reports about the target itself. */
export const targetDescriptor: Record<TargetStatus, StatusDescriptor> = {
  unavailable: { label: "Unavailable", tone: "text-muted", shape: "ring" },
  detected: { label: "Detected", tone: "text-warning", shape: "pulse" },
  ready: { label: "Ready", tone: "text-success", shape: "ring" },
  injecting: { label: "Injecting…", tone: "text-accent", shape: "pulse" },
  injected: { label: "Injected", tone: "text-success", shape: "filled" },
  disconnecting: { label: "Disconnecting…", tone: "text-warning", shape: "pulse" },
  error: { label: "Failed", tone: "text-danger", shape: "cross" },
  cancelled: { label: "Cancelled", tone: "text-warning", shape: "square" },
};

/** The session axis, kept separate: a session existing is not an injection having happened. */
export const sessionDescriptor: Record<TargetSession, StatusDescriptor> = {
  inactive: { label: "Disconnected", tone: "text-muted", shape: "ring" },
  active: { label: "Active", tone: "text-success", shape: "filled" },
};

/**
 * The developer backend's lifecycle axis. Deliberately its own map: a backend
 * being ready is not the same fact as a target being there, and the Developer
 * Status panel shows them on separate rows for exactly that reason.
 */
export const backendDescriptor: Record<BackendState, StatusDescriptor> = {
  created: { label: "Not started", tone: "text-muted", shape: "ring" },
  starting: { label: "Starting…", tone: "text-accent", shape: "pulse" },
  ready: { label: "Ready", tone: "text-success", shape: "filled" },
  stopping: { label: "Stopping…", tone: "text-warning", shape: "pulse" },
  stopped: { label: "Stopped", tone: "text-muted", shape: "square" },
  error: { label: "Failed", tone: "text-danger", shape: "cross" },
};

/** How well one provider can do its job, as the backend reports it. */
export const healthDescriptor: Record<ProviderHealth, StatusDescriptor> = {
  healthy: { label: "Healthy", tone: "text-success", shape: "filled" },
  degraded: { label: "Degraded", tone: "text-warning", shape: "pulse" },
  unavailable: { label: "Unavailable", tone: "text-muted", shape: "ring" },
  error: { label: "Error", tone: "text-danger", shape: "cross" },
};

export const debugDescriptor: Record<DebugState, StatusDescriptor> = {
  unavailable: { label: "Unavailable", tone: "text-muted", shape: "ring" },
  ready: { label: "Ready", tone: "text-success", shape: "ring" },
  running: { label: "Running…", tone: "text-accent", shape: "pulse" },
  paused: { label: "Paused", tone: "text-warning", shape: "filled" },
  stopped: { label: "Stopped", tone: "text-muted", shape: "square" },
  error: { label: "Failed", tone: "text-danger", shape: "cross" },
};

export const profilerDescriptor: Record<ProfilerState, StatusDescriptor> = {
  unavailable: { label: "Unavailable", tone: "text-muted", shape: "ring" },
  ready: { label: "Ready", tone: "text-success", shape: "ring" },
  recording: { label: "Recording…", tone: "text-accent", shape: "pulse" },
  error: { label: "Failed", tone: "text-danger", shape: "cross" },
};

export const executionDescriptor: Record<ExecutionPhase, StatusDescriptor> = {
  idle: { label: "Ready", tone: "text-muted", shape: "ring" },
  preparing: { label: "Preparing…", tone: "text-accent", shape: "pulse" },
  running: { label: "Running…", tone: "text-accent", shape: "pulse" },
  success: { label: "Completed", tone: "text-success", shape: "filled" },
  error: { label: "Failed", tone: "text-danger", shape: "cross" },
  cancelled: { label: "Cancelled", tone: "text-warning", shape: "square" },
};

function Dot({ shape }: { shape: StatusDescriptor["shape"] }) {
  if (shape === "cross") {
    return (
      <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" className="shrink-0">
        <path d="M1 1 7 7M7 1 1 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }

  if (shape === "ring") {
    return <span aria-hidden="true" className="size-2 shrink-0 rounded-full border border-current" />;
  }

  if (shape === "square") {
    return <span aria-hidden="true" className="size-2 shrink-0 rounded-[1px] bg-current" />;
  }

  return (
    <span
      aria-hidden="true"
      className={`size-2 shrink-0 rounded-full bg-current ${shape === "pulse" ? "animate-pulse" : ""}`}
    />
  );
}

interface StatusIndicatorProps {
  descriptor: StatusDescriptor;
  /** Prefix read by assistive tech, e.g. "Target". */
  name: string;
  className?: string;
}

export function StatusIndicator({ descriptor, name, className = "" }: StatusIndicatorProps) {
  return (
    <span className={`flex min-w-0 items-center gap-1.5 ${descriptor.tone} ${className}`}>
      <Dot shape={descriptor.shape} />
      <span className="sr-only">{name}: </span>
      <span className="truncate">{descriptor.label}</span>
    </span>
  );
}
