import { Icon } from "@/components/ui/Icon";
import { explorerClassIcon } from "@/features/explorer/classIcons";
import type { ExplorerNode } from "@/features/explorer/types";

/**
 * Where the selected object sits, built from the model's parent links rather
 * than written anywhere. Each step selects that object, so the path is also how
 * you walk back up.
 */
export function ExplorerBreadcrumb({
  path,
  onSelect,
  onCopyPath,
}: {
  path: readonly ExplorerNode[];
  onSelect: (id: string) => void;
  onCopyPath: () => void;
}) {
  if (path.length === 0) {
    return (
      <div className="flex h-8 shrink-0 items-center border-b border-border px-3 text-[11px] text-subtle">
        No object selected
      </div>
    );
  }

  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border pr-1 pl-2">
      <nav aria-label="Object path" className="flex min-w-0 flex-1 items-center overflow-x-auto">
        <ol className="flex min-w-0 items-center whitespace-nowrap">
          {path.map((node, index) => {
            const last = index === path.length - 1;
            return (
              // Each step keeps its own width so a deep path scrolls sideways
              // instead of squeezing every step down to a stub.
              <li key={node.id} className="flex shrink-0 items-center">
                {index > 0 ? (
                  <Icon name="chevronRight" size={11} className="mx-0.5 shrink-0 text-subtle" />
                ) : null}
                <button
                  type="button"
                  onClick={() => onSelect(node.id)}
                  title={`${node.name} — ${node.className}`}
                  {...(last ? { "aria-current": "true" as const } : {})}
                  className={`flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] transition-colors duration-[var(--dur-fast)] hover:bg-surface-raised ${
                    last ? "text-foreground" : "text-muted hover:text-foreground"
                  }`}
                >
                  <Icon
                    name={explorerClassIcon(node.className)}
                    size={12}
                    className={`shrink-0 ${last ? "text-accent" : "text-subtle"}`}
                  />
                  <span className="max-w-40 truncate">{node.name}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      <button
        type="button"
        onClick={onCopyPath}
        aria-label="Copy object path"
        title="Copy object path"
        className="shrink-0 rounded p-1.5 text-subtle transition-colors duration-[var(--dur-fast)] hover:bg-surface-raised hover:text-foreground"
      >
        <Icon name="copy" size={13} />
      </button>
    </div>
  );
}
