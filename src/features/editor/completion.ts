import type { IDisposable, languages } from "monaco-editor/editor";
import { LUA_LANGUAGE_ID } from "@/features/editor/language";

type MonacoApi = typeof import("monaco-editor/editor");

/**
 * Lua completion foundation.
 *
 * Entries are plain data grouped into sources; the Monaco provider only maps
 * them to completion items. A richer, API-aware source can be added to
 * `luaCompletionSources` later without touching the provider. Everything
 * listed here is standard Lua — no engine or platform API is claimed.
 */

export type CompletionKind = "keyword" | "snippet" | "function" | "module" | "constant";

export interface CompletionEntry {
  label: string;
  kind: CompletionKind;
  detail: string;
  /** Snippet body using Monaco snippet syntax. Plain entries insert their label. */
  snippet?: string;
}

/** What precedes the cursor: a bare word, or a member access such as `string.`. */
export type CompletionContext =
  | { scope: "global" }
  | { scope: "member"; object: string; separator: "." | ":" };

export type CompletionSource = (context: CompletionContext) => readonly CompletionEntry[];

const KEYWORDS = [
  "and", "break", "do", "else", "elseif", "end", "false", "for", "function", "if", "in", "local",
  "nil", "not", "or", "repeat", "return", "then", "true", "until", "while",
];

const keywordEntries: readonly CompletionEntry[] = KEYWORDS.map((label) => ({
  label,
  kind: "keyword",
  detail: "Lua keyword",
}));

const snippetEntries: readonly CompletionEntry[] = [
  { label: "function", kind: "snippet", detail: "function … end", snippet: "function ${1:name}(${2:args})\n\t$0\nend" },
  { label: "local function", kind: "snippet", detail: "local function … end", snippet: "local function ${1:name}(${2:args})\n\t$0\nend" },
  { label: "if", kind: "snippet", detail: "if … then … end", snippet: "if ${1:condition} then\n\t$0\nend" },
  { label: "ifelse", kind: "snippet", detail: "if … then … else … end", snippet: "if ${1:condition} then\n\t${2}\nelse\n\t$0\nend" },
  { label: "for", kind: "snippet", detail: "numeric for loop", snippet: "for ${1:i} = ${2:1}, ${3:10} do\n\t$0\nend" },
  { label: "forpairs", kind: "snippet", detail: "for … in pairs(…)", snippet: "for ${1:key}, ${2:value} in pairs(${3:t}) do\n\t$0\nend" },
  { label: "foripairs", kind: "snippet", detail: "for … in ipairs(…)", snippet: "for ${1:index}, ${2:value} in ipairs(${3:t}) do\n\t$0\nend" },
  { label: "while", kind: "snippet", detail: "while … do … end", snippet: "while ${1:condition} do\n\t$0\nend" },
  { label: "repeat", kind: "snippet", detail: "repeat … until", snippet: "repeat\n\t$0\nuntil ${1:condition}" },
  { label: "pcall", kind: "snippet", detail: "protected call", snippet: "local ${1:ok}, ${2:result} = pcall(${3:fn})" },
];

const fn = (label: string, detail: string): CompletionEntry => ({ label, kind: "function", detail });

const globalEntries: readonly CompletionEntry[] = [
  fn("assert", "assert(v, message?)"),
  fn("error", "error(message, level?)"),
  fn("getmetatable", "getmetatable(object)"),
  fn("ipairs", "ipairs(t)"),
  fn("next", "next(t, key?)"),
  fn("pairs", "pairs(t)"),
  fn("pcall", "pcall(f, ...)"),
  fn("print", "print(...)"),
  fn("rawequal", "rawequal(a, b)"),
  fn("rawget", "rawget(t, key)"),
  fn("rawset", "rawset(t, key, value)"),
  fn("require", "require(module)"),
  fn("select", "select(index, ...)"),
  fn("setmetatable", "setmetatable(t, metatable)"),
  fn("tonumber", "tonumber(value, base?)"),
  fn("tostring", "tostring(value)"),
  fn("type", "type(value)"),
  fn("xpcall", "xpcall(f, handler, ...)"),
  { label: "_G", kind: "constant", detail: "global environment table" },
  { label: "_VERSION", kind: "constant", detail: "Lua version string" },
  { label: "coroutine", kind: "module", detail: "coroutine library" },
  { label: "math", kind: "module", detail: "math library" },
  { label: "os", kind: "module", detail: "os library" },
  { label: "string", kind: "module", detail: "string library" },
  { label: "table", kind: "module", detail: "table library" },
];

const libraryMembers: Readonly<Record<string, readonly CompletionEntry[]>> = {
  string: [
    fn("byte", "string.byte(s, i?, j?)"),
    fn("char", "string.char(...)"),
    fn("find", "string.find(s, pattern, init?, plain?)"),
    fn("format", "string.format(formatstring, ...)"),
    fn("gmatch", "string.gmatch(s, pattern)"),
    fn("gsub", "string.gsub(s, pattern, repl, n?)"),
    fn("len", "string.len(s)"),
    fn("lower", "string.lower(s)"),
    fn("match", "string.match(s, pattern, init?)"),
    fn("rep", "string.rep(s, n)"),
    fn("reverse", "string.reverse(s)"),
    fn("sub", "string.sub(s, i, j?)"),
    fn("upper", "string.upper(s)"),
  ],
  table: [
    fn("concat", "table.concat(t, sep?, i?, j?)"),
    fn("insert", "table.insert(t, pos?, value)"),
    fn("remove", "table.remove(t, pos?)"),
    fn("sort", "table.sort(t, comp?)"),
    fn("unpack", "table.unpack(t, i?, j?)"),
  ],
  math: [
    fn("abs", "math.abs(x)"),
    fn("ceil", "math.ceil(x)"),
    fn("cos", "math.cos(x)"),
    fn("exp", "math.exp(x)"),
    fn("floor", "math.floor(x)"),
    fn("fmod", "math.fmod(x, y)"),
    fn("log", "math.log(x)"),
    fn("max", "math.max(x, ...)"),
    fn("min", "math.min(x, ...)"),
    fn("modf", "math.modf(x)"),
    fn("random", "math.random(m?, n?)"),
    fn("randomseed", "math.randomseed(x)"),
    fn("sin", "math.sin(x)"),
    fn("sqrt", "math.sqrt(x)"),
    fn("tan", "math.tan(x)"),
    { label: "huge", kind: "constant", detail: "math.huge" },
    { label: "pi", kind: "constant", detail: "math.pi" },
  ],
  os: [fn("clock", "os.clock()"), fn("date", "os.date(format?, time?)"), fn("time", "os.time(t?)")],
  coroutine: [
    fn("create", "coroutine.create(f)"),
    fn("resume", "coroutine.resume(co, ...)"),
    fn("running", "coroutine.running()"),
    fn("status", "coroutine.status(co)"),
    fn("wrap", "coroutine.wrap(f)"),
    fn("yield", "coroutine.yield(...)"),
  ],
};

export const luaCompletionSources: readonly CompletionSource[] = [
  (context) => (context.scope === "global" ? snippetEntries : []),
  (context) => (context.scope === "global" ? keywordEntries : []),
  (context) => {
    if (context.scope === "global") return globalEntries;
    return context.separator === "." ? (libraryMembers[context.object] ?? []) : [];
  },
];

const MEMBER_ACCESS = /([A-Za-z_]\w*)\s*([.:])\s*\w*$/;
const STRING_LITERAL = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;

/** `null` when the cursor is inside a line comment or an unterminated quoted string. */
export function resolveCompletionContext(linePrefix: string): CompletionContext | null {
  const code = linePrefix.replace(STRING_LITERAL, '""');
  if (code.includes("--") || /["']/.test(code.replace(/""/g, ""))) return null;

  const member = MEMBER_ACCESS.exec(code);
  if (member) return { scope: "member", object: member[1]!, separator: member[2] as "." | ":" };
  return { scope: "global" };
}

const SORT_GROUP: Record<CompletionKind, string> = {
  snippet: "0",
  keyword: "1",
  function: "2",
  module: "2",
  constant: "2",
};

export function registerLuaCompletions(
  monaco: MonacoApi,
  sources: readonly CompletionSource[] = luaCompletionSources,
): IDisposable {
  const { CompletionItemKind, CompletionItemInsertTextRule } = monaco.languages;
  const itemKind: Record<CompletionKind, languages.CompletionItemKind> = {
    keyword: CompletionItemKind.Keyword,
    snippet: CompletionItemKind.Snippet,
    function: CompletionItemKind.Function,
    module: CompletionItemKind.Module,
    constant: CompletionItemKind.Constant,
  };

  return monaco.languages.registerCompletionItemProvider(LUA_LANGUAGE_ID, {
    triggerCharacters: ["."],
    provideCompletionItems(model, position) {
      const linePrefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const context = resolveCompletionContext(linePrefix);
      if (!context) return { suggestions: [] };

      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const suggestions = sources.flatMap((source) =>
        source(context).map(
          (entry): languages.CompletionItem => ({
            label: entry.label,
            kind: itemKind[entry.kind],
            detail: entry.detail,
            insertText: entry.snippet ?? entry.label,
            ...(entry.snippet ? { insertTextRules: CompletionItemInsertTextRule.InsertAsSnippet } : {}),
            sortText: `${SORT_GROUP[entry.kind]}${entry.label}`,
            range,
          }),
        ),
      );

      return { suggestions };
    },
  });
}
