import { useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";

export interface MenuAction {
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  /** Styles the item as a destructive action. */
  destructive?: boolean;
}

export interface MenuSeparator {
  id: string;
  separator: true;
}

export type MenuItem = MenuAction | MenuSeparator;

/** Viewport point a context menu opens at. */
export interface MenuAnchor {
  x: number;
  y: number;
}

const isSeparator = (item: MenuItem): item is MenuSeparator => "separator" in item;

/** Gap kept between an anchored menu and the window edges. */
const EDGE_MARGIN = 8;

interface MenuProps {
  open: boolean;
  items: readonly MenuItem[];
  onSelect: (id: string) => void;
  onClose: () => void;
  /** id of the element that opened the menu; focus returns there on keyboard dismissal and selection. */
  labelledBy: string;
  /** Positioning classes. The parent must establish a positioning context. */
  className?: string;
  /** Inline styles for caller-positioned menus. */
  style?: CSSProperties;
  /**
   * Opens the menu at a viewport point instead (context menus). The menu is
   * measured before paint and kept inside the window, flipping above the
   * point when there is no room below.
   */
  anchor?: MenuAnchor;
}

/**
 * Small popup menu. Positioning is left to the caller (or `anchor`) so the
 * same component can open upward (execute bar), downward or at the pointer
 * without carrying a layout engine.
 */
export function Menu({ open, items, onSelect, onClose, labelledBy, className = "", style, anchor }: MenuProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const anchorX = anchor?.x;
  const anchorY = anchor?.y;

  useLayoutEffect(() => {
    const node = listRef.current;
    if (!open || !node || anchorX === undefined || anchorY === undefined) return;

    const { width, height } = node.getBoundingClientRect();
    const left = Math.max(EDGE_MARGIN, Math.min(anchorX, window.innerWidth - width - EDGE_MARGIN));
    const fitsBelow = anchorY + height <= window.innerHeight - EDGE_MARGIN;
    const top = fitsBelow ? anchorY : Math.max(EDGE_MARGIN, Math.min(anchorY, window.innerHeight) - height);
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  }, [open, anchorX, anchorY]);

  useEffect(() => {
    if (!open) return;

    listRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();

    const onPointerDown = (event: PointerEvent) => {
      const node = listRef.current;
      if (!node) return;

      // The trigger is excluded so its own click can close the menu instead of
      // this handler closing it a moment before the click re-opens it.
      const trigger = document.getElementById(labelledBy);
      const target = event.target as Node;
      if (!node.contains(target) && !trigger?.contains(target)) onClose();
    };
    const dismiss = () => onClose();

    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
    };
  }, [open, onClose, labelledBy]);

  if (!open) return null;

  // Keyboard dismissal and selection hand focus back to the trigger; an outside click leaves it where it landed.
  const restoreFocus = () => document.getElementById(labelledBy)?.focus();

  const enabledItems = () => [
    ...(listRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []),
  ];

  const focusAt = (index: number) => {
    const nodes = enabledItems();
    nodes[(index + nodes.length) % nodes.length]?.focus();
  };

  const focusByLetter = (from: HTMLElement, letter: string) => {
    const nodes = enabledItems();
    const start = nodes.indexOf(from);
    for (let step = 1; step <= nodes.length; step += 1) {
      const node = nodes[(start + step) % nodes.length]!;
      if (node.textContent?.trim().toLowerCase().startsWith(letter)) {
        node.focus();
        return;
      }
    }
  };

  return (
    <div
      ref={listRef}
      role="menu"
      aria-labelledby={labelledBy}
      style={anchor ? { ...style, position: "fixed", left: anchor.x, top: anchor.y } : style}
      className={`animate-menu-in ${anchor ? "" : "absolute"} z-40 min-w-56 overflow-hidden rounded-md border border-border-strong bg-surface p-1 shadow-[0_16px_40px_-12px_rgb(0_0_0/0.65)] ${className}`}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        const index = enabledItems().indexOf(target);
        if (event.key === "ArrowDown") {
          event.preventDefault();
          focusAt(index + 1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          focusAt(index - 1);
        } else if (event.key === "Home") {
          event.preventDefault();
          focusAt(0);
        } else if (event.key === "End") {
          event.preventDefault();
          focusAt(-1);
        } else if (event.key === "Escape" || event.key === "Tab") {
          event.preventDefault();
          event.stopPropagation();
          restoreFocus();
          onClose();
        } else if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey && event.key !== " ") {
          focusByLetter(target, event.key.toLowerCase());
        }
      }}
    >
      {items.map((item) =>
        isSeparator(item) ? (
          <div key={item.id} role="separator" className="mx-1.5 my-1 h-px bg-border" />
        ) : (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              restoreFocus();
              onSelect(item.id);
            }}
            className={`flex w-full items-center justify-between gap-6 rounded px-2.5 py-1.5 text-left text-xs transition-colors duration-[var(--dur-fast)] disabled:pointer-events-none disabled:opacity-40 ${
              item.destructive
                ? "text-danger hover:bg-danger-soft focus-visible:bg-danger-soft"
                : "text-foreground hover:bg-accent-soft focus-visible:bg-accent-soft"
            }`}
          >
            <span>{item.label}</span>
            {item.hint ? <span className="font-mono text-[10px] text-subtle">{item.hint}</span> : null}
          </button>
        ),
      )}
    </div>
  );
}
