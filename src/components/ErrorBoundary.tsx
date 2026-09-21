import { Component, type ErrorInfo, type ReactNode } from "react";
import { createDiagnosticLog } from "@/features/diagnostics/diagnostics";

/** Render failures go to the one log stream, tagged so they can be found among the rest. */
const log = createDiagnosticLog("System", "errorBoundary");

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    log.error(`Unhandled render error: ${error.message}`, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-lg rounded-lg border border-border bg-surface p-6">
          <h1 className="text-base font-medium text-danger">Application error</h1>
          <p className="mt-2 font-mono text-sm text-muted break-words">{error.message}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
