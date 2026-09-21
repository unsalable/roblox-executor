# Experimental

Work that is **not part of the Nova application**. Nothing in this directory is compiled, bundled,
type-checked, tested or shipped: `tsconfig.json` includes `src` only, Vite bundles from `src`, the
unit tests glob `src/**/*.test.ts`, and Cargo compiles `src-tauri/src`.

It is kept because it worked and may be worth reading, not because the product uses it.

| Directory | What it is | Status |
| --- | --- | --- |
| [studio-bridge](studio-bridge/README.md) | An abandoned direction: a loopback HTTP bridge between Nova and a Roblox Studio plugin. | Parked. Superseded by the target workflow in `src/features/target`, which needs no external plugin and opens no socket. |
