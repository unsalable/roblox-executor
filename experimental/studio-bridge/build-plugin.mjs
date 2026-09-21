// Packages studio-plugin/src into a Roblox model file that Studio can load as
// a local plugin. It writes the same structure as `rojo build` (a Script with
// one ModuleScript per module) but needs nothing beyond Node, so installing the
// plugin never requires extra tooling.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const sourceDir = join(root, "plugin", "src");
const outputDir = join(root, "plugin", "build");
const outputPath = join(outputDir, "NovaStudioBridge.rbxmx");

const ENTRY = "init.server.luau";
const PLUGIN_NAME = "NovaStudioBridge";

/** Escapes text for an XML element body. */
const escapeXml = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Wraps Lua in CDATA. A literal "]]>" would close the section early, so it is
 * split across two sections — the only escaping CDATA allows.
 */
const cdata = (text) => `<![CDATA[${text.split("]]>").join("]]]]><![CDATA[>")}]]>`;

const script = (className, name, source, referent, children = "") =>
  [
    `  <Item class="${className}" referent="${referent}">`,
    `    <Properties>`,
    `      <string name="Name">${escapeXml(name)}</string>`,
    className === "Script" ? `      <token name="RunContext">0</token>` : null,
    `      <string name="Source">${cdata(source)}</string>`,
    `    </Properties>`,
    children,
    `  </Item>`,
  ]
    .filter((line) => line !== null)
    .join("\n");

const read = (file) => readFileSync(join(sourceDir, file), "utf8");

const modules = readdirSync(sourceDir)
  .filter((file) => file.endsWith(".luau") && file !== ENTRY)
  .sort();

let referent = 0;
const children = modules
  .map((file) => script("ModuleScript", file.replace(/\.luau$/, ""), read(file), `${++referent}`))
  .join("\n");

const document = [
  `<roblox version="4">`,
  script("Script", PLUGIN_NAME, read(ENTRY), "0", children),
  `</roblox>`,
  "",
].join("\n");

mkdirSync(outputDir, { recursive: true });
writeFileSync(outputPath, document, "utf8");

const target =
  process.platform === "win32"
    ? "%LOCALAPPDATA%\\Roblox\\Plugins"
    : "~/Documents/Roblox/Plugins";

console.log(`Built ${PLUGIN_NAME}.rbxmx (${modules.length + 1} scripts)`);
console.log(`  ${outputPath}`);
console.log(`Copy it into your Roblox plugins folder, then restart Studio:`);
console.log(`  ${target}`);
