import type { ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import { NAV_ITEMS, type WorkspaceView } from "@/components/layout/navigation";

interface SidebarProps {
  view: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  consoleOpen: boolean;
  onToggleConsole: () => void;
  /**
   * The script manager. It stays mounted while the sidebar is collapsed or
   * another view is shown, so folder expansion and search survive toggling.
   */
  scripts: ReactNode;
  /** The developer Explorer, mounted on the same terms as the script manager. */
  explorer: ReactNode;
}

export function Sidebar({
  view,
  onViewChange,
  collapsed,
  onToggleCollapsed,
  consoleOpen,
  onToggleConsole,
  scripts,
  explorer,
}: SidebarProps) {
  const showScripts = !collapsed && view === "scripts";
  const showExplorer = !collapsed && view === "explorer";

  return (
    <aside
      className={`flex shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-[var(--dur-base)] ease-[var(--ease-out)] ${
        collapsed ? "w-12" : "w-56"
      }`}
    >
      <nav aria-label="Workspace" className="p-2">
        {NAV_ITEMS.map((item) => {
          const isConsole = item.id === "console";
          const isActive = isConsole ? consoleOpen : item.id === view;

          return (
            <button
              key={item.id}
              type="button"
              onClick={() => (isConsole ? onToggleConsole() : onViewChange(item.id as WorkspaceView))}
              title={collapsed ? item.label : undefined}
              aria-label={item.label}
              {...(isConsole ? { "aria-pressed": consoleOpen } : { "aria-current": isActive })}
              className={`relative mb-0.5 flex h-8 w-full items-center gap-2.5 rounded px-2 text-xs transition-colors duration-[var(--dur-fast)] ${
                isActive
                  ? "bg-accent-soft text-foreground"
                  : "text-muted hover:bg-surface-raised hover:text-foreground"
              }`}
            >
              <span
                aria-hidden="true"
                className={`absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full transition-opacity duration-[var(--dur-fast)] ${
                  isActive && !isConsole ? "bg-accent opacity-100" : "opacity-0"
                }`}
              />
              <Icon name={item.icon} size={16} className={`shrink-0 ${isActive ? "text-accent" : ""}`} />
              {collapsed ? null : <span className="truncate">{item.label}</span>}
            </button>
          );
        })}
      </nav>

      <div className="flex min-h-0 flex-1 flex-col" hidden={!showScripts}>
        {scripts}
      </div>
      <div className="flex min-h-0 flex-1 flex-col" hidden={!showExplorer}>
        {explorer}
      </div>
      {showScripts || showExplorer ? null : <div className="flex-1" />}

      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        className="flex h-8 shrink-0 items-center gap-2.5 border-t border-border px-3.5 text-xs text-subtle transition-colors duration-[var(--dur-fast)] hover:bg-surface-raised hover:text-foreground"
      >
        <Icon name={collapsed ? "chevronRight" : "chevronLeft"} size={14} className="shrink-0" />
        {collapsed ? null : <span>Collapse</span>}
      </button>
    </aside>
  );
}
