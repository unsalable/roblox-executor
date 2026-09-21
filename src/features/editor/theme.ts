import type { editor } from "monaco-editor/editor";

type MonacoApi = typeof import("monaco-editor/editor");

export const NOVA_THEME = "nova";

/**
 * Monaco cannot read CSS variables, so the theme is rebuilt from the
 * application's semantic tokens (`styles/globals.css`) whenever the root
 * `data-theme` changes. No colour is chosen here; every value is a token,
 * optionally with an alpha channel applied.
 */

function toHex(value: string): string | null {
  const color = value.trim();

  const hex = /^#([\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.exec(color);
  if (hex) {
    const digits = hex[1]!;
    return digits.length === 3
      ? `#${[...digits].map((digit) => digit + digit).join("")}`
      : `#${digits.toLowerCase()}`;
  }

  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(color);
  if (rgb) {
    const channel = (part: string) => Math.min(255, Number(part)).toString(16).padStart(2, "0");
    const alphaPart = rgb[4];
    const alpha =
      alphaPart === undefined
        ? ""
        : Math.round(
            Math.min(1, alphaPart.endsWith("%") ? Number(alphaPart.slice(0, -1)) / 100 : Number(alphaPart)) * 255,
          )
            .toString(16)
            .padStart(2, "0");
    return `#${channel(rgb[1]!)}${channel(rgb[2]!)}${channel(rgb[3]!)}${alpha}`;
  }

  return null;
}

function withAlpha(hex: string, alpha: number): string {
  const opaque = hex.slice(0, 7);
  return `${opaque}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
}

export function buildNovaTheme(): editor.IStandaloneThemeData {
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string) => toHex(styles.getPropertyValue(`--${name}`)) ?? "#808080";
  /** Token rules take six hex digits without `#`. */
  const ink = (name: string) => token(name).slice(1, 7);

  const isLight = document.documentElement.dataset.theme === "light";

  const background = token("background");
  const surface = token("surface");
  const surfaceSecondary = token("surface-secondary");
  const surfaceRaised = token("surface-raised");
  const border = token("border");
  const borderStrong = token("border-strong");
  const foreground = token("foreground");
  const muted = token("muted");
  const accent = token("accent");
  const warning = token("warning");

  return {
    base: isLight ? "vs" : "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: ink("code-plain") },
      { token: "identifier", foreground: ink("code-plain") },
      { token: "comment", foreground: ink("code-comment"), fontStyle: "italic" },
      { token: "keyword", foreground: ink("code-keyword") },
      { token: "constant.language", foreground: ink("code-number") },
      { token: "variable.language", foreground: ink("code-keyword"), fontStyle: "italic" },
      { token: "variable.predefined", foreground: ink("code-global") },
      { token: "variable.declaration", foreground: ink("foreground") },
      { token: "function.declaration", foreground: ink("code-function"), fontStyle: "bold" },
      { token: "function.call", foreground: ink("code-function") },
      { token: "string", foreground: ink("code-string") },
      { token: "string.escape", foreground: ink("code-number") },
      { token: "string.invalid", foreground: ink("danger") },
      { token: "number", foreground: ink("code-number") },
      { token: "operator", foreground: ink("code-punct") },
      { token: "delimiter", foreground: ink("code-punct") },
    ],
    colors: {
      focusBorder: token("focus"),
      foreground,
      descriptionForeground: muted,
      "icon.foreground": muted,
      "widget.shadow": isLight ? withAlpha(foreground, 0.12) : withAlpha(background, 0.6),

      "editor.background": background,
      "editor.foreground": token("code-plain"),
      "editorGutter.background": background,
      "editorLineNumber.foreground": token("code-line"),
      "editorLineNumber.activeForeground": muted,
      "editor.lineHighlightBackground": token("code-active-line"),
      "editor.lineHighlightBorder": withAlpha(background, 0),
      "editorCursor.foreground": accent,
      "editor.selectionBackground": withAlpha(accent, 0.3),
      "editor.inactiveSelectionBackground": withAlpha(accent, 0.16),
      "editor.selectionHighlightBackground": withAlpha(accent, 0.14),
      "editor.wordHighlightBackground": withAlpha(accent, 0.12),
      "editor.wordHighlightStrongBackground": withAlpha(accent, 0.2),
      "editor.findMatchBackground": withAlpha(warning, 0.45),
      "editor.findMatchHighlightBackground": withAlpha(warning, 0.2),
      "editor.findRangeHighlightBackground": withAlpha(accent, 0.08),
      "editorBracketMatch.background": withAlpha(accent, 0.14),
      "editorBracketMatch.border": withAlpha(accent, 0.55),
      "editorIndentGuide.background1": border,
      "editorIndentGuide.activeBackground1": borderStrong,
      "editorWhitespace.foreground": borderStrong,
      "editorRuler.foreground": border,
      "editorLink.activeForeground": accent,
      "editorError.foreground": token("danger"),
      "editorWarning.foreground": warning,

      "editorWidget.background": surface,
      "editorWidget.foreground": foreground,
      "editorWidget.border": borderStrong,
      "editorHoverWidget.background": surface,
      "editorHoverWidget.border": borderStrong,
      "editorSuggestWidget.background": surface,
      "editorSuggestWidget.border": borderStrong,
      "editorSuggestWidget.foreground": foreground,
      "editorSuggestWidget.selectedBackground": token("accent-soft"),
      "editorSuggestWidget.selectedForeground": foreground,
      "editorSuggestWidget.highlightForeground": accent,
      "editorSuggestWidget.focusHighlightForeground": accent,

      "input.background": surfaceSecondary,
      "input.foreground": foreground,
      "input.border": borderStrong,
      "input.placeholderForeground": token("subtle"),
      "inputOption.activeBorder": accent,
      "inputOption.activeBackground": token("accent-soft"),
      "inputOption.activeForeground": foreground,
      "toolbar.hoverBackground": surfaceRaised,

      "list.hoverBackground": surfaceRaised,
      "list.activeSelectionBackground": token("accent-soft"),
      "list.activeSelectionForeground": foreground,
      "list.inactiveSelectionBackground": surfaceRaised,
      "list.highlightForeground": accent,
      "quickInput.background": surface,
      "quickInput.foreground": foreground,
      "pickerGroup.border": border,
      "pickerGroup.foreground": muted,
      "menu.background": surface,
      "menu.foreground": foreground,
      "menu.border": borderStrong,
      "menu.selectionBackground": token("accent-soft"),
      "menu.selectionForeground": foreground,
      "menu.separatorBackground": border,

      "scrollbar.shadow": withAlpha(background, 0),
      "scrollbarSlider.background": withAlpha(borderStrong, 0.7),
      "scrollbarSlider.hoverBackground": withAlpha(muted, 0.45),
      "scrollbarSlider.activeBackground": withAlpha(muted, 0.6),
      "editorOverviewRuler.border": withAlpha(background, 0),
      "minimap.background": background,
      "minimapSlider.background": withAlpha(borderStrong, 0.35),
      "minimapSlider.hoverBackground": withAlpha(borderStrong, 0.55),
      "minimapSlider.activeBackground": withAlpha(borderStrong, 0.75),
      "editorStickyScroll.background": background,
      "editorStickyScrollHover.background": surfaceSecondary,
    },
  };
}

/** Defines (or redefines) the Nova theme from the current tokens and applies it. */
export function applyNovaTheme(monaco: MonacoApi): void {
  monaco.editor.defineTheme(NOVA_THEME, buildNovaTheme());
  monaco.editor.setTheme(NOVA_THEME);
}

/** Calls `onChange` whenever the application theme switches. Returns a cleanup function. */
export function observeAppTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/** The monospace stack from the design tokens, so the editor matches the rest of the UI. */
export function readCodeFontFamily(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--font-family-mono").trim() || "monospace";
}
