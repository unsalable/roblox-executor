import { config } from "@/app/config";
import { useAppStore } from "@/app/store";
import { isBackendReady } from "@/features/backend/backendState";
import { useBackend } from "@/features/backend/useBackend";
import { useExecution } from "@/features/execution/useExecution";
import { formatExplorerPath } from "@/features/explorer/explorerModel";
import { useExplorerSelection } from "@/features/explorer/useExplorer";
import {
  backendDescriptor,
  executionDescriptor,
  sessionDescriptor,
  StatusIndicator,
  targetDescriptor,
} from "@/features/status/StatusIndicator";
import { useFrameRate } from "@/features/status/useFrameRate";
import { useTauriBridge } from "@/features/status/useTauriBridge";
import { useTarget } from "@/features/target/useTarget";

/**
 * Three facts, never collapsed into one: what the target reports, whether a
 * session exists, and what the execution pipeline is doing — plus the developer
 * object selected in the Explorer, when there is one.
 *
 * The developer backend is a fourth, and it is shown only while it is not ready.
 * A ready backend explains nothing the target does not already say, but a backend
 * that is starting, stopped or failed is the reason the target is unavailable, and
 * leaving that off the bar would make "Target Unavailable" look like the whole
 * story. The full picture is in the developer diagnostics.
 */
export function StatusBar() {
  const { settings } = useAppStore();
  const { status, session, provider } = useTarget();
  const backend = useBackend();
  const { phase } = useExecution();
  const { node: selected, path } = useExplorerSelection();
  const bridge = useTauriBridge();
  const fps = useFrameRate(settings.performance.showDiagnostics);

  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-border bg-surface px-3 text-[11px]">
      {isBackendReady(backend.state) ? null : (
        <>
          <span className="flex items-center gap-1.5" title={`Developer backend: ${backend.backend.label}`}>
            <span className="shrink-0 text-[10px] tracking-wide text-subtle uppercase">Backend</span>
            <StatusIndicator descriptor={backendDescriptor[backend.state]} name="Backend" />
          </span>
          <span aria-hidden="true" className="h-3 w-px bg-border" />
        </>
      )}

      <span className="flex items-center gap-1.5">
        <StatusIndicator descriptor={targetDescriptor[status]} name="Target" />
        <span className="text-subtle">({provider.label})</span>
      </span>

      <span aria-hidden="true" className="h-3 w-px bg-border" />

      <StatusIndicator descriptor={sessionDescriptor[session]} name="Session" />

      <span aria-hidden="true" className="h-3 w-px bg-border" />

      <StatusIndicator descriptor={executionDescriptor[phase]} name="Execution" />

      {selected ? (
        <>
          <span aria-hidden="true" className="h-3 w-px bg-border" />
          <span
            className="flex min-w-0 items-center gap-1.5"
            title={`Selected in Explorer: ${formatExplorerPath(path)}`}
          >
            <span className="shrink-0 text-[10px] tracking-wide text-subtle uppercase">Selected</span>
            <span className="truncate text-muted">{selected.name}</span>
            <span className="shrink-0 text-subtle">({selected.className})</span>
          </span>
        </>
      ) : null}

      <div className="ml-auto flex items-center gap-4 font-mono text-subtle">
        {fps === null ? null : <span title="Frames per second rendered by this interface">UI {fps} fps</span>}
        <span>{bridge.status === "ready" ? `Tauri ${bridge.info.tauriVersion}` : "Web view"}</span>
        <span>v{config.version}</span>
      </div>
    </footer>
  );
}
