import { memo, useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import type { StudioBridge } from "@/features/bridge/session";
import { STUDIO_CONNECTION_LABEL } from "@/features/bridge/studioProvider";
import type { BridgeSnapshot } from "@/features/bridge/types";
import { useBridgeSnapshot } from "@/features/bridge/useBridge";
import { useConnection } from "@/features/connection/useConnection";
import { StatusIndicator, type StatusDescriptor } from "@/features/status/StatusIndicator";

/**
 * The execute-bar surface for the Studio development bridge. It deliberately
 * shows two states, because they are two different things: the bridge Nova
 * runs, and whether a Studio plugin is actually connected to it. Only the
 * second one means scripts can be sent.
 */

function describeBridge(snapshot: BridgeSnapshot): StatusDescriptor {
  switch (snapshot.phase) {
    case "stopped":
      return { label: "Off", tone: "text-muted", shape: "ring" };
    case "starting":
      return { label: "Starting…", tone: "text-warning", shape: "pulse" };
    case "stopping":
      return { label: "Stopping…", tone: "text-warning", shape: "pulse" };
    case "error":
      return { label: "Failed", tone: "text-danger", shape: "cross" };
    default:
      return { label: "Listening", tone: "text-success", shape: "filled" };
  }
}

function describeStudio(snapshot: BridgeSnapshot): StatusDescriptor {
  if (snapshot.studioConnected) return { label: "Connected", tone: "text-success", shape: "filled" };
  if (snapshot.phase === "connecting") return { label: "Pairing…", tone: "text-warning", shape: "pulse" };
  if (snapshot.listening) return { label: "Waiting", tone: "text-muted", shape: "ring" };
  return { label: "Not connected", tone: "text-muted", shape: "ring" };
}

/** Groups the code so it is easy to read aloud and to type: "481 273". */
function groupCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

function PairingPanel({
  snapshot,
  onCancel,
  onDismiss,
}: {
  snapshot: BridgeSnapshot;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const pairing = snapshot.pairing;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!pairing) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pairing]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onDismiss]);

  if (!pairing) return null;
  const remaining = Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000));

  return (
    <div
      role="dialog"
      aria-label="Pair Roblox Studio"
      className="animate-fade-in absolute bottom-11 left-0 z-20 w-72 rounded-md border border-border-strong bg-surface-raised p-3 shadow-lg"
    >
      <div className="flex items-start justify-between">
        <h2 className="text-xs font-semibold text-foreground">Pair Roblox Studio</h2>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Hide pairing"
          className="rounded p-0.5 text-subtle transition-colors duration-[var(--dur-fast)] hover:bg-surface hover:text-foreground"
        >
          <Icon name="close" size={12} />
        </button>
      </div>

      <p className="mt-2 text-center font-mono text-2xl tracking-[0.2em] text-foreground tabular-nums">
        {groupCode(pairing.code)}
      </p>

      <p className="mt-2 text-[11px] leading-relaxed text-muted">
        Open the Nova panel in Roblox Studio, point it at{" "}
        <span className="font-mono text-foreground">{snapshot.address ?? "127.0.0.1"}</span> and enter this code.
      </p>

      <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
        <span className="text-[11px] text-subtle tabular-nums">
          {remaining > 0 ? `Expires in ${remaining} s` : "Expired"}
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="h-6 rounded border border-border-strong px-2 text-[11px] text-foreground transition-colors duration-[var(--dur-fast)] hover:border-danger/60 hover:text-danger"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The one contextual action for the bridge, shared by the execute bar's status
 * area so both places offer exactly the same next step.
 */
export function useStudioBridgeAction(bridge: StudioBridge): { label: string; run: () => void; busy: boolean } {
  const snapshot = useBridgeSnapshot(bridge);
  const { connect } = useConnection();

  if (snapshot.studioConnected) return { label: "Disconnect", run: () => void bridge.disconnectStudio(), busy: false };
  if (snapshot.listening) return { label: "Pair Studio", run: () => void bridge.offerPairing(), busy: false };
  return { label: "Start bridge", run: connect, busy: snapshot.phase === "starting" || snapshot.phase === "stopping" };
}

export const StudioBridgeControl = memo(function StudioBridgeControl({
  bridge,
  onShowDiagnostics,
}: {
  bridge: StudioBridge;
  onShowDiagnostics: () => void;
}) {
  const snapshot = useBridgeSnapshot(bridge);
  const action = useStudioBridgeAction(bridge);
  // A hidden offer stays hidden until a new code is issued.
  const [hiddenCode, setHiddenCode] = useState<string | null>(null);

  const bridgeStatus = describeBridge(snapshot);
  const studioStatus = describeStudio(snapshot);
  const showPairing = snapshot.pairing !== null && snapshot.pairing.code !== hiddenCode;

  return (
    <div className="relative flex min-w-0 items-center gap-1.5">
      <button
        type="button"
        onClick={onShowDiagnostics}
        aria-label={`Bridge diagnostics. Bridge ${bridgeStatus.label}, Studio ${studioStatus.label}`}
        title={
          snapshot.error
            ? `${snapshot.error.message}${snapshot.error.details ? ` (${snapshot.error.details})` : ""}`
            : `${STUDIO_CONNECTION_LABEL} · ${snapshot.address ?? "bridge not started"}`
        }
        className="flex min-w-0 items-center gap-2 rounded px-1.5 py-1 text-xs transition-colors duration-[var(--dur-fast)] hover:bg-surface-raised"
      >
        <span className="flex min-w-0 items-center gap-1">
          <span className="shrink-0 text-[10px] tracking-wide text-subtle uppercase">Bridge</span>
          <StatusIndicator key={snapshot.phase} descriptor={bridgeStatus} name="Bridge" className="animate-fade-in" />
        </span>
        <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />
        <span className="flex min-w-0 items-center gap-1">
          <span className="shrink-0 text-[10px] tracking-wide text-subtle uppercase">Studio</span>
          <StatusIndicator
            key={studioStatus.label}
            descriptor={studioStatus}
            name="Studio"
            className="animate-fade-in"
          />
        </span>
      </button>

      <button
        type="button"
        onClick={action.run}
        disabled={action.busy}
        aria-label={`${action.label} (${STUDIO_CONNECTION_LABEL})`}
        className="h-6 shrink-0 rounded border border-border-strong px-2 text-[11px] text-foreground transition-colors duration-[var(--dur-fast)] hover:border-accent hover:bg-surface-raised disabled:pointer-events-none disabled:opacity-45"
      >
        {action.label}
      </button>

      {showPairing ? (
        <PairingPanel
          snapshot={snapshot}
          onCancel={() => bridge.cancelPairing()}
          onDismiss={() => setHiddenCode(snapshot.pairing?.code ?? null)}
        />
      ) : null}

      <span role="status" aria-live="polite" className="sr-only">
        {`Bridge ${bridgeStatus.label}. Studio ${studioStatus.label}.`}
      </span>
    </div>
  );
});
