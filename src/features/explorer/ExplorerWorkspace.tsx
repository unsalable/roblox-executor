import { useImperativeHandle, useRef, type Ref } from "react";
import { createDiagnosticReporter } from "@/features/diagnostics/diagnostics";
import { ExplorerBreadcrumb } from "@/features/explorer/ExplorerBreadcrumb";
import { formatExplorerPath } from "@/features/explorer/explorerModel";
import { PropertyInspector } from "@/features/explorer/PropertyInspector";
import { useExplorer, useExplorerSelection } from "@/features/explorer/useExplorer";
import { copyText } from "@/lib/clipboard";

/** What the shell can ask the detail area to do, e.g. after "Inspect". */
export interface ExplorerWorkspaceHandle {
  focusInspector: () => void;
}

const diagnostics = createDiagnosticReporter("Explorer", "explorerWorkspace");

/**
 * The Explorer's main area: where the selected object sits, and what it
 * reports. The tree itself lives in the sidebar, next to where the script
 * workspace's tree lives, so both follow the same shape.
 */
export function ExplorerWorkspace({ ref }: { ref?: Ref<ExplorerWorkspaceHandle> }) {
  const { controller } = useExplorer();
  const { node, path } = useExplorerSelection();
  const regionRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(
    ref,
    () => ({
      focusInspector: () => requestAnimationFrame(() => regionRef.current?.focus()),
    }),
    [],
  );

  const copyPath = () => {
    void copyText(formatExplorerPath(path)).then((copied) => {
      if (!copied) {
        diagnostics.warn("The object path could not be copied to the clipboard.", { code: "CLIPBOARD_UNAVAILABLE" });
      }
    });
  };

  return (
    <div
      ref={regionRef}
      tabIndex={-1}
      role="region"
      aria-label="Property Inspector"
      className="flex min-h-0 flex-1 flex-col bg-background outline-none"
    >
      <ExplorerBreadcrumb path={path} onSelect={controller.select} onCopyPath={copyPath} />
      <PropertyInspector node={node} provider={controller.provider} />
      {controller.provider.mock ? (
        <p className="shrink-0 border-t border-border bg-surface px-4 py-1.5 text-[10px] leading-relaxed text-subtle">
          {controller.provider.label}: {controller.provider.description}
        </p>
      ) : null}
    </div>
  );
}
