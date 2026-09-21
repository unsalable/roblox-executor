import { memo } from "react";
import type { ConnectionStatus } from "@/features/connection/types";
import { useConnection } from "@/features/connection/useConnection";
import { connectionDescriptor, StatusIndicator } from "@/features/status/StatusIndicator";

const actionLabel: Record<ConnectionStatus, string> = {
  disconnected: "Connect",
  connecting: "Cancel",
  connected: "Disconnect",
  disconnecting: "Disconnect",
  error: "Retry",
};

/**
 * Compact connection surface for the execute bar: status (which opens the
 * diagnostics), the provider it refers to, and one action.
 */
export const ConnectionControl = memo(function ConnectionControl({
  onShowDiagnostics,
}: {
  onShowDiagnostics: () => void;
}) {
  const { status, providerLabel, error, connect, disconnect } = useConnection();
  const descriptor = connectionDescriptor[status];
  const opens = status === "disconnected" || status === "error";

  const actionName =
    status === "connecting"
      ? `Cancel connecting to the ${providerLabel} provider`
      : `${actionLabel[status]} (${providerLabel} provider)`;

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <button
        type="button"
        onClick={onShowDiagnostics}
        aria-label={`Connection diagnostics. ${descriptor.label}, ${providerLabel} provider`}
        title={error ? `${descriptor.label}: ${error.message}` : `${descriptor.label} · ${providerLabel} provider`}
        className="flex min-w-0 items-center gap-2 rounded px-1.5 py-1 text-xs transition-colors duration-[var(--dur-fast)] hover:bg-surface-raised"
      >
        <StatusIndicator key={status} descriptor={descriptor} name="Connection" className="animate-fade-in" />
        <span className="shrink-0 rounded-sm border border-border px-1 text-[10px] tracking-wide text-subtle">
          {providerLabel}
        </span>
      </button>

      <button
        type="button"
        onClick={opens ? connect : disconnect}
        disabled={status === "disconnecting"}
        aria-label={actionName}
        className="h-6 shrink-0 rounded border border-border-strong px-2 text-[11px] text-foreground transition-colors duration-[var(--dur-fast)] hover:border-accent hover:bg-surface-raised disabled:pointer-events-none disabled:opacity-45"
      >
        {actionLabel[status]}
      </button>

      <span role="status" aria-live="polite" className="sr-only">
        {status === "error" && error ? `Connection failed. ${error.message}` : `Connection: ${descriptor.label}`}
      </span>
    </div>
  );
});
