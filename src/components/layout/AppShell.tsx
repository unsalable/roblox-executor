import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { config } from "@/app/config";
import { useAppServices } from "@/app/services";
import { useAppStore } from "@/app/store";
import { type WorkspaceView } from "@/components/layout/navigation";
import { Sidebar } from "@/components/layout/Sidebar";
import { TitleBar } from "@/components/layout/TitleBar";
import { useBackendStartup } from "@/features/backend/useBackend";
import { useTargetStartup } from "@/features/target/useTarget";
import { CommandPalette } from "@/features/commands/CommandPalette";
import type { CommandActions } from "@/features/commands/useCommands";
import { ConsolePanel, type ConsoleTab } from "@/features/console/ConsolePanel";
import { useConsoleLog } from "@/features/console/useConsoleLog";
import { DebuggerWorkspace } from "@/features/debugger/DebuggerWorkspace";
import { buildDebugDecorations } from "@/features/debugger/editorDecorations";
import { debugContextFromExplorer, debugTargetFromScript } from "@/features/debugger/session";
import { useEditorDebugState } from "@/features/debugger/useDebugger";
import { createDiagnosticLog } from "@/features/diagnostics/diagnostics";
import { ScriptEditor, type ScriptEditorHandle } from "@/features/editor/ScriptEditor";
import type { ErrorActionId } from "@/features/errors/errorPresentation";
import { ExecuteBar } from "@/features/execution/ExecuteBar";
import type { ExecuteTarget } from "@/features/execution/executionInput";
import { useExecuteCommand } from "@/features/execution/useExecuteCommand";
import { ExplorerPanel, type ExplorerPanelHandle } from "@/features/explorer/ExplorerPanel";
import { ExplorerWorkspace, type ExplorerWorkspaceHandle } from "@/features/explorer/ExplorerWorkspace";
import { ProfilerWorkspace } from "@/features/profiler/ProfilerWorkspace";
import { SettingsDialog } from "@/features/settings/SettingsDialog";
import { ScriptManager, type ScriptManagerActions } from "@/features/scripts/ScriptManager";
import { TabBar } from "@/features/scripts/TabBar";
import { useScriptWorkspace } from "@/features/scripts/useScriptWorkspace";
import { useWorkspaceDialogs } from "@/features/scripts/useWorkspaceDialogs";
import { TargetDiagnosticsDialog } from "@/features/status/TargetDiagnosticsDialog";
import { UpdateDialog } from "@/features/updates/UpdateDialog";
import { useUpdateStartup } from "@/features/updates/useUpdates";
import { StatusBar } from "@/features/status/StatusBar";
import { windowControls } from "@/lib/tauri";

/** Shell messages go to the one log stream, tagged so they can be found among the rest. */
const log = createDiagnosticLog("System", "appShell");

const CONSOLE_MIN_HEIGHT = 120;
const CONSOLE_DEFAULT_HEIGHT = 180;

/** Height reserved for the title bar, tabs, execute bar, status bar and editor. */
const WORKSPACE_RESERVE = 320;

function maxConsoleHeight(): number {
  const available = Math.min(Math.round(window.innerHeight * 0.6), window.innerHeight - WORKSPACE_RESERVE);
  return Math.max(CONSOLE_MIN_HEIGHT, available);
}

export function AppShell() {
  const { settings } = useAppStore();
  const services = useAppServices();
  const workspace = useScriptWorkspace();
  const consoleLog = useConsoleLog();
  const editorRef = useRef<ScriptEditorHandle>(null);
  const explorerPanelRef = useRef<ExplorerPanelHandle>(null);
  const explorerWorkspaceRef = useRef<ExplorerWorkspaceHandle>(null);

  const [view, setView] = useState<WorkspaceView>("scripts");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(true);
  const [consoleTab, setConsoleTab] = useState<ConsoleTab>("console");
  const [consoleHeight, setConsoleHeight] = useState(CONSOLE_DEFAULT_HEIGHT);
  const [consoleLimit, setConsoleLimit] = useState(maxConsoleHeight);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const announced = useRef(false);

  const {
    activeScript,
    activeScriptId,
    openScriptIds,
    scripts,
    folders,
    getState,
    getScript,
    updateContent,
    createScript,
    openScript,
    saveScript,
    renameScript,
    renameFolder,
    duplicateScript,
    toggleFavorite,
  } = workspace;

  const syncEditorContent = useCallback((id: string) => editorRef.current?.syncContent(id), []);
  /**
   * Release the providers before the window goes, so an active session is ended
   * deliberately rather than left to be discovered as dead. Closing is never
   * blocked on it for long.
   */
  const closeWindow = useCallback(() => {
    const released = services.shutdown().catch((error: unknown) => log.debug("Shutdown reported an error", error));
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, 400));
    void Promise.race([released, deadline]).finally(() => void windowControls.close());
  }, [services]);
  const dialogs = useWorkspaceDialogs({
    workspace,
    confirmBeforeClosing: settings.general.confirmOnExit,
    onContentReset: syncEditorContent,
    onCloseWindow: closeWindow,
  });

  useEffect(() => {
    if (announced.current) return;
    announced.current = true;

    log.info(`${config.appName} ${config.version} UI shell ready`);
    log.info(
      `Target provider: ${services.target.provider.label}${services.target.provider.simulated ? " (simulated inside Nova; no external process is contacted)" : ""}`,
    );
    log.info(`Execution provider: ${services.execution.provider.label}`);
    log.info(
      `Explorer provider: ${services.explorer.provider.label}${services.explorer.provider.mock ? " (mock data written inside Nova; nothing external is read)" : ""}`,
    );
  }, [services]);

  useBackendStartup();
  useTargetStartup();
  useUpdateStartup();

  useEffect(() => {
    const onResize = () => {
      const limit = maxConsoleHeight();
      setConsoleLimit(limit);
      setConsoleHeight((height) => Math.min(height, limit));
    };

    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const toggleConsole = useCallback(() => setConsoleOpen((open) => !open), []);
  const toggleSidebar = useCallback(() => setSidebarCollapsed((collapsed) => !collapsed), []);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const openDiagnostics = useCallback(() => setDiagnosticsOpen(true), []);
  /**
   * Reopens the update prompt on what has already been found. It goes through
   * the controller rather than through `useUpdates`, so the shell does not
   * re-render on every byte of a download in progress.
   */
  const showUpdatePrompt = useCallback(() => services.updates.open(), [services]);
  const closeDiagnostics = useCallback(() => setDiagnosticsOpen(false), []);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  /** Shows the Explorer and puts the keyboard in its tree. */
  const focusExplorer = useCallback(() => {
    setView("explorer");
    setSidebarCollapsed(false);
    explorerPanelRef.current?.focusTree();
  }, []);
  /** Shows the script workspace and puts the keyboard in the editor once it is visible. */
  const focusEditor = useCallback(() => {
    setView("scripts");
    requestAnimationFrame(() => editorRef.current?.focus());
  }, []);
  const focusInspector = useCallback(() => explorerWorkspaceRef.current?.focusInspector(), []);
  const showHistory = useCallback(() => {
    setConsoleOpen(true);
    setConsoleTab("history");
  }, []);

  const readContent = useCallback((id: string) => getScript(id)?.content, [getScript]);
  const resolveScriptName = useCallback((id: string) => getScript(id)?.name ?? null, [getScript]);

  /**
   * The debugger's marks for the script on screen. The controller owns them;
   * this only turns the ones that belong to this script into decorations, so
   * the gutter and the Debugger panel can never disagree about a line.
   */
  const { breakpoints: activeBreakpoints, activeLine } = useEditorDebugState(activeScriptId);
  const debugDecorations = useMemo(
    () => buildDebugDecorations({ breakpoints: activeBreakpoints, activeLine }),
    [activeBreakpoints, activeLine],
  );
  const toggleBreakpoint = useCallback(
    (scriptId: string, line: number) => void services.debug.toggleBreakpoint(scriptId, line),
    [services],
  );

  /** Reads the script a debug session would run, at the moment it is asked for. */
  const readDebugTarget = useCallback(() => {
    const { activeScriptId: id } = getState();
    return debugTargetFromScript(id === null ? null : (getScript(id) ?? null));
  }, [getState, getScript]);

  /** Shows a script in the editor at a line, e.g. from a stack frame or a breakpoint. */
  const openScriptAtLine = useCallback(
    (scriptId: string, line: number) => {
      setView("scripts");
      openScript(scriptId);
      editorRef.current?.revealLine(scriptId, line);
    },
    [openScript],
  );

  const newScriptIn = useCallback(
    (folderId: string | null) => {
      setView("scripts");
      const id = createScript(folderId);
      if (id !== null) editorRef.current?.placeCursorAtEnd(id);
    },
    [createScript],
  );
  const newScript = useCallback(() => newScriptIn(null), [newScriptIn]);

  const {
    requestCloseScript,
    requestCloseWindow,
    requestDeleteScript,
    requestDeleteFolder,
    requestDiscardChanges,
    requestMoveScript,
    requestNewFolder,
  } = dialogs;

  const scriptActions = useMemo<ScriptManagerActions>(
    () => ({
      openScript,
      closeScript: requestCloseScript,
      saveScript: (id) => void saveScript(id),
      createScript: newScriptIn,
      createFolder: requestNewFolder,
      renameScript,
      renameFolder,
      duplicateScript: (id) => void duplicateScript(id),
      toggleFavorite,
      moveScript: requestMoveScript,
      discardChanges: requestDiscardChanges,
      deleteScript: requestDeleteScript,
      deleteFolder: requestDeleteFolder,
    }),
    [
      openScript,
      requestCloseScript,
      saveScript,
      newScriptIn,
      requestNewFolder,
      renameScript,
      renameFolder,
      duplicateScript,
      toggleFavorite,
      requestMoveScript,
      requestDiscardChanges,
      requestDeleteScript,
      requestDeleteFolder,
    ],
  );

  /** The palette runs the shell's own actions; it never gets a handler of its own. */
  const commandActions = useMemo<CommandActions>(
    () => ({
      newScript,
      newFolder: () => requestNewFolder(null),
      focusEditor,
      focusExplorer,
      toggleSidebar,
      toggleConsole,
      clearConsole: consoleLog.clear,
      openSettings,
      startDebugSession: () => {
        const target = readDebugTarget();
        if (target === null) return;
        // The session's context is the shared developer selection.
        const { model, selectedId } = services.explorer.getSnapshot();
        services.debug.start({ target, context: debugContextFromExplorer(model, selectedId) });
        setView("debugger");
      },
      addBreakpointAtCursor: () => {
        const line = editorRef.current?.getCursorLine();
        const id = getState().activeScriptId;
        if (id === null || line === null || line === undefined) return;
        services.debug.addBreakpoint(id, line);
      },
      removeBreakpointAtCursor: () => {
        const line = editorRef.current?.getCursorLine();
        const id = getState().activeScriptId;
        if (id === null || line === null || line === undefined) return;
        services.debug.removeBreakpointAt(id, line);
      },
      showBackendStatus: openDiagnostics,
      showUpdate: showUpdatePrompt,
      hasActiveScript: activeScriptId !== null,
      activeScriptId,
    }),
    [
      newScript,
      requestNewFolder,
      focusEditor,
      focusExplorer,
      toggleSidebar,
      toggleConsole,
      consoleLog.clear,
      openSettings,
      openDiagnostics,
      showUpdatePrompt,
      activeScriptId,
      getState,
      readDebugTarget,
      services,
    ],
  );

  /**
   * The next step an error presentation offers. Every one of them is an action
   * the shell already has; the error surface only names it.
   */
  const runErrorAction = useCallback(
    (action: ErrorActionId) => {
      switch (action) {
        case "detect-target":
          void services.target.detect();
          break;
        case "inject":
          void services.target.inject({ timeoutMs: settings.target.injectTimeoutMs });
          break;
        case "disconnect-target":
          void services.target.disconnect();
          break;
        case "open-settings":
          setDiagnosticsOpen(false);
          openSettings();
          break;
        case "new-script":
          setDiagnosticsOpen(false);
          newScript();
          break;
      }
    },
    [services, settings.target.injectTimeoutMs, openSettings, newScript],
  );

  const activeName = activeScript?.name ?? null;

  /** Read when a command runs, so the request captures exactly what is in the editor at that moment. */
  const readExecuteTarget = useCallback((): ExecuteTarget => {
    const { activeScriptId: id } = getState();
    const script = id === null ? undefined : getScript(id);
    if (!script) return { script: null, selectedText: "" };
    return {
      script: { id: script.id, name: script.name, content: script.content },
      selectedText: editorRef.current?.getSelectedText() ?? "",
    };
  }, [getState, getScript]);

  const executeActions = useExecuteCommand({ readTarget: readExecuteTarget, clearConsole: consoleLog.clear });
  const { execute, cancel: cancelExecution } = executeActions;

  const modalOpen = settingsOpen || dialogs.isOpen || diagnosticsOpen || paletteOpen || executeActions.isConfirming;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.metaKey || event.isComposing) return;
      const key = event.key.toLowerCase();

      // Cancel execution. Windows keeps Ctrl+Shift+Esc for Task Manager, so Shift+F5 does the same.
      if ((event.ctrlKey && event.shiftKey && key === "escape") || (!event.ctrlKey && event.shiftKey && key === "f5")) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) cancelExecution();
        return;
      }

      if (!event.ctrlKey) return;

      // The command palette. Monaco binds F1 for its own palette, so this takes
      // nothing from the editor.
      if (event.shiftKey && key === "p") {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        if (paletteOpen) closePalette();
        else if (!modalOpen) openPalette();
        return;
      }

      if (key === "`") {
        event.preventDefault();
        toggleConsole();
        return;
      }
      if (key === ",") {
        event.preventDefault();
        // A workspace confirmation, prompt or the command palette must be answered
        // first; stacking settings on one would share Escape between them.
        if (!dialogs.isOpen && !paletteOpen) openSettings();
        return;
      }

      // Dialogs own the keyboard while open.
      if (modalOpen || event.shiftKey) return;
      const inScripts = view === "scripts";

      switch (key) {
        case "s":
          event.preventDefault();
          if (!event.repeat && activeScriptId !== null) saveScript(activeScriptId);
          break;
        case "w":
          event.preventDefault();
          if (!event.repeat && inScripts && activeScriptId !== null) requestCloseScript(activeScriptId);
          break;
        case "t":
          event.preventDefault();
          if (!event.repeat) newScript();
          break;
        case "enter":
          // Captured before Monaco, which would otherwise insert a line below.
          event.preventDefault();
          event.stopPropagation();
          if (!event.repeat) execute("auto");
          break;
        case "f":
        case "h": {
          // Inside the editor Monaco handles these itself; elsewhere they open its find widget.
          const editor = editorRef.current;
          if (!inScripts || !editor || editor.hasFocus()) return;
          if (editor.runAction(key === "f" ? "actions.find" : "editor.action.startFindReplaceAction")) {
            event.preventDefault();
          }
          break;
        }
      }
    };

    // Capture phase, so the shortcuts work regardless of which element has focus.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    toggleConsole,
    openSettings,
    openPalette,
    closePalette,
    paletteOpen,
    dialogs.isOpen,
    modalOpen,
    view,
    activeScriptId,
    saveScript,
    requestCloseScript,
    newScript,
    execute,
    cancelExecution,
  ]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <TitleBar onOpenSettings={openSettings} documentName={activeName} onRequestClose={requestCloseWindow} />

      <div className="flex min-h-0 flex-1">
        <Sidebar
          view={view}
          onViewChange={setView}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={toggleSidebar}
          consoleOpen={consoleOpen}
          onToggleConsole={toggleConsole}
          scripts={
            <ScriptManager
              scripts={scripts}
              folders={folders}
              openScriptIds={openScriptIds}
              activeScriptId={activeScriptId}
              actions={scriptActions}
            />
          }
          explorer={<ExplorerPanel ref={explorerPanelRef} onInspect={focusInspector} />}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          {view === "explorer" ? <ExplorerWorkspace ref={explorerWorkspaceRef} /> : null}

          {view === "debugger" ? (
            <DebuggerWorkspace
              readTarget={readDebugTarget}
              resolveScriptName={resolveScriptName}
              onOpenScript={openScriptAtLine}
            />
          ) : null}

          {view === "profiler" ? <ProfilerWorkspace /> : null}

          {/* Kept mounted behind the other views so editor models, undo history and view state survive. */}
          <div className="flex min-h-0 flex-1 flex-col" hidden={view !== "scripts"}>
            <TabBar workspace={workspace} onRequestClose={requestCloseScript} onCreateScript={newScript} />
            <ScriptEditor
              ref={editorRef}
              activeScriptId={activeScriptId}
              openScriptIds={openScriptIds}
              readContent={readContent}
              onContentChange={updateContent}
              onSelectionChange={setHasSelection}
              settings={settings.editor}
              onCreateScript={newScript}
              debugDecorations={debugDecorations}
              onGutterClick={toggleBreakpoint}
            />
          </div>

          <ExecuteBar
            hasScript={activeName !== null}
            hasSelection={hasSelection}
            onExecute={execute}
            onCancel={cancelExecution}
            onShowHistory={showHistory}
            onShowDiagnostics={openDiagnostics}
          />

          {consoleOpen ? (
            <ConsolePanel
              log={consoleLog}
              tab={consoleTab}
              onTabChange={setConsoleTab}
              height={consoleHeight}
              onHeightChange={setConsoleHeight}
              onClose={toggleConsole}
              minHeight={CONSOLE_MIN_HEIGHT}
              maxHeight={consoleLimit}
            />
          ) : null}
        </main>
      </div>

      <StatusBar />

      <SettingsDialog open={settingsOpen} onClose={closeSettings} />

      <TargetDiagnosticsDialog open={diagnosticsOpen} onClose={closeDiagnostics} onErrorAction={runErrorAction} />

      <UpdateDialog />

      {paletteOpen ? <CommandPalette onClose={closePalette} actions={commandActions} /> : null}

      {dialogs.dialog}

      {executeActions.dialog}
    </div>
  );
}
