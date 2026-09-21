# Release verification

Checks the **built application**, not the source. The unit tests cover Nova's
logic; these cover what only the real binary can answer — that it starts, that
Monaco takes real keystrokes, that a workspace survives a restart while a debug
session does not, and that the page reaches nothing outside Nova.

Every run uses a fresh WebView2 user-data folder under the system temp
directory, so it never touches the profile a real install keeps in
`%LOCALAPPDATA%\dev.nova.desktop`.

## Running

Build first, then run the four checks **in order** — the first three work on
the state the previous one left behind:

```bash
npm run build -- --no-bundle
npm run verify:release
```

Or one at a time:

```bash
node scripts/verify-release/check-1.mjs   # workspace, editor, Explorer, palette
node scripts/verify-release/check-2.mjs   # target, execution, debugger, profiler, backend, updates
node scripts/verify-release/check-3.mjs   # persistence across four launches, and the network scan
node scripts/verify-release/check-4.mjs   # the real backend: session, authentication, capabilities
```

`NOVA_EXE` overrides which executable is driven (an installed copy, for
instance) and `NOVA_DEBUG_PORT` the debugging port.

## What each file is

| File | What it holds |
| --- | --- |
| `harness.mjs` | Launching, the debugging-port connection, `eval`/`exec`, waiting and reporting |
| `page.mjs` | Selectors, real keyboard and mouse events, and the helpers the checks are written against |
| `check-1.mjs` | Scripts, folders, favourites, search, the editor, the Explorer, the Property Inspector, the command palette, and a scan of what the UI says |
| `check-2.mjs` | The whole target workflow, execution, the debugger, the profiler, the backend lifecycle and the update flow |
| `check-3.mjs` | What survives four restarts, what must not, and proof the page never reaches the network |
| `check-4.mjs` | The Local Service backend: its authenticated session, a restart issuing a new one, the tools it reports as unsupported rather than simulating, and proof its token reaches nothing |

## Things worth knowing before editing these

- **Shortcuts read `event.key`, not `event.code`.** Send both.
- **Monaco 0.56 uses `EditContext`,** so there is no hidden `<textarea>` to
  focus. `page.mjs`'s `focusEditor` clicks the last rendered line at its real
  coordinates instead, and `Input.insertText` is more reliable than synthesised
  key events for typing.
- **Panel titles are uppercased by CSS** and `innerText` returns what is
  rendered, so compare lowercased.
- **A palette row's first line is the category chip,** not the command title;
  match against the whole row.
- **`http://ipc.localhost` is Tauri's own IPC channel.** It belongs in the
  network scan's allowlist; the updater fetches from Rust and never appears
  there at all, which is what proves the page's network policy was not opened.
- **The persisted script shape is not the in-memory one:** stored `content` is
  the *saved* content and an unsaved buffer is a separate `draft` field.
- **Autosave writes 750 ms after a change,** so read local storage after it
  rather than immediately.
- **A click that closes the window** leaves the pending debugging call
  unresolved; fire it from inside a `setTimeout` in the page.

## Testing the updater end to end

The checks above exercise the update flow against a scripted provider and
against the real release source, but they cannot prove that one published build
installs another — that needs two releases and a real installation.

When it is worth doing (after changing anything in `src/features/updates`, the
updater configuration, or the signing key):

1. Publish a release, then install it somewhere disposable:

   ```bash
   gh release download <tag> --pattern "*-setup.exe" --dir .
   ./Nova_<version>_x64-setup.exe /S /D=C:\Users\<you>\AppData\Local\NovaUpdateTest
   ```

   `/D` must come last and must not be quoted.

2. Launch the installed copy against a throwaway profile and confirm it reports
   the version you installed:

   ```bash
   NOVA_EXE=C:\Users\<you>\AppData\Local\NovaUpdateTest\Nova.exe \
     node scripts/verify-release/check-1.mjs
   ```

3. Publish a second release with a later tag.

4. Launch the installed copy again and run **Check for Updates**. It should
   offer the newer build, download it, verify its signature, install it and
   offer to restart. Confirm afterwards that the installed copy reports the new
   version and that its workspace, breakpoints and settings are untouched.

5. Uninstall: `C:\Users\<you>\AppData\Local\NovaUpdateTest\uninstall.exe /S`.

A signature that does not verify is the case that matters most and the hardest
to stage; `updateController.test.ts` covers it directly, by handing the
controller the exact failure the updater reports.
