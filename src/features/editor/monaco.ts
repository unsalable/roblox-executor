/**
 * Monaco entry point, loaded lazily by `ScriptEditor` so the rest of the UI
 * paints before the editor bundle is parsed.
 *
 * Only the editor core and its standard contributions (find/replace, suggest,
 * folding, multi-cursor, clipboard, …) are imported — none of Monaco's
 * bundled language definitions — and Lua is registered from `language.ts`.
 * Registration happens once, at module evaluation, for the lifetime of the app.
 */
import "monaco-editor/features/register.all";
import * as monaco from "monaco-editor/editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { registerLuaCompletions } from "@/features/editor/completion";
import { LUA_LANGUAGE_ID, luaLanguageConfiguration, luaMonarchLanguage } from "@/features/editor/language";

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

monaco.languages.register({ id: LUA_LANGUAGE_ID, extensions: [".lua"], aliases: ["Lua", "lua"] });
monaco.languages.setLanguageConfiguration(LUA_LANGUAGE_ID, luaLanguageConfiguration);
monaco.languages.setMonarchTokensProvider(LUA_LANGUAGE_ID, luaMonarchLanguage);
registerLuaCompletions(monaco);

export { monaco };
