import type { editor } from "monaco-editor/editor";
import type { Settings } from "@/types/settings";

export type EditorSettings = Settings["editor"];

const clamp = (value: number, min: number, max: number, fallback: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

/**
 * Options that never change for the lifetime of an editor instance. Normal
 * editing features (multi-cursor, find/replace, folding, bracket matching,
 * clipboard, undo/redo) stay at Monaco's defaults.
 */
export const baseEditorOptions: editor.IStandaloneEditorConstructionOptions = {
  ariaLabel: "Script editor",
  automaticLayout: true,
  fixedOverflowWidgets: true,
  lineNumbers: "on",
  lineNumbersMinChars: 3,
  lineHeight: 1.55,
  // The debugger draws breakpoints here; clicking it toggles one.
  glyphMargin: true,
  folding: true,
  renderLineHighlight: "all",
  renderWhitespace: "selection",
  matchBrackets: "always",
  bracketPairColorization: { enabled: false },
  guides: { indentation: true, bracketPairs: false },
  autoClosingBrackets: "languageDefined",
  autoClosingQuotes: "languageDefined",
  autoSurround: "languageDefined",
  // "full" is required for the Lua indentation rules (indent after `then`, outdent on `end`).
  autoIndent: "full",
  detectIndentation: false,
  insertSpaces: true,
  quickSuggestions: { other: true, comments: false, strings: false },
  wordBasedSuggestions: "currentDocument",
  tabCompletion: "on",
  // Typing a complete keyword (`then`, `do`, `end`) and pressing Enter must start a new line.
  acceptSuggestionOnEnter: "smart",
  padding: { top: 8, bottom: 8 },
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
  overviewRulerBorder: false,
  hideCursorInOverviewRuler: true,
  stickyScroll: { enabled: false },
  // Link detection would let Ctrl+click navigate the application webview away.
  links: false,
  contextmenu: true,
  mouseWheelZoom: false,
};

/** Settings that can change while the editor is open; applied with `updateOptions`. */
export function editorOptionsFromSettings(
  settings: Pick<EditorSettings, "fontSize" | "wordWrap" | "minimap">,
): editor.IEditorOptions {
  return {
    fontSize: clamp(settings.fontSize, 10, 24, 14),
    wordWrap: settings.wordWrap ? "on" : "off",
    minimap: { enabled: settings.minimap, renderCharacters: false, maxColumn: 100, scale: 1 },
  };
}

/**
 * Indentation — and bracket pair colorization, whose palette is not part of
 * the design tokens — live on the text model in Monaco, not on the editor.
 */
export function modelOptionsFromSettings(tabSize: number): editor.ITextModelUpdateOptions {
  const size = clamp(tabSize, 1, 8, 2);
  return {
    tabSize: size,
    indentSize: size,
    insertSpaces: true,
    bracketColorizationOptions: { enabled: false, independentColorPoolPerBracketType: false },
  };
}
