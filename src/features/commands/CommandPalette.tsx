import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Highlight } from "@/components/ui/Highlight";
import { Icon } from "@/components/ui/Icon";
import {
  filterCommands,
  isCommandEnabled,
  nextCommandIndex,
  resolveActiveIndex,
  runCommandAt,
} from "@/features/commands/commands";
import { useCommands, type CommandActions } from "@/features/commands/useCommands";
import type { Command } from "@/features/commands/types";
import { normalizeQuery } from "@/lib/search";

/**
 * The command palette: one field, one list, the actions the shell already has.
 *
 * It is mounted only while it is open, so nothing subscribes to target or
 * Explorer state on its behalf the rest of the time, and the shared dialog
 * takes care of the modal behaviour — Escape to dismiss, focus trapped while
 * open and focus returned to whatever had it when it closes. Its entrance
 * animation is the dialog's, so the reduced-motion preference already applies.
 */
export function CommandPalette({ onClose, actions }: { onClose: () => void; actions: CommandActions }) {
  const commands = useCommands(actions);
  const [query, setQuery] = useState("");
  /**
   * The highlight is a command, not a position. The command list is rebuilt
   * whenever target or Explorer state changes, so a position would slide under
   * the user — and Enter would run whatever had moved into that slot.
   */
  const [activeId, setActiveId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const baseId = useId();

  const matches = useMemo(() => filterCommands(commands, query), [commands, query]);
  const activeIndex = resolveActiveIndex(matches, activeId);
  const needle = normalizeQuery(query);
  const optionId = (index: number) => `${baseId}-option-${index}`;

  useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(`${baseId}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, baseId]);

  const move = (delta: number) => {
    const next = nextCommandIndex(matches, activeIndex, delta);
    setActiveId(next < 0 ? null : (matches[next]?.id ?? null));
  };

  const runAt = (index: number) => runCommandAt(matches, index, onClose);

  return (
    <Dialog
      open
      onClose={onClose}
      title="Command Palette"
      description="Run an action by name. Commands that cannot run right now say why."
      widthClassName="max-w-xl"
      initialFocusRef={inputRef}
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Icon name="search" size={14} className="shrink-0 text-subtle" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          value={query}
          placeholder="Type a command…"
          aria-label="Search commands"
          aria-expanded={matches.length > 0}
          {...(matches.length > 0 ? { "aria-controls": `${baseId}-list` } : {})}
          aria-autocomplete="list"
          {...(activeIndex >= 0 ? { "aria-activedescendant": optionId(activeIndex) } : {})}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              move(event.key === "ArrowDown" ? 1 : -1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              runAt(activeIndex);
            }
          }}
          className="h-7 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-subtle"
        />
        <kbd className="shrink-0 rounded border border-border px-1.5 font-mono text-[10px] text-subtle">Esc</kbd>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {matches.length === 0 ? (
          <p role="status" className="px-3 py-6 text-center text-xs text-subtle">
            No command matches "{query.trim()}".
          </p>
        ) : (
          <div id={`${baseId}-list`} role="listbox" aria-label="Commands">
            {matches.map((command, index) => (
              <CommandRow
                key={command.id}
                id={optionId(index)}
                command={command}
                needle={needle}
                active={index === activeIndex}
                onHover={() => {
                  if (isCommandEnabled(command)) setActiveId(command.id);
                }}
                onSelect={() => runAt(index)}
              />
            ))}
          </div>
        )}
      </div>

      <footer className="flex shrink-0 items-center gap-4 border-t border-border px-4 py-2 text-[10px] text-subtle">
        <span>
          <kbd className="font-mono">↑ ↓</kbd> to move
        </span>
        <span>
          <kbd className="font-mono">Enter</kbd> to run
        </span>
        <span className="ml-auto font-mono">
          {matches.length} of {commands.length}
        </span>
      </footer>
    </Dialog>
  );
}

function CommandRow({
  id,
  command,
  needle,
  active,
  onHover,
  onSelect,
}: {
  id: string;
  command: Command;
  needle: string;
  active: boolean;
  onHover: () => void;
  onSelect: () => void;
}) {
  const enabled = isCommandEnabled(command);

  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      aria-disabled={!enabled}
      onMouseMove={onHover}
      onClick={onSelect}
      title={command.disabledReason}
      className={`flex min-h-8 items-center gap-2.5 rounded px-2.5 text-xs transition-colors duration-[var(--dur-fast)] ${
        active ? "bg-accent-soft text-foreground" : enabled ? "text-foreground" : "text-subtle"
      } ${enabled ? "cursor-pointer" : "cursor-default"}`}
    >
      <span className="w-20 shrink-0 text-[10px] tracking-[0.1em] text-subtle uppercase">{command.category}</span>
      <span className="min-w-0 truncate">
        <Highlight text={command.title} needle={needle} />
      </span>
      {command.disabledReason ? (
        <span className="ml-auto min-w-0 shrink truncate text-right text-[10px] text-subtle">
          {command.disabledReason}
        </span>
      ) : command.hint ? (
        <kbd className="ml-auto shrink-0 rounded border border-border px-1.5 font-mono text-[10px] text-subtle">
          {command.hint}
        </kbd>
      ) : null}
    </div>
  );
}
