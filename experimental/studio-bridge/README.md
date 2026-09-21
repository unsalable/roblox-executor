# Studio bridge (parked experiment)

> **Not part of Nova.** This directory is a snapshot of an abandoned direction, kept for
> reference. None of it is built, bundled, type-checked, tested or loaded by the application, and
> nothing in `src/` imports it. It is not maintained.

## What it was

A loopback-only bridge between Nova and a Roblox Studio plugin you installed yourself:

```text
Nova (React UI → controllers → StudioBridge)
  | Tauri commands / events
Local relay (Rust, 127.0.0.1 only)
  | HTTP: POST /nova/rpc, POST /nova/poll (long-poll), GET /nova/info
Nova Studio Bridge plugin (Luau)
  | delivers a Script instance
The place you have open in Roblox Studio
```

It paired with a six-digit single-use code, issued a memory-only session token, ran a heartbeat, and
carried execution requests to the plugin. The plugin **delivered** a script into `ServerStorage/Nova`
and said so; it never ran one, because a Studio plugin has no supported way to compile arbitrary
source (`loadstring` is unavailable to plugins and there is no command-bar API).

## Why it was parked

Nova's product direction changed to a standalone executor-style workflow built around an external
**target**: detect → ready → inject → execute. Roblox Studio is not that target, and the Studio
plugin's honest boundary — deliver, never execute — could not become the product's execution story.
Rather than keep a second, contradictory workflow in the main window, the whole direction was moved
here in one piece.

## What replaced it, and what was carried over

`src/features/target` is the replacement: a `TargetProvider` boundary, one authoritative target state
machine, an inject request/result model with timeouts, cancellation, diagnostics and session history.
It does not import anything from this directory, but it inherits the ideas that were worth keeping:

- a provider interface the controller drives, so the mechanism is replaceable in one place;
- two axes that are never collapsed into one (here: bridge listening vs Studio connected; now:
  target status vs session);
- a controller that owns state, timeouts, cancellation and history, ignores late provider results,
  and refuses impossible transitions;
- structured error codes instead of raw exceptions;
- a fake clock and a simulated peer, so the whole lifecycle is unit-tested without networking.

## Contents

| Path | What it is |
| --- | --- |
| `plugin/` | The Roblox Studio plugin (Luau): protocol, transport, connection, delivery, panel. See `plugin/README.md`. |
| `build-plugin.mjs` | Packages `plugin/src` into `plugin/build/NovaStudioBridge.rbxmx`. Run it with `node experimental/studio-bridge/build-plugin.mjs`; it is no longer an npm script. |
| `nova-frontend/` | The Nova side of the bridge: wire protocol, pairing, session, Tauri and in-memory transports, provider adapters, bridge UI, a fake Studio client and their unit tests. Written against `@/` paths that no longer resolve. |
| `nova-connection/` | The connection controller and its local test provider that the bridge was adapted onto. `src/features/target` replaces both. |
| `relay-rust/` | The Rust loopback HTTP relay (`mod.rs`, `http.rs`) and its tests, removed from `src-tauri`. |

## If it is ever revived

Three things have to be rebuilt deliberately, not pasted back:

1. `nova-frontend` imports `@/features/connection/*` and `@/features/execution/*`; the execution
   provider contract has since changed (`requiresConnection` → `requiresTarget`, `NOT_CONNECTED` →
   `TARGET_NOT_READY`, `STUDIO_CONNECTION_LOST` → `TARGET_DISCONNECTED`).
2. `relay-rust` has to be declared as a module in `src-tauri/src/lib.rs` again and its commands
   registered. It binds a loopback TCP listener directly through `std::net`, so re-adding it puts a
   local listener back into the shipping binary — a deliberate decision, not a detail.
3. The settings it needs (`studioBridge.port`, `studioBridge.pairingTimeoutMs`, the provider choice)
   were removed from `src/types/settings.ts`; stored copies are dropped by `normalizeSettings`.
