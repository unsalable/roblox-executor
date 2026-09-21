// Lets `node --test` run the TypeScript unit tests in src/ without a test framework:
// Node strips the types itself; this file only adds what Vite normally provides —
// the `@/` import alias, `import.meta.env` and the build-time app constants.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const SRC = new URL("../src/", import.meta.url);

globalThis.__APP_NAME__ = "Nova";
globalThis.__APP_VERSION__ = "test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      for (const extension of [".ts", ".tsx"]) {
        const url = new URL(`${specifier.slice(2)}${extension}`, SRC);
        if (existsSync(fileURLToPath(url))) return nextResolve(url.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.startsWith(SRC.href) || !url.endsWith(".ts")) return result;
    return { ...result, source: `import.meta.env ??= { DEV: false, PROD: true, MODE: "test" };\n${result.source}` };
  },
});
