import { useEffect, useMemo, useRef } from "react";
import { Icon } from "@/components/ui/Icon";
import type { ScriptWorkspace } from "@/features/scripts/useScriptWorkspace";

interface TabBarProps {
  workspace: ScriptWorkspace;
  /** Closing may need a confirmation, so the tab bar only asks. */
  onRequestClose: (id: string) => void;
  onCreateScript: () => void;
}

export function TabBar({ workspace, onRequestClose, onCreateScript }: TabBarProps) {
  const { scripts, openScriptIds, activeScriptId, setActiveScript } = workspace;
  const listRef = useRef<HTMLDivElement>(null);

  const openScripts = useMemo(() => {
    const byId = new Map(scripts.map((script) => [script.id, script]));
    return openScriptIds.map((id) => byId.get(id)).filter((script) => script !== undefined);
  }, [scripts, openScriptIds]);

  useEffect(() => {
    if (activeScriptId === null) return;
    listRef.current
      ?.querySelector(`[data-script-id="${CSS.escape(activeScriptId)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeScriptId, openScriptIds]);

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-border bg-surface">
      <div ref={listRef} role="tablist" aria-label="Open scripts" className="flex min-w-0 flex-1 overflow-x-auto">
        {openScripts.map((script) => {
          const isActive = script.id === activeScriptId;

          return (
            <div
              key={script.id}
              data-script-id={script.id}
              onAuxClick={(event) => {
                if (event.button === 1) onRequestClose(script.id);
              }}
              className={`group relative flex shrink-0 items-center border-r border-border transition-colors duration-[var(--dur-fast)] ${
                isActive ? "bg-background" : "bg-surface hover:bg-surface-secondary"
              }`}
            >
              <span
                aria-hidden="true"
                className={`absolute inset-x-0 top-0 h-0.5 transition-opacity duration-[var(--dur-fast)] ${
                  isActive ? "bg-accent opacity-100" : "opacity-0"
                }`}
              />
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveScript(script.id)}
                title={script.isDirty ? `${script.name} — unsaved changes` : script.name}
                className={`flex max-w-52 items-center gap-2 py-2 pr-1 pl-3 text-xs transition-colors duration-[var(--dur-fast)] ${
                  isActive ? "text-foreground" : "text-muted group-hover:text-foreground"
                }`}
              >
                <span className="truncate">{script.name}</span>
                {script.isDirty ? <span className="sr-only">(unsaved changes)</span> : null}
              </button>
              {/* The close control doubles as the unsaved marker: a dot that turns into × on hover or focus. */}
              <button
                type="button"
                onClick={() => onRequestClose(script.id)}
                aria-label={`Close ${script.name}${script.isDirty ? " (unsaved changes)" : ""}`}
                title={`Close ${script.name} (Ctrl+W)`}
                className={`mr-1.5 grid size-5 place-items-center rounded text-subtle transition-opacity duration-[var(--dur-fast)] group-hover:opacity-100 hover:bg-surface-raised hover:text-foreground focus-visible:opacity-100 ${
                  script.isDirty || isActive ? "opacity-100" : "opacity-0"
                }`}
              >
                {script.isDirty ? (
                  <>
                    <span
                      aria-hidden="true"
                      className="col-start-1 row-start-1 size-2 rounded-full bg-warning group-hover:opacity-0 [button:focus-visible>&]:opacity-0"
                    />
                    <Icon
                      name="close"
                      size={12}
                      className="col-start-1 row-start-1 opacity-0 group-hover:opacity-100 [button:focus-visible>&]:opacity-100"
                    />
                  </>
                ) : (
                  <Icon name="close" size={12} className={isActive ? "opacity-60 group-hover:opacity-100" : ""} />
                )}
              </button>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onCreateScript}
        aria-label="New script"
        title="New script (Ctrl+T)"
        className="flex w-9 shrink-0 items-center justify-center border-l border-border text-muted transition-colors duration-[var(--dur-fast)] hover:bg-surface-secondary hover:text-foreground"
      >
        <Icon name="plus" size={14} />
      </button>
    </div>
  );
}
