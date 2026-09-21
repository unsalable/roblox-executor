import type { languages } from "monaco-editor/editor";

export const LUA_LANGUAGE_ID = "lua";

/**
 * Editor behaviour for Lua: comment toggling, bracket matching, auto-closing
 * pairs and indentation after block openers. The indentation patterns follow
 * the ones VS Code ships for Lua.
 */
export const luaLanguageConfiguration: languages.LanguageConfiguration = {
  comments: {
    lineComment: "--",
    blockComment: ["--[[", "]]"],
  },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"', notIn: ["string"] },
    { open: "'", close: "'", notIn: ["string"] },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  indentationRules: {
    increaseIndentPattern:
      /^((?!(--)).)*((\b(else|function|then|do|repeat)\b((?!\b(end|until)\b).)*)|(\{\s*))$/,
    decreaseIndentPattern: /^\s*((\b(elseif|else|end|until)\b)|(\})|(\)))/,
  },
  folding: {
    markers: {
      start: /^\s*--\s*#?region\b/,
      end: /^\s*--\s*#?endregion\b/,
    },
  },
};

/**
 * Monarch grammar. Token names are the contract with `theme.ts`:
 *
 * - `keyword`, `constant.language` (true/false/nil), `variable.language` (self)
 * - `variable.predefined` (standard library globals)
 * - `function.declaration`, `function.call`, `variable.declaration` (names after `local`)
 * - `string`, `string.escape`, `string.invalid`, `number`, `comment`
 * - `operator`, `delimiter`
 */
export const luaMonarchLanguage: languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".lua",

  keywords: [
    "and", "break", "do", "else", "elseif", "end", "for", "function", "goto", "if", "in",
    "local", "not", "or", "repeat", "return", "then", "until", "while",
    // Luau
    "continue",
  ],

  constants: ["true", "false", "nil"],

  builtins: [
    "_G", "_VERSION", "assert", "collectgarbage", "error", "getmetatable", "ipairs", "next",
    "pairs", "pcall", "print", "rawequal", "rawget", "rawlen", "rawset", "require", "select",
    "setmetatable", "tonumber", "tostring", "type", "unpack", "xpcall",
    "coroutine", "debug", "math", "os", "string", "table", "utf8",
  ],

  brackets: [
    { open: "{", close: "}", token: "delimiter.curly" },
    { open: "[", close: "]", token: "delimiter.square" },
    { open: "(", close: ")", token: "delimiter.parenthesis" },
  ],

  escapes: /\\(?:[abfnrtvz\\"'\n]|x[0-9A-Fa-f]{2}|\d{1,3}|u\{[0-9A-Fa-f]+\})/,

  tokenizer: {
    root: [
      { include: "@whitespace" },

      [/function\b/, { token: "keyword", next: "@functionName" }],
      [/local\b/, { token: "keyword", next: "@localName" }],

      [
        /[a-zA-Z_]\w*(?=\s*[({"'])/,
        {
          cases: {
            "@keywords": "keyword",
            "@constants": "constant.language",
            "@default": "function.call",
          },
        },
      ],
      [
        /[a-zA-Z_]\w*/,
        {
          cases: {
            self: "variable.language",
            "@keywords": "keyword",
            "@constants": "constant.language",
            "@builtins": "variable.predefined",
            "@default": "identifier",
          },
        },
      ],

      { include: "@strings" },
      { include: "@numbers" },

      [/[{}()[\]]/, "@brackets"],
      [/\.\.\.|\.\.=|\/\/=|\.\.|\/\/|[=~<>]=|<<|>>|[+\-*/%^]=|::|[+\-*/%^#&~|<>=]/, "operator"],
      [/[;,.:]/, "delimiter"],
    ],

    whitespace: [
      [/[ \t\r\n]+/, ""],
      [/--\[(=*)\[/, { token: "comment", next: "@longComment.$1" }],
      [/--.*$/, "comment"],
    ],

    longComment: [
      [/[^\]]+/, "comment"],
      [/\](=*)\]/, { cases: { "$1==$S2": { token: "comment", next: "@pop" }, "@default": "comment" } }],
      [/./, "comment"],
    ],

    strings: [
      [/"([^"\\]|\\.)*$/, "string.invalid"],
      [/'([^'\\]|\\.)*$/, "string.invalid"],
      [/"/, { token: "string", next: '@string."' }],
      [/'/, { token: "string", next: "@string.'" }],
      [/\[(=*)\[/, { token: "string", next: "@longString.$1" }],
    ],

    string: [
      [/[^\\"']+/, "string"],
      [/@escapes/, "string.escape"],
      [/\\./, "string.escape.invalid"],
      [/["']/, { cases: { "$#==$S2": { token: "string", next: "@pop" }, "@default": "string" } }],
    ],

    longString: [
      [/[^\]]+/, "string"],
      [/\](=*)\]/, { cases: { "$1==$S2": { token: "string", next: "@pop" }, "@default": "string" } }],
      [/./, "string"],
    ],

    numbers: [
      [/0[xX][\da-fA-F_]*(\.[\da-fA-F_]*)?([pP][+-]?\d+)?/, "number.hex"],
      [/0[bB][01_]+/, "number.binary"],
      [/\d[\d_]*(\.[\d_]*)?([eE][+-]?\d+)?/, "number"],
      [/\.\d[\d_]*([eE][+-]?\d+)?/, "number"],
    ],

    // `function name`, `function Module.name`, `function Class:method`; anonymous functions pop straight back.
    functionName: [
      [/[ \t]+/, ""],
      [/[a-zA-Z_]\w*([.:][a-zA-Z_]\w*)*/, { token: "function.declaration", next: "@pop" }],
      [/./, { token: "@rematch", next: "@pop" }],
    ],

    // `local a, b = …`, `local function name`.
    localName: [
      [/[ \t]+/, ""],
      [/function\b/, { token: "keyword", switchTo: "@functionName" }],
      [
        /[a-zA-Z_]\w*/,
        {
          cases: {
            "@keywords": { token: "@rematch", next: "@pop" },
            "@default": { token: "variable.declaration", switchTo: "@localNameList" },
          },
        },
      ],
      [/./, { token: "@rematch", next: "@pop" }],
    ],

    localNameList: [
      [/[ \t]+/, ""],
      [/,/, { token: "delimiter", switchTo: "@localName" }],
      [/<\s*(const|close)\s*>/, "keyword"],
      [/./, { token: "@rematch", next: "@pop" }],
    ],
  },
};
