import { useEffect, useState } from "react";
import { config } from "@/app/config";
import { BrandMark, Icon, type IconName } from "@/components/ui/Icon";
import { runningInTauri, subscribeToMaximizeState, windowControls } from "@/lib/tauri";

interface TitleBarProps {
  onOpenSettings: () => void;
  /** Shown next to the app name so the active document is visible at a glance. */
  documentName: string | null;
  /** The close button asks the shell, which may confirm unsaved changes first. */
  onRequestClose: () => void;
}

function ControlButton({
  icon,
  label,
  onClick,
  destructive = false,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex h-full w-11 items-center justify-center text-muted transition-colors duration-[var(--dur-fast)] ${
        destructive ? "hover:bg-danger hover:text-white" : "hover:bg-surface-raised hover:text-foreground"
      }`}
    >
      <Icon name={icon} size={14} />
    </button>
  );
}

export function TitleBar({ onOpenSettings, documentName, onRequestClose }: TitleBarProps) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => subscribeToMaximizeState(setMaximized), []);

  return (
    <header
      data-tauri-drag-region
      className="flex h-8 shrink-0 items-center border-b border-border bg-surface pl-3 select-none"
    >
      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-2">
        <BrandMark size={14} className="shrink-0 text-accent" />
        <span data-tauri-drag-region className="text-xs font-semibold tracking-wide">
          {config.appName}
        </span>
        {documentName ? (
          <>
            <span data-tauri-drag-region aria-hidden="true" className="text-subtle">
              /
            </span>
            <span data-tauri-drag-region className="truncate text-xs text-muted">
              {documentName}
            </span>
          </>
        ) : null}
      </div>

      <button
        type="button"
        onClick={onOpenSettings}
        aria-label="Open settings"
        title="Settings"
        className="flex h-full items-center gap-1.5 px-3 text-xs text-muted transition-colors duration-[var(--dur-fast)] hover:bg-surface-raised hover:text-foreground"
      >
        <Icon name="settings" size={14} />
        <span className="hidden sm:inline">Settings</span>
      </button>

      {runningInTauri ? (
        <div className="flex h-full items-stretch">
          <ControlButton icon="minimize" label="Minimize" onClick={() => void windowControls.minimize()} />
          <ControlButton
            icon={maximized ? "restore" : "maximize"}
            label={maximized ? "Restore" : "Maximize"}
            onClick={() => void windowControls.toggleMaximize()}
          />
          <ControlButton icon="close" label="Close" destructive onClick={onRequestClose} />
        </div>
      ) : (
        <span className="px-3 text-[10px] tracking-wide text-subtle uppercase" title="Window controls are provided by the browser in web preview mode">
          Web preview
        </span>
      )}
    </header>
  );
}
