import { config } from "@/app/config";
import { useAppStore } from "@/app/store";
import { useExecution } from "@/features/execution/useExecution";
import { executionDescriptor, targetDescriptor } from "@/features/status/StatusIndicator";
import { bridgeLabel, useTauriBridge } from "@/features/status/useTauriBridge";
import { useTarget } from "@/features/target/useTarget";

/**
 * The environment readout, living inside Settings › Performance
 * instead of occupying the whole window.
 */
export function DiagnosticsList() {
  const { settings } = useAppStore();
  const target = useTarget();
  const execution = useExecution();
  const bridge = useTauriBridge();

  const rows: readonly { label: string; value: string; tone: string }[] = [
    { label: "Frontend", value: "Ready", tone: "text-success" },
    {
      label: "Tauri bridge",
      value: bridgeLabel[bridge.status],
      tone: bridge.status === "ready" ? "text-success" : bridge.status === "error" ? "text-danger" : "text-muted",
    },
    { label: "Environment", value: config.environment, tone: "text-foreground" },
    {
      label: "Runtime",
      value: bridge.status === "ready" ? `Tauri ${bridge.info.tauriVersion}` : "Web view only",
      tone: "text-foreground",
    },
    { label: "Theme", value: settings.appearance.theme, tone: "text-foreground" },
    {
      label: "Target",
      value: `${targetDescriptor[target.status].label} (${target.provider.label}${target.provider.simulated ? ", simulated" : ""})`,
      tone: "text-muted",
    },
    {
      label: "Session",
      value: target.session === "active" ? "Active" : "Disconnected",
      tone: "text-muted",
    },
    {
      label: "Execution",
      value: `${executionDescriptor[execution.phase].label} (${execution.provider.label})`,
      tone: "text-muted",
    },
  ];

  return (
    <dl className="rounded border border-border bg-surface-secondary px-3 py-2 font-mono text-[11px]">
      {rows.map((row) => (
        <div key={row.label} className="flex items-center justify-between gap-6 py-1">
          <dt className="text-subtle">{row.label}</dt>
          <dd className={row.tone}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
