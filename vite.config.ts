import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const readJson = (relativePath: string) =>
  JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"));

const pkg = readJson("./package.json");
const tauriConf = readJson("./src-tauri/tauri.conf.json");

const devHost = process.env.TAURI_DEV_HOST;
const isTauriDebug = process.env.TAURI_ENV_DEBUG === "true";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  define: {
    __APP_NAME__: JSON.stringify(tauriConf.productName),
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: devHost ?? false,
    ...(devHost ? { hmr: { protocol: "ws" as const, host: devHost, port: 1421 } } : {}),
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "chrome120",
    sourcemap: isTauriDebug,
    minify: !isTauriDebug,
    // The Monaco editor chunk (~3.8 MB minified) is loaded lazily from local disk
    // after the shell paints; everything else stays far below this limit.
    chunkSizeWarningLimit: 4096,
  },
});
