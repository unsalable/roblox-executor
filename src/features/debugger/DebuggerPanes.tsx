import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Panel, PanelAction, PanelEmpty } from "@/components/ui/Panel";
import { breakpointsForScript } from "@/features/debugger/breakpoints";
import type {
  Breakpoint,
  DebugState,
  StackFrame,
  Variable,
  WatchEntry,
} from "@/features/debugger/types";

/**
 * The four panes of the debugger: where execution is, what it can see, where it
 * will stop and what the user asked to keep an eye on.
 *
 * They render controller state and ask the controller to change it; none of
 * them keeps debugger state of its own, so the editor gutter and the breakpoint
 * list can never disagree.
 */

const SCOPE_LABEL: Record<Variable["scope"], string> = {
  local: "local",
  upvalue: "upvalue",
  global: "global",
};

export function CallStackPane({
  unavailableReason,
  stack,
  currentFrameId,
  state,
  scriptName,
  onSelect,
  onReveal,
}: {
  stack: readonly StackFrame[];
  currentFrameId: string | null;
  state: DebugState;
  /**
   * Why the tool has nothing to work against, named outermost cause first: a
   * backend that supplies no debugger, then one that is not running, then the
   * target. Blaming the target for all three was wrong the moment a backend
   * that supplies no debugger existed.
   */
  unavailableReason: string;
  scriptName: string | null;
  onSelect: (frameId: string) => void;
  /** Shows the frame's line in the editor, which leaves the Debugger view. */
  onReveal: (frameId: string) => void;
}) {
  return (
    <Panel title="Call Stack" badge={stack.length > 0 ? `${stack.length}` : undefined}>
      {stack.length === 0 ? (
        state === "running" ? (
          <PanelEmpty title="Running" detail="The stack appears when execution stops." icon="debugger" />
        ) : state === "unavailable" ? (
          <PanelEmpty title="Unavailable" detail={unavailableReason} icon="debugger" />
        ) : (
          <PanelEmpty
            title="No active debug session"
            detail="Start a debug session to inspect execution."
            icon="debugger"
          />
        )
      ) : (
        <ul className="py-1">
          {stack.map((frame) => {
            const selected = frame.id === currentFrameId;
            return (
              <li key={frame.id}>
                <button
                  type="button"
                  onClick={() => onSelect(frame.id)}
                  onDoubleClick={() => onReveal(frame.id)}
                  onKeyDown={(event) => {
                    // Enter selects; the editor is only opened when it is asked for.
                    if (event.key !== "Enter" || !event.shiftKey) return;
                    event.preventDefault();
                    onReveal(frame.id);
                  }}
                  aria-current={selected}
                  title="Select this frame · double-click or Shift+Enter to show the line in the editor"
                  className={`flex w-full items-baseline gap-2 px-3 py-1 text-left text-[11px] transition-colors duration-[var(--dur-fast)] ${
                    selected ? "bg-accent-soft text-foreground" : "text-muted hover:bg-surface-raised"
                  }`}
                >
                  <span className="w-4 shrink-0 font-mono text-[10px] text-subtle">{frame.depth}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-code-function">{frame.functionName}</span>
                  <span className="shrink-0 font-mono text-[10px] text-subtle">
                    {scriptName ?? frame.scriptId}:{frame.line}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

export function VariablesPane({
  variables,
  paused,
  frameName,
}: {
  variables: readonly Variable[];
  paused: boolean;
  frameName: string | null;
}) {
  return (
    <Panel title="Locals" badge={frameName ?? undefined}>
      {variables.length === 0 ? (
        <PanelEmpty
          title={paused ? "No variables" : "Nothing to inspect"}
          detail={paused ? "This frame reports no variables." : "Variables appear while execution is paused."}
          icon="module"
        />
      ) : (
        <dl className="py-1">
          {variables.map((variable) => (
            <div
              key={`${variable.scope}-${variable.name}`}
              className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] items-baseline gap-x-3 px-3 py-1"
            >
              <dt className="flex min-w-0 items-baseline gap-1.5">
                <span className="truncate font-mono text-[11px] text-foreground">{variable.name}</span>
                {variable.scope === "local" ? null : (
                  <span className="shrink-0 text-[9px] tracking-wide text-subtle uppercase">
                    {SCOPE_LABEL[variable.scope]}
                  </span>
                )}
              </dt>
              <dd className="flex min-w-0 items-baseline gap-2">
                <span className="select-text-area min-w-0 flex-1 truncate font-mono text-[11px] text-code-number">
                  {variable.value}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-subtle">{variable.type}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Panel>
  );
}

export function BreakpointsPane({
  breakpoints,
  resolveScriptName,
  onToggleEnabled,
  onRemove,
  onClear,
  onOpen,
}: {
  breakpoints: readonly Breakpoint[];
  resolveScriptName: (scriptId: string) => string | null;
  onToggleEnabled: (id: string, enabled: boolean) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onOpen: (scriptId: string, line: number) => void;
}) {
  const scriptIds = [...new Set(breakpoints.map((entry) => entry.scriptId))];

  return (
    <Panel
      title="Breakpoints"
      badge={breakpoints.length > 0 ? `${breakpoints.length}` : undefined}
      actions={
        <PanelAction
          icon="trash"
          label="Clear all breakpoints"
          onClick={onClear}
          disabled={breakpoints.length === 0}
        />
      }
    >
      {breakpoints.length === 0 ? (
        <PanelEmpty
          title="No breakpoints"
          detail="Click a line's gutter in the editor to stop execution there."
          icon="breakpoint"
        />
      ) : (
        <div className="py-1">
          {scriptIds.map((scriptId) => {
            const name = resolveScriptName(scriptId);
            return (
              <section key={scriptId}>
                <h4 className="truncate px-3 pt-1.5 pb-0.5 text-[10px] text-subtle" title={name ?? scriptId}>
                  {name ?? "Script no longer in the workspace"}
                </h4>
                <ul>
                  {breakpointsForScript(breakpoints, scriptId).map((breakpoint) => (
                    <li key={breakpoint.id} className="group flex items-center gap-2 px-3 py-0.5">
                      <input
                        type="checkbox"
                        checked={breakpoint.enabled}
                        onChange={(event) => onToggleEnabled(breakpoint.id, event.target.checked)}
                        aria-label={`Breakpoint on line ${breakpoint.line}${name === null ? "" : ` of ${name}`}`}
                        className="size-3 shrink-0 accent-[var(--danger)]"
                      />
                      <button
                        type="button"
                        onClick={() => onOpen(breakpoint.scriptId, breakpoint.line)}
                        disabled={name === null}
                        title={name === null ? "This script is no longer in the workspace." : "Show this line"}
                        className={`min-w-0 flex-1 truncate text-left font-mono text-[11px] transition-colors duration-[var(--dur-fast)] disabled:pointer-events-none ${
                          breakpoint.enabled ? "text-foreground" : "text-subtle line-through"
                        } hover:text-accent`}
                      >
                        Line {breakpoint.line}
                        {breakpoint.condition === undefined ? "" : ` · ${breakpoint.condition}`}
                      </button>
                      {breakpoint.hitCount > 0 ? (
                        <span
                          title={`Stopped here ${breakpoint.hitCount} time${breakpoint.hitCount === 1 ? "" : "s"} in this session`}
                          className="shrink-0 rounded-sm border border-border px-1 font-mono text-[9px] text-subtle"
                        >
                          {breakpoint.hitCount}×
                        </span>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => onRemove(breakpoint.id)}
                        aria-label={`Remove the breakpoint on line ${breakpoint.line}`}
                        title="Remove"
                        className="shrink-0 rounded p-0.5 text-subtle opacity-0 transition-opacity duration-[var(--dur-fast)] group-hover:opacity-100 hover:text-danger focus-visible:opacity-100"
                      >
                        <Icon name="close" size={11} />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

export function WatchPane({
  watches,
  paused,
  onAdd,
  onRemove,
  onRefresh,
}: {
  watches: readonly WatchEntry[];
  paused: boolean;
  onAdd: (expression: string) => void;
  onRemove: (id: string) => void;
  onRefresh: () => void;
}) {
  const [draft, setDraft] = useState("");

  const submit = () => {
    const expression = draft.trim();
    if (expression === "") return;
    onAdd(expression);
    setDraft("");
  };

  return (
    <Panel
      title="Watch"
      badge={watches.length > 0 ? `${watches.length}` : undefined}
      actions={
        <PanelAction
          icon="refresh"
          label="Evaluate the watches again"
          onClick={onRefresh}
          disabled={watches.length === 0}
        />
      }
    >
      <div className="flex items-center gap-1.5 px-3 py-2">
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            submit();
          }}
          placeholder="Watch a name, e.g. speed"
          aria-label="Watch expression"
          spellCheck={false}
          autoComplete="off"
          className="h-7 min-w-0 flex-1 rounded border border-border bg-surface-secondary px-2 font-mono text-[11px] text-foreground transition-colors duration-[var(--dur-fast)] outline-none placeholder:font-sans placeholder:text-subtle hover:border-border-strong focus:border-accent"
        />
        <button
          type="button"
          onClick={submit}
          disabled={draft.trim() === ""}
          aria-label="Add watch"
          title="Add watch"
          className="flex size-7 shrink-0 items-center justify-center rounded border border-border-strong text-muted transition-colors duration-[var(--dur-fast)] hover:border-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          <Icon name="plus" size={13} />
        </button>
      </div>

      {watches.length === 0 ? (
        <PanelEmpty
          title="No watches"
          detail="Watches read a variable the paused frame holds. They never run code."
        />
      ) : (
        <ul className="pb-1">
          {watches.map((watch) => (
            <li key={watch.id} className="group flex items-baseline gap-2 px-3 py-1">
              <span className="min-w-0 basis-32 truncate font-mono text-[11px] text-foreground" title={watch.expression}>
                {watch.expression}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                {watch.error !== null ? (
                  <span className="text-warning" title={`${watch.error.code}: ${watch.error.message}`}>
                    {watch.error.message}
                  </span>
                ) : watch.value === null ? (
                  <span className="text-subtle">{paused ? "—" : "not paused"}</span>
                ) : (
                  <span className="select-text-area text-code-number">{watch.value}</span>
                )}
              </span>
              {watch.type === null ? null : (
                <span className="shrink-0 font-mono text-[10px] text-subtle">{watch.type}</span>
              )}
              <button
                type="button"
                onClick={() => onRemove(watch.id)}
                aria-label={`Remove the watch on ${watch.expression}`}
                title="Remove"
                className="shrink-0 rounded p-0.5 text-subtle opacity-0 transition-opacity duration-[var(--dur-fast)] group-hover:opacity-100 hover:text-danger focus-visible:opacity-100"
              >
                <Icon name="close" size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
