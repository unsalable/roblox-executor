import type { ReactNode } from "react";

/**
 * The label/value rows every diagnostics surface is built from.
 *
 * They were local to the target diagnostics dialog until the Developer Status
 * panel needed the same shape; sharing them is what keeps the two reading as one
 * surface rather than two that happen to look similar. They render and nothing
 * else: no state, no hooks, no decisions.
 */

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-4 last:mb-0">
      <h3 className="mb-1.5 text-[10px] font-semibold tracking-[0.12em] text-subtle uppercase">{title}</h3>
      {children}
    </section>
  );
}

export function Rows({ children }: { children: ReactNode }) {
  return (
    <dl className="rounded border border-border bg-surface-secondary px-3 py-1.5 font-mono text-[11px]">{children}</dl>
  );
}

export function Row({ label, children, note }: { label: string; children: ReactNode; note?: string | undefined }) {
  return (
    <div className="flex items-center justify-between gap-6 py-1">
      <dt className="text-subtle">{label}</dt>
      <dd className="flex min-w-0 items-center gap-2 text-right text-foreground">
        {children}
        {note ? (
          <span className="rounded-sm border border-warning/40 px-1 text-[9px] tracking-wide text-warning uppercase">
            {note}
          </span>
        ) : null}
      </dd>
    </div>
  );
}
