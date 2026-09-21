import { Icon } from "@/components/ui/Icon";
import { explorerClassIcon } from "@/features/explorer/classIcons";
import {
  describePropertyValue,
  formatPropertyValue,
  groupProperties,
  summarizeNode,
  ungroupedProperties,
} from "@/features/explorer/properties";
import type { ExplorerNode, ExplorerProperty, ExplorerProviderInfo } from "@/features/explorer/types";

/**
 * The Property Inspector: what the Explorer's selected object reports about
 * itself, grouped and typed.
 *
 * Every value is read-only. Nova has nowhere to write a change to — the
 * provider makes this data up — and an editor that only changed a local copy
 * would suggest otherwise, so the panel says what it is instead.
 */
export function PropertyInspector({
  node,
  provider,
}: {
  node: ExplorerNode | null;
  provider: ExplorerProviderInfo;
}) {
  if (node === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-background p-8">
        {/* The same shape as the placeholder view, so the two empty states read as one family. */}
        <div className="max-w-sm text-center">
          <div className="mx-auto flex size-11 items-center justify-center rounded-lg border border-border bg-surface text-subtle">
            <Icon name="explorer" size={20} />
          </div>
          <h3 className="mt-4 text-sm font-medium text-foreground">No object selected</h3>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">Select an item from Explorer</p>
        </div>
      </div>
    );
  }

  const groups = groupProperties(node.properties);
  const other = ungroupedProperties(node.properties);
  const metadata = Object.entries(node.metadata ?? {});

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background">
      <header className="flex items-start gap-2.5 border-b border-border px-4 py-3">
        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded border border-border bg-surface text-accent">
          <Icon name={explorerClassIcon(node.className)} size={15} />
        </div>
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold tracking-tight text-foreground" title={node.name}>
            {node.name}
          </h2>
          <p className="mt-0.5 text-[11px] text-subtle">{summarizeNode(node)}</p>
        </div>
        <span
          title={provider.description}
          className="ml-auto shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-[9px] tracking-[0.1em] text-subtle uppercase"
        >
          Read only
        </span>
      </header>

      <div className="px-4 py-3">
        {groups.length === 0 && other.length === 0 ? (
          <p className="py-6 text-center text-[11px] text-subtle">This object reports no properties.</p>
        ) : null}

        {groups.map(({ group, properties }) => (
          <PropertyGroup key={group} title={group} properties={properties} />
        ))}
        {other.length > 0 ? <PropertyGroup title="Other" properties={other} /> : null}

        {metadata.length > 0 ? (
          <section className="mt-4 border-t border-border pt-3">
            <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-4 gap-y-1">
              {metadata.map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="truncate text-[11px] text-subtle">{key}</dt>
                  <dd className="truncate text-[11px] text-subtle">{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function PropertyGroup({ title, properties }: { title: string; properties: readonly ExplorerProperty[] }) {
  return (
    <section className="mb-4 last:mb-0">
      <h3 className="mb-1 text-[10px] font-semibold tracking-[0.12em] text-subtle uppercase">{title}</h3>
      <dl className="rounded border border-border bg-surface-secondary">
        {properties.map((property) => (
          <PropertyRow key={property.id} property={property} />
        ))}
      </dl>
    </section>
  );
}

function PropertyRow({ property }: { property: ExplorerProperty }) {
  const formatted = formatPropertyValue(property.value);
  const tone =
    property.value.kind === "boolean"
      ? property.value.value
        ? "text-success"
        : "text-muted"
      : property.value.kind === "number" || property.value.kind === "vector"
        ? "text-code-number"
        : property.value.kind === "enum"
          ? "text-code-keyword"
          : "text-foreground";

  return (
    <div className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] items-baseline gap-x-4 border-b border-border px-3 py-1.5 last:border-b-0">
      <dt className="truncate text-[11px] text-muted" title={property.description ?? property.name}>
        {property.name}
      </dt>
      {/*
        Selectable and wrapping rather than scrollable: a long value stays fully
        readable and can be copied by hand, and the panel does the scrolling —
        so the row never has to become a tab stop of its own.
      */}
      <dd
        title={describePropertyValue(property)}
        className={`select-text-area font-mono text-[11px] break-words ${tone}`}
      >
        {formatted}
      </dd>
    </div>
  );
}
