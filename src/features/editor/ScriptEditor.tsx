import { memo, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import type { editor, IDisposable } from "monaco-editor/editor";
import { Icon } from "@/components/ui/Icon";
import type { DebugDecoration } from "@/features/debugger/editorDecorations";
import { createDiagnosticLog } from "@/features/diagnostics/diagnostics";
import {
  baseEditorOptions,
  editorOptionsFromSettings,
  modelOptionsFromSettings,
  type EditorSettings,
} from "@/features/editor/editorOptions";
import { LUA_LANGUAGE_ID } from "@/features/editor/language";
import { applyNovaTheme, NOVA_THEME, observeAppTheme, readCodeFontFamily } from "@/features/editor/theme";

/** Editor messages go to the one log stream, tagged so they can be found among the rest. */
const log = createDiagnosticLog("Editor", "scriptEditor");

type MonacoApi = (typeof import("@/features/editor/monaco"))["monaco"];

let monacoLoader: Promise<MonacoApi> | null = null;

/** Loads the Monaco chunk once; a failed load can be retried. */
function loadMonaco(): Promise<MonacoApi> {
  monacoLoader ??= import("@/features/editor/monaco").then(
    (module) => module.monaco,
    (error: unknown) => {
      monacoLoader = null;
      throw error;
    },
  );
  return monacoLoader;
}

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface ScriptEditorHandle {
  /** True while keyboard focus is inside the editor, including its find widget. */
  hasFocus: () => boolean;
  /** Moves keyboard focus into the editor. False when it is not ready to take it. */
  focus: () => boolean;
  /** Runs a built-in editor action such as `actions.find`. Returns false when no script is open. */
  runAction: (actionId: string) => boolean;
  /** Text selected in the active script across all cursors, or an empty string. */
  getSelectedText: () => string;
  /** 1-based line the caret is on in the active script, or null when none is open. */
  getCursorLine: () => number | null;
  /** Scrolls a script to a line once it is shown, e.g. from a debugger stack frame. */
  revealLine: (scriptId: string, line: number) => void;
  /** Puts the caret at the end of a script once it is shown, e.g. right after it was created. */
  placeCursorAtEnd: (scriptId: string) => void;
  /**
   * Re-reads a script from the workspace after its content was changed outside
   * the editor (e.g. Discard Changes) and applies it to the open model as one
   * undoable edit. Scripts without a model pick the content up when shown.
   */
  syncContent: (scriptId: string) => void;
}

interface ScriptEditorProps {
  ref?: Ref<ScriptEditorHandle>;
  activeScriptId: string | null;
  openScriptIds: readonly string[];
  /** Reads a script's current content from the workspace when its model is created. */
  readContent: (id: string) => string | undefined;
  onContentChange: (id: string, content: string) => void;
  /** Reports whether the active script has a non-empty selection, only when that changes. */
  onSelectionChange?: (hasSelection: boolean) => void;
  settings: EditorSettings;
  onCreateScript: () => void;
  /**
   * What the debugger draws in the active script: a glyph for each breakpoint
   * and a highlight on the line execution is stopped at. The editor only
   * renders them; the debugger controller owns them.
   */
  debugDecorations?: readonly DebugDecoration[];
  /** The glyph margin was clicked, which is how a breakpoint is set or cleared. */
  onGutterClick?: (scriptId: string, line: number) => void;
}

interface ModelEntry {
  model: editor.ITextModel;
  subscription: IDisposable;
  /** Cursor, selection and scroll position, kept in memory while the tab is open. */
  viewState: editor.ICodeEditorViewState | null;
}

type LoadState = { status: "loading" } | { status: "ready"; monaco: MonacoApi } | { status: "error"; message: string };

function createModelEntry(
  monaco: MonacoApi,
  id: string,
  content: string,
  tabSize: number,
  onChange: (id: string, content: string) => void,
): ModelEntry {
  const uri = monaco.Uri.from({ scheme: "nova-script", path: `/${id}.lua` });
  // One model per script: a leftover model for the same script is replaced, never duplicated.
  monaco.editor.getModel(uri)?.dispose();

  const model = monaco.editor.createModel(content.replace(/\r\n?/g, "\n"), LUA_LANGUAGE_ID, uri);
  // Monaco defaults to CRLF on Windows; scripts are stored with LF.
  model.setEOL(monaco.editor.EndOfLineSequence.LF);
  model.updateOptions(modelOptionsFromSettings(tabSize));

  const subscription = model.onDidChangeContent(() => onChange(id, model.getValue()));
  return { model, subscription, viewState: null };
}

/** Puts the caret on a line and scrolls it into view, clamped to the model. */
function moveCursorToLine(instance: editor.IStandaloneCodeEditor, line: number): void {
  const model = instance.getModel();
  if (!model) return;
  const lineNumber = Math.min(Math.max(1, Math.round(line)), model.getLineCount());
  instance.setPosition({ lineNumber, column: 1 });
  instance.revealLineInCenterIfOutsideViewport(lineNumber);
}

function moveCursorToEnd(instance: editor.IStandaloneCodeEditor): void {
  const model = instance.getModel();
  if (!model) return;
  const lineNumber = model.getLineCount();
  instance.setPosition({ lineNumber, column: model.getLineMaxColumn(lineNumber) });
  instance.revealLine(lineNumber);
}

/**
 * The Monaco editor view for the script workspace.
 *
 * The workspace owns documents; this component only mirrors them. Each open
 * tab gets one text model, created from the workspace content the first time
 * the tab is shown, kept (with its undo history and view state) while the tab
 * stays open, and disposed when the tab closes. Edits flow back through
 * `onContentChange`; content is never pushed into Monaco on re-render, so
 * typing does not fight React.
 */
function ScriptEditorView({
  ref,
  activeScriptId,
  openScriptIds,
  readContent,
  onContentChange,
  onSelectionChange,
  settings,
  onCreateScript,
  debugDecorations,
  onGutterClick,
}: ScriptEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [instance, setInstance] = useState<editor.IStandaloneCodeEditor | null>(null);
  const models = useRef(new Map<string, ModelEntry>());
  const attachedId = useRef<string | null>(null);
  const cursorToEndFor = useRef<string | null>(null);
  const revealFor = useRef<{ scriptId: string; line: number } | null>(null);
  const decorations = useRef<editor.IEditorDecorationsCollection | null>(null);
  const latest = useRef({ readContent, onContentChange, onSelectionChange, settings, onGutterClick });
  const announced = useRef(false);

  useEffect(() => {
    latest.current = { readContent, onContentChange, onSelectionChange, settings, onGutterClick };
  });

  useEffect(() => {
    let cancelled = false;

    loadMonaco().then(
      (monaco) => {
        if (!cancelled) setLoad({ status: "ready", monaco });
      },
      (error: unknown) => {
        if (cancelled) return;
        log.error("Editor failed to load", error);
        setLoad({ status: "error", message: describeError(error) });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  useEffect(() => {
    const container = containerRef.current;
    if (load.status !== "ready" || !container) return;

    const { monaco } = load;
    const entries = models.current;
    let created: editor.IStandaloneCodeEditor;

    try {
      applyNovaTheme(monaco);
      created = monaco.editor.create(container, {
        ...baseEditorOptions,
        ...editorOptionsFromSettings(latest.current.settings),
        fontFamily: readCodeFontFamily(),
        theme: NOVA_THEME,
        model: null,
      });
    } catch (error) {
      log.error("Editor could not be created", error);
      setLoad({ status: "error", message: describeError(error) });
      return;
    }

    const stopObservingTheme = observeAppTheme(() => applyNovaTheme(monaco));
    void document.fonts.ready.then(() => monaco.editor.remeasureFonts());

    let hadSelection = false;
    const reportSelection = () => {
      const hasSelection =
        created.getModel() !== null && (created.getSelections() ?? []).some((selection) => !selection.isEmpty());
      if (hasSelection === hadSelection) return;
      hadSelection = hasSelection;
      latest.current.onSelectionChange?.(hasSelection);
    };
    const selectionSubscriptions = [
      created.onDidChangeCursorSelection(reportSelection),
      created.onDidChangeModel(reportSelection),
      // The glyph margin is the debugger's: clicking it sets or clears a breakpoint.
      created.onMouseDown((event) => {
        if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
        const line = event.target.position?.lineNumber;
        const scriptId = attachedId.current;
        if (line === undefined || scriptId === null) return;
        latest.current.onGutterClick?.(scriptId, line);
      }),
    ];

    decorations.current = created.createDecorationsCollection();

    setInstance(created);
    if (!announced.current) {
      announced.current = true;
      log.info("Editor initialized");
    }

    return () => {
      stopObservingTheme();
      for (const subscription of selectionSubscriptions) subscription.dispose();
      if (hadSelection) latest.current.onSelectionChange?.(false);
      decorations.current = null;
      created.dispose();
      for (const entry of entries.values()) {
        entry.subscription.dispose();
        entry.model.dispose();
      }
      entries.clear();
      attachedId.current = null;
      setInstance(null);
    };
  }, [load]);

  useEffect(() => {
    if (!instance || load.status !== "ready") return;

    const entries = models.current;
    const previousId = attachedId.current;

    if (previousId !== null && previousId !== activeScriptId) {
      const previous = entries.get(previousId);
      if (previous) previous.viewState = instance.saveViewState();
    }

    for (const [id, entry] of entries) {
      if (openScriptIds.includes(id)) continue;
      entry.subscription.dispose();
      entry.model.dispose();
      entries.delete(id);
    }

    if (activeScriptId === previousId) return;
    attachedId.current = null;

    if (activeScriptId === null) {
      instance.setModel(null);
      return;
    }

    let entry = entries.get(activeScriptId);
    if (!entry) {
      const content = latest.current.readContent(activeScriptId);
      if (content === undefined) {
        log.warn(`Active script ${activeScriptId} is not in the workspace; nothing to show`);
        instance.setModel(null);
        return;
      }

      entry = createModelEntry(load.monaco, activeScriptId, content, latest.current.settings.tabSize, (id, text) =>
        latest.current.onContentChange(id, text),
      );
      entries.set(activeScriptId, entry);
    }

    instance.setModel(entry.model);
    if (entry.viewState) instance.restoreViewState(entry.viewState);
    if (cursorToEndFor.current === activeScriptId) {
      cursorToEndFor.current = null;
      moveCursorToEnd(instance);
    }
    const reveal = revealFor.current;
    if (reveal !== null && reveal.scriptId === activeScriptId) {
      revealFor.current = null;
      moveCursorToLine(instance, reveal.line);
    }
    attachedId.current = activeScriptId;
    instance.focus();
  }, [instance, load, openScriptIds, activeScriptId]);

  /**
   * What the debugger draws. The collection is replaced rather than diffed:
   * a stop changes at most a handful of lines, and Monaco does the diffing.
   */
  useEffect(() => {
    const collection = decorations.current;
    if (!instance || load.status !== "ready" || collection === null) return;

    if (activeScriptId === null || debugDecorations === undefined || debugDecorations.length === 0) {
      collection.clear();
      return;
    }

    const { monaco } = load;
    collection.set(
      debugDecorations.map((decoration) => ({
        range: new monaco.Range(decoration.line, 1, decoration.line, 1),
        options: {
          isWholeLine: decoration.lineClassName !== undefined,
          ...(decoration.glyphClassName === undefined ? {} : { glyphMarginClassName: decoration.glyphClassName }),
          ...(decoration.lineClassName === undefined ? {} : { className: decoration.lineClassName }),
          ...(decoration.marginClassName === undefined
            ? {}
            : { linesDecorationsClassName: decoration.marginClassName }),
          glyphMarginHoverMessage: { value: decoration.hoverMessage },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      })),
    );
  }, [instance, load, activeScriptId, debugDecorations]);

  const { fontSize, wordWrap, minimap, tabSize } = settings;

  useEffect(() => {
    instance?.updateOptions(editorOptionsFromSettings({ fontSize, wordWrap, minimap }));
  }, [instance, fontSize, wordWrap, minimap]);

  useEffect(() => {
    const options = modelOptionsFromSettings(tabSize);
    for (const entry of models.current.values()) entry.model.updateOptions(options);
  }, [instance, tabSize]);

  useImperativeHandle(
    ref,
    () => ({
      hasFocus: () => instance?.hasWidgetFocus() ?? false,
      focus: () => {
        if (!instance?.getModel()) return false;
        instance.focus();
        return true;
      },
      runAction: (actionId) => {
        const action = instance?.getModel() ? instance.getAction(actionId) : null;
        if (!instance || !action) return false;
        instance.focus();
        action.run().catch((error: unknown) => log.error(`Editor action ${actionId} failed`, error));
        return true;
      },
      getSelectedText: () => {
        const model = instance?.getModel();
        const selections = instance?.getSelections();
        if (!model || !selections) return "";
        return selections
          .filter((selection) => !selection.isEmpty())
          .map((selection) => model.getValueInRange(selection))
          .join("\n");
      },
      getCursorLine: () => {
        if (!instance?.getModel()) return null;
        return instance.getPosition()?.lineNumber ?? null;
      },
      revealLine: (scriptId, line) => {
        if (instance && attachedId.current === scriptId) moveCursorToLine(instance, line);
        else revealFor.current = { scriptId, line };
      },
      placeCursorAtEnd: (scriptId) => {
        if (instance && attachedId.current === scriptId) moveCursorToEnd(instance);
        else cursorToEndFor.current = scriptId;
      },
      syncContent: (scriptId) => {
        const entry = models.current.get(scriptId);
        const content = latest.current.readContent(scriptId)?.replace(/\r\n?/g, "\n");
        if (!entry || content === undefined || entry.model.getValue() === content) return;

        const { model } = entry;
        model.pushStackElement();
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text: content }], () => null);
        model.pushStackElement();
      },
    }),
    [instance],
  );

  const hasScript = activeScriptId !== null;

  return (
    <div className="relative min-h-0 flex-1 bg-background">
      <div ref={containerRef} className="absolute inset-0" hidden={!hasScript || load.status !== "ready"} />

      {load.status === "error" ? (
        <EditorMessage icon="error" title="Editor unavailable">
          <p className="mt-1 max-w-sm font-mono text-[11px] break-words text-subtle">{load.message}</p>
          <p className="mt-2 max-w-sm text-xs text-muted">
            Scripts are kept in the workspace, not in the editor, so nothing has been lost.
          </p>
          <button
            type="button"
            onClick={() => {
              setLoad({ status: "loading" });
              setAttempt((count) => count + 1);
            }}
            className="mt-4 rounded border border-border-strong px-3 py-1.5 text-xs text-foreground transition-colors duration-[var(--dur-fast)] hover:border-accent hover:bg-surface-raised"
          >
            Try again
          </button>
        </EditorMessage>
      ) : !hasScript ? (
        <EditorMessage icon="file" title="No script open">
          <p className="mt-1 text-xs text-subtle">Create a new script or open one from the sidebar.</p>
          <button
            type="button"
            onClick={onCreateScript}
            className="mt-4 flex items-center gap-1.5 rounded border border-border-strong px-3 py-1.5 text-xs text-foreground transition-colors duration-[var(--dur-fast)] hover:border-accent hover:bg-surface-raised"
          >
            <Icon name="plus" size={14} />
            New Script
            <kbd className="ml-2 font-mono text-[10px] text-subtle">Ctrl+T</kbd>
          </button>
        </EditorMessage>
      ) : load.status === "loading" ? (
        <p className="absolute inset-0 flex items-center justify-center text-xs text-subtle">Loading editor…</p>
      ) : null}
    </div>
  );
}

function EditorMessage({
  icon,
  title,
  children,
}: {
  icon: "file" | "error";
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center">
      <Icon name={icon} size={28} className={icon === "error" ? "text-danger" : "text-subtle"} />
      <p className="mt-4 text-sm text-muted">{title}</p>
      {children}
    </div>
  );
}

export const ScriptEditor = memo(ScriptEditorView);
