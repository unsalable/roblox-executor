# Nova

A Windows desktop application for writing Lua scripts and running them against a replaceable
**target**, with a developer toolkit — object Explorer, Debugger and Profiler — built on the same
provider boundary.

Nova is a **development environment and reference architecture**, not a game tool. Everything it
can reach lives inside its own process: it does not enumerate, open, read or write another
process, does not load code into one, does not touch memory outside itself, opens no socket, binds
no address, listens on no port, and bypasses nothing. The target Nova attaches to is either a
simulation inside Nova or a service running in Nova's own process, and the UI always says which.

> **Nova does not interact with Roblox, or with any other running application.** Script execution
> is simulated: the source you write is never evaluated, never written to disk and never passed to
> a shell. See [What is simulated](#what-is-simulated) for exactly what is real and what is not.

## Contents

- [Features](#features)
- [Install](#install)
- [Automatic updates](#automatic-updates)
- [What is simulated](#what-is-simulated)
- [Security boundaries](#security-boundaries)
- [Development](#development)
- [Testing](#testing)
- [Build](#build)
- [Releasing](#releasing)
- [Architecture](#architecture)
- [Known limitations](#known-limitations)
- [License](#license)

## Features

**Script workspace.** A Monaco editor with Lua syntax highlighting and completion, tabs with
per-tab undo history, unsaved-change tracking, and a script manager with folders (up to four
levels), favourites, search, duplicate, move and rename. Autosave writes 750 ms after the last
change and when the window hides, so closing Nova never loses work; the unsaved dot clears only on
an explicit save. Folders are an internal hierarchy — nothing is created on disk.

**Target workflow.** Detection, an Inject action, a session, diagnostics, history and every
timeout are Nova's; a `TargetProvider` owns the attach mechanism. The state machine is
`unavailable → detected → ready → injecting → injected → disconnecting → ready`, with `error` and
`cancelled` as resting states. An inject request carries no address, handle, module, process or
script field — injecting never depends on a script.

**Execution.** Run the whole script or the selection, with confirmation, a timeout, cancellation
and a 100-entry history. Execution requires an *injected* target, and losing the target ends a run
in flight as `TARGET_DISCONNECTED` rather than leaving it to time out.

**Explorer.** An object hierarchy with a shared developer selection (entirely separate from the
editor's text selection), a Property Inspector grouped into Identity / Transform / Appearance /
State / Data, search, and a full keyboard-navigable ARIA tree. Every property is read-only.

**Debugger.** Breakpoints set in the editor gutter and kept between launches, a session with a call
stack, locals and watches, and step over / into / out. Breakpoints are configuration and persist;
no session state ever does — Nova always starts with no session.

**Profiler.** Record a session and read a bucketed timeline and per-function timings, with a
ten-entry history.

**Console and diagnostics.** One log stream, tagged by subsystem (Editor, Workspace, Explorer,
Debugger, Profiler, Execution, Target, Backend, Updates, System) and filterable by category, plus
an execution-history tab. Every target and execution error code has a written explanation and a
real next action.

**Command palette.** `Ctrl+Shift+P` reaches every action the shell already has — workspace, view,
console, Explorer, target, debugger, profiler, backend and update commands. Nothing is listed that
does not exist: a command either runs a real handler or says why it cannot right now.

**Settings.** General, Editor, Appearance, Executor, Target, Developer, Updates and Performance,
stored locally. Dark is the default; a complete light palette is switchable.

## Install

Download the latest `Nova_<version>_x64-setup.exe` from
[Releases](https://github.com/unsalable/roblox-executor/releases/latest) and run it.

Requirements: Windows 10 or 11 (x64) and the WebView2 runtime, which is preinstalled on Windows 11
and installed by the setup program otherwise.

The installer is not code-signed with a commercial certificate, so Windows SmartScreen may warn on
first run. The *update* artifacts are signed — see below.

## Automatic updates

Nova updates itself from its own GitHub releases.

- **One fixed source.** The endpoint is compiled into the application
  (`src-tauri/tauri.conf.json`). It is not a setting, and nothing in the UI or in stored data can
  point Nova at another server.
- **Nothing unsigned is ever installed.** Every artifact is verified in Rust against the minisign
  public key built into the application before it is written anywhere. A signature that does not
  verify is a refusal, not a prompt: Nova says so, installs nothing, and leaves the running build
  untouched.
- **One check, shortly after launch.** Nova asks once, about four seconds after the window opens,
  and not again unless you ask it to. Settings › Updates turns the startup check off; with it off,
  Nova makes no network request at all.
- **Offline is not an error.** A check that cannot reach GitHub is logged at debug level and
  nothing is shown. Nova stays completely usable.
- **No telemetry.** The update check and the update download are the only requests Nova makes to
  anything outside your machine. Nothing about you, your scripts or your usage is sent anywhere.

When an update is found, a small dialog offers **Update** or **Later**; it shows the installed
build, the new build, the release notes and a download progress bar, and ends with **Restart and
Update**. Your workspace, scripts, folders, favourites, tabs, breakpoints and settings survive the
update. You can dismiss the dialog at any point — including mid-download, which continues in the
background. "Check for Updates" is in the command palette and in Settings › Updates.

### Versions and builds

Nova has no marketing version. A release is identified by **when it was built**: the tag is
`release-YYYY-MM-DD-HHMM` and the version the application reports is the same instant written as
`YYYY.MMDD.HHMM`, which is a valid semantic version whose ordering is the ordering of the instants
it comes from. The UI shows it as a date and time (`2026-09-21 13:50 UTC`). You never choose
between versions: Nova knows which build is installed, asks which is latest, and offers the
difference. The scheme is defined and unit-tested in
[`src/app/releaseVersion.ts`](src/app/releaseVersion.ts).

## What is simulated

Nova ships two **developer backends**, chosen in Settings › Developer. A backend supplies the
target, debugger and profiler providers; the choice takes effect on the next launch.

| Backend | What it is | Target | Debugger | Profiler |
| --- | --- | --- | --- | --- |
| **Local Mock** (default) | Every provider is a simulation inside Nova. | Local Test Target — simulated | Mock — simulated | Mock — simulated |
| **Local Service** | Real: a service in Nova's own Rust process, reached only over the application's IPC. | Local Service Session — real | none — reported unsupported | none — reported unsupported |

**Simulated in both backends:**

- **Execution.** `LocalTestExecutionProvider` is the only execution provider and is used under
  both backends. It produces plausible output and timings from the request's shape. **Your script's
  source is never evaluated, written to disk or passed to a shell.** The simulated outcome —
  succeed, fail, run slowly, stop partway — is chosen in the *Simulation controls* section of the
  target diagnostics dialog.
- **Explorer.** `MockExplorerProvider` serves a fixed hierarchy written inside Nova.
- **Debugger and Profiler** under the Local Mock: the call stack is arithmetic over line numbers,
  and the profiler's samples come from a fixed table and a seeded generator.

**Real:**

- The **Local Service** backend talks to a service in Nova's own Rust process over Tauri IPC
  (`invoke("local_service_request")`) — no socket, no port, no listener. The protocol is
  `NOVA_LOCAL_SERVICE_V1` with a 64 KiB message limit and five operations; the session token is 32
  bytes of OS randomness, compared in constant time, and lives only in a closure in the session
  client. It supplies a target and says plainly that it supplies no debugger and no profiler,
  rather than simulating them.
- The **updater** is real, and is the only part of Nova that reaches the network.

Every simulated provider marks itself as such, and the UI says so wherever it shows state.

## Security boundaries

These are enforced by tests that read the source on every run
([`security.test.ts`](src/features/backend/backends/localService/security.test.ts),
[`protocolParity.test.ts`](src/features/backend/backends/localService/protocolParity.test.ts)),
not merely promised here.

- **No other process is touched.** No process enumeration, no `OpenProcess`, no process handle, no
  `ReadProcessMemory`/`WriteProcessMemory`, no `CreateRemoteThread`, no DLL injection, no memory
  patching, no library loading, no anti-cheat interaction.
- **No `unsafe`, no FFI.** There is no `unsafe` block, `extern` declaration or `#[link]` attribute
  anywhere in the Rust — which is *proof* the Win32 calls above cannot be reached, not a promise
  that they are not.
- **No shell, no arbitrary execution.** Nothing starts a process or runs a command. The only
  `std::process` call in the whole tree is `exit(1)` when startup fails.
- **No socket, no listener.** The only channel between the frontend and Rust is Tauri IPC, with
  exactly two commands: `app_info` and `local_service_request`.
- **Minimal capabilities.** The complete grant is `core:app`, `core:event`, `core:window` (plus
  drag, minimize, toggle-maximize and close for the custom title bar), `core:webview`,
  `updater:default`, and `process:allow-restart` — which restarts Nova and can neither start nor
  inspect any other process. There is no filesystem, shell, HTTP or dialog permission. The list is
  pinned by an exact-match test, so adding one is a deliberate edit with a reason beside it.
- **Tight CSP.** `default-src 'self'`, `script-src 'self'` (no `unsafe-eval`, no `unsafe-inline`,
  no host), `connect-src 'self' ipc: http://ipc.localhost`, `base-uri 'self'`, `form-action
  'none'`. Every directive is pinned by test. The updater fetches from **Rust**, not from the
  page, so reaching GitHub did not require opening the page's network policy — also a test.
- **No secrets stored or logged.** The local service's session token is never written to storage,
  never logged, never rendered and never placed in a diagnostic or error string. Only the
  workspace, the settings and the breakpoints are persisted; no runtime session state ever is.
- **No telemetry.** No analytics, no usage reporting, no undisclosed endpoint.

The updater's **private signing key is not in this repository** and never will be. See
[Releasing](#releasing).

## Development

Prerequisites:

- **Node 22.18+** (the test runner relies on unflagged TypeScript type stripping; Node 24 is fine)
- **Rust stable, 1.82 or newer**, MSVC toolchain
- **WebView2 runtime** (preinstalled on Windows 11)
- **Windows.** Nova bundles for Windows only (`bundle.targets = ["nsis"]`).

```bash
npm install
npm run dev
```

`npm run dev` starts Vite and opens the Tauri window. `npm run dev:web` runs the frontend alone in
a browser; in that mode the Tauri bridge reports "not available", the window controls are replaced
by a "web preview" marker, and the updater is inert — a development build never checks for updates
and never reaches the network.

## Testing

```bash
npm run typecheck                    # TypeScript
npm test                             # 813 unit tests (node:test, no framework)
npm run build:web                    # typecheck + frontend bundle

cd src-tauri
cargo fmt --all -- --check           # Rust formatting
cargo check --all-targets            # Rust compile check
cargo clippy --all-targets -- -D warnings
cargo test                           # the local service: protocol, auth, session, limits
```

The unit tests cover the pure logic — the workspace and its migrations, every state machine,
the controllers (with a fake clock and scripted providers), settings normalisation, error
presentation, the command builders, the update flow and the release-version scheme — plus the
source-reading security tests described above. The Rust tests cover the local service's protocol,
authentication, session handling and message limits.

Because the update flow sits behind a provider boundary, its unit tests exercise every outcome the
real updater can produce without a network, a release or a packaged build: no update, a newer
update, the same version, an invalid signature, a download failure, an unreachable source,
malformed release metadata and the successful installation path.

The built application is checked separately, because no test runner can answer whether the release
binary starts, whether Monaco takes real keystrokes or whether a workspace survives a restart:

```bash
npm run build -- --no-bundle
npm run verify:release        # 68 checks against the built nova.exe
```

Those drive `nova.exe` over the WebView2 debugging port against a throwaway user-data folder, so a
verification run never touches a real profile. See
[scripts/verify-release](scripts/verify-release/README.md).

## Build

```bash
npm run build                    # release binary + NSIS installer
npm run build -- --no-bundle     # binary only, no installer
```

The binary lands at `src-tauri/target/release/nova.exe` and the installer under
`src-tauri/target/release/bundle/nsis/`.

A local build produces **no updater artifacts** unless `TAURI_SIGNING_PRIVATE_KEY` is set, because
`bundle.createUpdaterArtifacts` is on and Tauri refuses to emit an unsigned updater bundle. That is
deliberate: an unsigned artifact would be refused by every installed copy of Nova anyway, so
failing at build time is better than discovering it at update time.

## Releasing

Publishing a release is one action — push a tag:

```bash
git tag release-2026-09-21-1350
git push origin release-2026-09-21-1350
```

[`.github/workflows/release.yml`](.github/workflows/release.yml) then, on a Windows runner:
stamps the version derived from the tag into `package.json`, `Cargo.toml` and `Cargo.lock`; runs
typecheck, the unit tests, the frontend build, `cargo fmt --check`, `cargo clippy -D warnings` and
`cargo test`; builds and signs the application; uploads the artifacts into a **draft** release;
verifies that the draft carries the installer, its detached signature and a `latest.json` naming
the version that was actually built with a non-empty signature; and only then publishes the release
and marks it **Latest**. If any step fails, the draft is deleted and nothing is published.

A release therefore carries three files: `Nova_<version>_x64-setup.exe` (what a person downloads,
and what the updater downloads too — Tauri signs the installer itself rather than a separate
archive), `Nova_<version>_x64-setup.exe.sig` (the signature it is verified against) and
`latest.json` (what an installed Nova reads to learn a newer build exists).

### Signing key

The updater's private key never enters this repository, the source, or the installer. `*.key`,
`*.pem`, `*.pfx` and `*.p12` are in `.gitignore` so a key copied in by accident cannot be
committed.

To set up signing once:

```bash
npx tauri signer generate -w "$HOME/.nova/nova-updater.key"
```

Then:

1. Put the **public** key (`nova-updater.key.pub`) in `src-tauri/tauri.conf.json` under
   `plugins.updater.pubkey`. It is public by design and belongs in version control.
2. Add the **private** key's contents as the repository secret `TAURI_SIGNING_PRIVATE_KEY`
   (Settings › Secrets and variables › Actions). If the key has a password, add it as
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
3. Keep a backup of the private key somewhere safe and offline. **If it is lost, no future release
   can be verified by the copies of Nova already installed**, and every user has to reinstall by
   hand.

Rotating the key means shipping a build that trusts the new public key *before* publishing a
release signed with it — otherwise installed copies reject the update that would have taught them
the new key.

## Architecture

```text
Nova UI
  → tool controllers        target, debugger, profiler, execution, explorer — they own the logic
  → provider interfaces     TargetProvider, DebuggerProvider, ProfilerProvider, …
  → DeveloperBackend        one coherent set of providers, with a lifecycle of its own
  → providers               a simulation, or the local service
```

`src/app/services.tsx` is the composition root and the boundary the rest of the application never
bypasses: the UI talks to controllers, reads provider metadata, and never holds a provider or a
backend implementation. The backend hands its providers over **once**, at startup, and the
controllers are built on them there — which is what makes Restart Backend safe: the editor, the
open scripts, Monaco's undo history and the breakpoints are untouched, because nothing above the
providers is rebuilt.

Controllers own all domain state and publish snapshots that components read through
`useSyncExternalStore`. `AppShell` holds UI-only state; settings live in `src/app/store.tsx`. No
state-management, UI, icon or animation library is used — the runtime dependencies are exactly
React, Monaco, the Tauri API and the two Tauri plugins the updater needs.

```text
src/
  app/          config, the settings store, the release-version scheme, services.tsx (the
                composition root) and devTools.ts, the one place backend readiness, target
                presence and backend capabilities meet
  components/   ErrorBoundary; layout/ (title bar, sidebar, navigation, app shell);
                ui/ (icons, dialog, menu, form controls)
  features/
    backend/    the developer backend adapter layer: model, lifecycle state machine, capability
                and health derivation, registry, controller, stand-in providers for a tool a
                backend does not supply, the two shipped backends and the Developer Status panel
    commands/   the command palette: model, filtering, and the command builders per feature
    console/    logger-backed output panel
    debugger/   types, state machine, breakpoints as data, session controller, persistence,
                editor decorations, hooks and panes
    diagnostics/ structured developer diagnostics: categories, reporters, logger adapter
    editor/     Monaco view, Lua language + completion, token-derived theme, editor options
    errors/     one written presentation per target and execution error code
    execution/  types, state machine, validation, controller, history, the local test provider
    explorer/   model and provider boundary, controller, shared developer selection, inspector
    profiler/   types, state machine, sample aggregation, controller, timeline
    scripts/    workspace transitions, persistence and migration, manager, dialogs, tab bar
    settings/   settings dialog
    status/     status bar, target diagnostics, Tauri bridge probe, frame-rate meter
    target/     the external-target model: types, state machine, controller, history, provider
    updates/    the updater: types, state machine, controller, the Tauri provider and the dialog
  lib/          logger, local storage, clock and id helpers, search, clipboard, Tauri IPC
  styles/       Tailwind entry point and the semantic design tokens
  types/        application state, settings and workspace types
scripts/        test-loader.mjs (lets `node --test` resolve `@/` and the build constants) and
                apply-release-version.mjs (stamps a tag's version into the manifests)
src-tauri/
  src/          main.rs (entry), lib.rs (builder, registers the plugins and the two IPC commands),
                commands.rs (app_info, local_service_request)
    local_service/ the in-process developer service: mod.rs and protocol.rs
  capabilities/ window-scoped permissions
.github/workflows/  ci.yml (the gates on every push) and release.yml (tag → signed release)
experimental/   parked work that is not built, tested or shipped; see experimental/README.md
```

**Tokens.** Colours are never hardcoded in components. `styles/globals.css` defines semantic tokens
and maps them into Tailwind utilities (`bg-surface`, `text-muted`, `text-code-keyword`, …).

**Persistence.** `nova.workspace` (schema v2, migrated from v1), `nova.settings`, `nova.debugger`
(breakpoints, schema v1) and `nova.workspace.backup`. Loading validates everything: malformed data
falls back to a safe workspace, repairs are logged, and whenever stored data has to be dropped the
original text is copied to the backup key **first** — and if that copy fails, the unattended
autosave holds off rather than overwriting what may be the only copy of your scripts.

**Three lifecycles, never collapsed into one.** Backend readiness, target presence and what the
backend supplies are separate facts, and every combination of them is legitimate. `app/devTools.ts`
is the one place they meet, and the one place a tool's "there is nothing to work against" reason is
decided.

## Known limitations

These are real and deliberate, not oversights:

- **No provider attaches to anything outside Nova.** There is no target provider for an external
  application, and writing one is outside this project's scope.
- **Execution is simulated under both backends.** Script source is never evaluated. The local
  service implements no `execute` operation.
- **The Explorer, Debugger and Profiler run on mock data** under the Local Mock backend; the Local
  Service backend supplies no debugger and no profiler at all and reports them as unsupported.
- **Explorer properties are read-only.** Nothing can be written back.
- **Breakpoint conditions can be stored but are never evaluated**, and watches resolve a plain name
  or a single field only.
- **No file import or export.** Scripts live in the workspace, not on disk.
- **No drag and drop** in the script manager.
- **Closing with Alt+F4 or from the taskbar keeps unsaved work as drafts without asking**, because
  intercepting native close requests would need a window permission Nova does not grant.
- **The installer is not commercially code-signed**, so SmartScreen may warn on first run. Update
  artifacts are signed with the project's own key, which is a different guarantee.
- **Windows only.**

## License

[MIT](LICENSE) © 2026 unsalable
