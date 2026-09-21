import { useId, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/ui/Icon";

/**
 * A titled pane inside a workspace: the shape the debugger and the profiler
 * both use for Call Stack, Locals, Breakpoints, Watch, Timeline and Top Frames.
 *
 * It owns the frame and the scrolling, so the panes stay the same size and the
 * same shape whatever they hold, and each one scrolls by itself rather than
 * moving the whole view.
 */
export function Panel({
  title,
  badge,
  actions,
  children,
}: {
  title: string;
  /** A short count or state, shown right of the title. */
  badge?: string | undefined;
  /** Buttons for this pane only. */
  actions?: ReactNode | undefined;
  children: ReactNode;
}) {
  const id = useId();

  return (
    <section
      aria-labelledby={id}
      className="flex min-h-0 flex-col overflow-hidden rounded border border-border bg-surface"
    >
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3">
        <h3 id={id} className="text-[10px] font-semibold tracking-[0.12em] text-subtle uppercase">
          {title}
        </h3>
        {badge === undefined ? null : <span className="font-mono text-[10px] text-subtle">{badge}</span>}
        {actions === undefined ? null : <div className="ml-auto flex items-center gap-1">{actions}</div>}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}

/**
 * What a pane says when it holds nothing. Empty is a state worth designing:
 * it names what is missing and what would fill it.
 */
export function PanelEmpty({
  title,
  detail,
  icon,
}: {
  title: string;
  detail: string;
  icon?: IconName | undefined;
}) {
  return (
    <div className="flex h-full min-h-24 flex-col items-center justify-center px-4 py-6 text-center">
      {icon === undefined ? null : <Icon name={icon} size={18} className="mb-2 text-subtle" />}
      <p className="text-xs text-muted">{title}</p>
      <p className="mt-1 max-w-xs text-[11px] leading-relaxed text-subtle">{detail}</p>
    </div>
  );
}

/** A small, square-ish action button for a pane header. */
export function PanelAction({
  icon,
  label,
  onClick,
  disabled = false,
  title,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={title ?? label}
      className="flex size-6 items-center justify-center rounded text-subtle transition-colors duration-[var(--dur-fast)] hover:bg-surface-raised hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      <Icon name={icon} size={13} />
    </button>
  );
}
