import { useMemo } from "react";
import { isBackendReady } from "@/features/backend/backendState";
import { useBackend } from "@/features/backend/useBackend";
import { buildDebuggerCommands } from "@/features/commands/debuggerCommands";
import { buildDeveloperCommands } from "@/features/commands/developerCommands";
import { buildProfilerCommands } from "@/features/commands/profilerCommands";
import { buildUpdateCommands } from "@/features/commands/updateCommands";
import type { Command } from "@/features/commands/types";
import { breakpointsForScript } from "@/features/debugger/breakpoints";
import { useDebugger } from "@/features/debugger/useDebugger";
import { useExplorer } from "@/features/explorer/useExplorer";
import { useProfiler } from "@/features/profiler/useProfiler";
import { INJECTABLE_STATUSES } from "@/features/target/targetState";
import type { TargetStatus } from "@/features/target/types";
import { useTarget } from "@/features/target/useTarget";
import { useUpdates } from "@/features/updates/useUpdates";

/**
 * Shell actions the palette can run. Every one of them is an action the UI
 * already offers somewhere else; the palette is a second way to reach them,
 * never a second implementation.
 */
export interface CommandActions {
  newScript: () => void;
  newFolder: () => void;
  focusEditor: () => void;
  focusExplorer: () => void;
  toggleSidebar: () => void;
  toggleConsole: () => void;
  clearConsole: () => void;
  openSettings: () => void;
  /** Starts a debug session for the open script, with the Explorer selection as its context. */
  startDebugSession: () => void;
  /** Marks the line the caret is on in the open script. */
  addBreakpointAtCursor: () => void;
  /** Unmarks the line the caret is on in the open script. */
  removeBreakpointAtCursor: () => void;
  /** Opens the developer diagnostics, which is where the backend's status is shown. */
  showBackendStatus: () => void;
  /** Opens the update dialog on what has already been found, without asking the source. */
  showUpdate: () => void;
  /** Whether a script is open, which decides if focusing the editor can do anything. */
  hasActiveScript: boolean;
  /** The open script, so breakpoint commands can say what applies to it. */
  activeScriptId: string | null;
}

/** Why an inject cannot be started right now, or undefined when it can. */
function injectBlockedReason(status: TargetStatus): string | undefined {
  if (INJECTABLE_STATUSES.includes(status)) return undefined;
  switch (status) {
    case "unavailable":
      return "No target has been detected.";
    case "detected":
      return "The target has been detected but is not ready yet.";
    case "injecting":
      return "An injection is already in progress.";
    case "injected":
      return "The target is already injected.";
    default:
      return "The target is busy.";
  }
}

/**
 * The commands available right now.
 *
 * The target and Explorer state is read here rather than in the shell, so only
 * the palette re-renders when they change — and it is only mounted while it is
 * open.
 */
export function useCommands(actions: CommandActions): readonly Command[] {
  const { status, session, detecting, detect, inject, disconnect } = useTarget();
  const { model, controller } = useExplorer();
  const debug = useDebugger();
  const profiler = useProfiler();
  const backend = useBackend();
  const updates = useUpdates();

  const emptyExplorer = model.count === 0;

  const debuggerCommands = useMemo(
    () =>
      buildDebuggerCommands(
        {
          state: debug.state,
          supported: backend.capabilities.debugger.canDebug,
          backendReady: isBackendReady(backend.state),
          busy: debug.busy,
          pausePending: debug.pausePending,
          // The same fact the backend already derived; reading it twice would be
          // two sources for one answer.
          supportsPause: backend.capabilities.debugger.canPause,
          hasScript: actions.hasActiveScript,
          scriptBreakpoints: breakpointsForScript(debug.breakpoints, actions.activeScriptId).length,
          totalBreakpoints: debug.breakpoints.length,
        },
        {
          start: actions.startDebugSession,
          stop: () => void debug.controller.stop(),
          resume: () => void debug.controller.resume("continue"),
          pause: () => debug.controller.pause(),
          stepOver: () => void debug.controller.resume("step-over"),
          stepInto: () => void debug.controller.resume("step-into"),
          stepOut: () => void debug.controller.resume("step-out"),
          addBreakpoint: actions.addBreakpointAtCursor,
          removeBreakpoint: actions.removeBreakpointAtCursor,
          clearBreakpoints: () => void debug.controller.clearBreakpoints(),
        },
      ),
    [
      backend.capabilities,
      backend.state,
      debug.state,
      debug.busy,
      debug.pausePending,
      debug.breakpoints,
      debug.controller,
      actions,
    ],
  );

  const profilerCommands = useMemo(
    () =>
      buildProfilerCommands(
        {
          state: profiler.state,
          supported: backend.capabilities.profiler.canProfile,
          backendReady: isBackendReady(backend.state),
          busy: profiler.busy,
          hasSession: profiler.session !== null,
          hasData: profiler.session !== null || profiler.history.length > 0,
        },
        {
          start: () => void profiler.controller.start(),
          stop: () => void profiler.controller.stop(),
          clear: () => profiler.controller.clear(),
          refresh: () => void profiler.controller.refresh(),
        },
      ),
    [
      backend.capabilities,
      backend.state,
      profiler.state,
      profiler.busy,
      profiler.session,
      profiler.history,
      profiler.controller,
    ],
  );

  const developerCommands = useMemo(
    () =>
      buildDeveloperCommands(
        {
          state: backend.state,
          busy: backend.busy,
          hasProviders: backend.providers.length > 0,
        },
        {
          showStatus: actions.showBackendStatus,
          restartBackend: () => void backend.controller.restart(),
          refreshCapabilities: () => backend.controller.refreshCapabilities(),
        },
      ),
    [backend.state, backend.busy, backend.providers, backend.controller, actions.showBackendStatus],
  );

  const updateCommands = useMemo(
    () =>
      buildUpdateCommands(
        {
          status: updates.status,
          available: updates.provider.available,
          hasRelease: updates.release !== null,
        },
        { check: updates.check, showUpdate: actions.showUpdate },
      ),
    [updates.status, updates.provider.available, updates.release, updates.check, actions.showUpdate],
  );

  return useMemo<readonly Command[]>(() => {
    const explorerReason = emptyExplorer ? "The Explorer has no objects." : undefined;
    const disconnectReason =
      session === "active" || status === "injected" ? undefined : "There is no target session to disconnect.";
    const injectReason = injectBlockedReason(status);

    const list: Command[] = [
      { id: "new-script", title: "New Script", category: "Workspace", hint: "Ctrl+T", run: actions.newScript },
      { id: "new-folder", title: "New Folder", category: "Workspace", run: actions.newFolder },
      {
        id: "focus-editor",
        title: "Focus Editor",
        category: "View",
        keywords: ["monaco", "code"],
        ...(actions.hasActiveScript ? {} : { disabledReason: "No script is open." }),
        run: actions.focusEditor,
      },
      {
        id: "focus-explorer",
        title: "Focus Explorer",
        category: "View",
        keywords: ["tree", "objects"],
        run: actions.focusExplorer,
      },
      { id: "toggle-sidebar", title: "Toggle Sidebar", category: "View", run: actions.toggleSidebar },
      {
        id: "toggle-console",
        title: "Toggle Console",
        category: "Console",
        hint: "Ctrl+`",
        keywords: ["output", "log"],
        run: actions.toggleConsole,
      },
      {
        id: "clear-console",
        title: "Clear Console",
        category: "Console",
        keywords: ["output", "log"],
        run: actions.clearConsole,
      },
      {
        id: "expand-explorer",
        title: "Expand Explorer",
        category: "Explorer",
        ...(explorerReason === undefined ? {} : { disabledReason: explorerReason }),
        run: controller.expandAll,
      },
      {
        id: "collapse-explorer",
        title: "Collapse Explorer",
        category: "Explorer",
        ...(explorerReason === undefined ? {} : { disabledReason: explorerReason }),
        run: controller.collapseAll,
      },
      {
        id: "detect-target",
        title: "Detect Target",
        category: "Target",
        ...(detecting ? { disabledReason: "A detection pass is already running." } : {}),
        run: detect,
      },
      {
        id: "inject",
        title: "Inject",
        category: "Target",
        ...(injectReason === undefined ? {} : { disabledReason: injectReason }),
        run: inject,
      },
      {
        id: "disconnect-target",
        title: "Disconnect Target",
        category: "Target",
        ...(disconnectReason === undefined ? {} : { disabledReason: disconnectReason }),
        run: disconnect,
      },
      ...debuggerCommands,
      ...profilerCommands,
      ...developerCommands,
      ...updateCommands,
      { id: "open-settings", title: "Open Settings", category: "Settings", hint: "Ctrl+,", run: actions.openSettings },
    ];

    return list;
  }, [
    actions,
    controller,
    debuggerCommands,
    detect,
    detecting,
    developerCommands,
    disconnect,
    emptyExplorer,
    inject,
    profilerCommands,
    session,
    status,
    updateCommands,
  ]);
}
