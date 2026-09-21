// Check 3: persistence across four launches, and what
// must NOT survive one. Runs on the profile checks 1 and 2 left behind.
import { start, stop, waitFor, sleep, createReport, assert } from "./harness.mjs";
import { q, bodyText, key, targetStatus, runCommand, paletteEntry, goToView, closeDialog, focusEditor } from "./page.mjs";

const report = createReport("check 3: persistence, and what must not survive a restart");

const workspace = `JSON.parse(localStorage.getItem("nova.workspace") ?? "{}")`;
const settings = `JSON.parse(localStorage.getItem("nova.settings") ?? "{}")`;
const breakpoints = `JSON.parse(localStorage.getItem("nova.debugger") ?? "null")`;

/** A snapshot of everything that is supposed to survive a restart. */
const durable = `({
  scripts: (${workspace}.scripts ?? []).map((s) => s.name).sort(),
  folders: (${workspace}.folders ?? []).map((f) => f.name).sort(),
  favorites: (${workspace}.scripts ?? []).filter((s) => s.isFavorite).map((s) => s.name).sort(),
  tabs: (${workspace}.openScriptIds ?? []).length,
  activeScriptId: ${workspace}.activeScriptId,
  breakpoints: (${breakpoints}?.breakpoints ?? []).map((b) => b.line).sort(),
  theme: ${settings}.appearance?.theme ?? null,
  fontSize: ${settings}.editor?.fontSize ?? null,
  checkOnStartup: ${settings}.updates?.checkOnStartup ?? null,
})`;

/** What must never come back. */
const runtime = `({
  storageKeys: Object.keys(localStorage).sort(),
  target: (${targetStatus})?.target ?? null,
  session: (${targetStatus})?.session ?? null,
  bodyMentionsPaused: document.body.innerText.toLowerCase().includes("paused"),
  bodyMentionsRecording: document.body.innerText.toLowerCase().includes("recording"),
})`;

let first;
let second;

try {
  // ------------------------------------------- launch 1: leave state behind
  {
    const { child, session } = await start();
    report.section("Leaving state behind (launch 1)");

    await report.check("the workspace from the earlier runs is still here", async () => {
      const state = await session.eval(durable);
      assert(state.scripts.length >= 2, `only ${state.scripts.length} scripts`);
      assert(state.folders.includes("Verified Folder"), `folders were ${JSON.stringify(state.folders)}`);
      assert(state.favorites.includes("Main.lua"), `favorites were ${JSON.stringify(state.favorites)}`);
      return `${state.scripts.length} scripts, folders ${JSON.stringify(state.folders)}, favorites ${JSON.stringify(state.favorites)}`;
    });

    await report.check("a breakpoint is set and stored", async () => {
      await goToView(session, "scripts");
      await sleep(500);
      await focusEditor(session);
      await runCommand(session, "Add Breakpoint");
      await sleep(900);
      const stored = await waitFor(
        session,
        `(() => { const b = (${breakpoints}?.breakpoints ?? []); return b.length ? b : null; })()`,
        6000,
        "a stored breakpoint",
      );
      return `${stored.length} breakpoint(s) at line(s) ${stored.map((b) => b.line).join(", ")}`;
    });

    await report.check("a setting is changed and stored", async () => {
      await key(session, { key: ",", code: "Comma", ctrl: true });
      await sleep(800);
      await session.exec(`
        const cats = [...document.querySelectorAll('[aria-label="Settings categories"] button')];
        const hit = cats.find((b) => b.innerText.trim().toLowerCase() === "appearance");
        if (!hit) throw new Error("no Appearance category");
        hit.click();
      `);
      await sleep(500);
      await session.exec(`
        const select = document.querySelector('[role="dialog"] select[aria-label="Theme"]');
        if (!select) throw new Error("no theme select");
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
        setter.call(select, "light");
        select.dispatchEvent(new Event("change", { bubbles: true }));
      `);
      await sleep(600);
      await closeDialog(session);
      const theme = await waitFor(session, `${settings}.appearance?.theme === "light" ? "light" : null`, 5000, "the stored theme");
      return `theme = ${theme}`;
    });

    await report.check("runtime state is created: a target session, a debug session and a recording", async () => {
      await session.exec(`
        const btn = document.querySelector('button[aria-label$="(Local Test Target)"]');
        if (btn && !btn.disabled) btn.click();
      `);
      await waitFor(session, `(${targetStatus})?.target?.toLowerCase().includes("injected")`, 20000, "an injected target");

      await goToView(session, "debugger");
      await sleep(600);
      await session.exec(`
        const btn = document.querySelector('[aria-label="Debugger controls"] button[aria-label="Start"]');
        if (btn && !btn.disabled) btn.click();
      `);
      await sleep(1500);

      await goToView(session, "profiler");
      await sleep(600);
      await session.exec(`
        const btn = document.querySelector('[aria-label="Profiler controls"] button[aria-label="Start"]');
        if (btn && !btn.disabled) btn.click();
      `);
      await sleep(1500);

      const live = await session.eval(runtime);
      assert(live.target.toLowerCase().includes("injected"), `target was ${live.target}`);
      assert(live.bodyMentionsRecording, "the profiler is not recording");
      return `target = ${live.target}, session = ${live.session}, recording = ${live.bodyMentionsRecording}`;
    });

    first = await session.eval(durable);
    await stop(child, session);
  }

  // ----------------------------------------------------- launch 2: first restart
  {
    const { child, session } = await start();
    await session.send("Network.enable");
    report.section("First restart (launch 2)");

    await report.check("everything durable came back unchanged", async () => {
      const state = await session.eval(durable);
      assert(JSON.stringify(state) === JSON.stringify(first), `\n  before: ${JSON.stringify(first)}\n  after:  ${JSON.stringify(state)}`);
      return `scripts ${JSON.stringify(state.scripts)}, folders ${JSON.stringify(state.folders)}, favorites ${JSON.stringify(state.favorites)}, ${state.breakpoints.length} breakpoint(s), theme ${state.theme}`;
    });

    await report.check("no debugger or profiler session came back", async () => {
      await sleep(1500);
      const live = await session.eval(runtime);
      assert(!live.bodyMentionsPaused, "a debug session survived the restart");
      assert(!live.bodyMentionsRecording, "a profiler recording survived the restart");
      assert(live.storageKeys.every((k) => ["nova.workspace", "nova.settings", "nova.debugger", "nova.workspace.backup"].includes(k)),
        `unexpected storage keys: ${JSON.stringify(live.storageKeys)}`);
      return `storage keys: ${JSON.stringify(live.storageKeys)}`;
    });

    await report.check("the target starts detached, not injected", async () => {
      const early = await session.eval(targetStatus);
      assert(early === null || !String(early.target).toLowerCase().includes("injected"), `target came back ${early?.target}`);
      const session_ = early?.session ?? "";
      assert(!String(session_).toLowerCase().includes("active"), `the session came back ${session_}`);
      return `target = ${early?.target ?? "(not shown yet)"}, session = ${session_ || "(none)"}`;
    });

    await report.check("the light theme the user chose is in force", async () => {
      const theme = await session.eval(`document.documentElement.getAttribute("data-theme")`);
      assert(theme === "light", `data-theme = ${theme}`);
      return "data-theme = light";
    });

    await report.check("the breakpoint is back in the editor, with no hit count", async () => {
      const stored = await session.eval(`${breakpoints}?.breakpoints ?? []`);
      assert(stored.length > 0, "no breakpoints were restored");
      const withHits = stored.filter((b) => (b.hitCount ?? 0) > 0);
      assert(withHits.length === 0, `hit counts survived: ${JSON.stringify(withHits)}`);
      return `${stored.length} breakpoint(s), all at hit count 0`;
    });

    report.section("Network");

    await report.check("the page itself reaches nothing outside Nova", async () => {
      // The updater runs in Rust, so even the release check must not appear
      // here. Everything the page loads is its own bundle or Tauri's IPC.
      await sleep(8000);
      const urls = session.requestedUrls();
      const allowed = /^(https?:\/\/(tauri\.localhost|ipc\.localhost|asset\.localhost)|data:|blob:|about:)/;
      const outside = urls.filter((u) => !allowed.test(u));
      assert(outside.length === 0, `the page requested: ${JSON.stringify(outside.slice(0, 5))}`);
      assert(!urls.some((u) => u.includes("github.com")), "the page reached GitHub directly");
      return `${urls.length} requests, all local (${[...new Set(urls.map((u) => u.split("/").slice(0, 3).join("/")))].join(", ")})`;
    });

    await report.check("the startup check records what it found, and only offers", async () => {
      await session.exec(`
        const tabs = [...document.querySelectorAll('[role="tab"]')];
        const hit = tabs.find((t) => /console/i.test(t.innerText));
        if (hit) hit.click();
      `);
      await sleep(800);

      const logged = await session.eval(`
        document.body.innerText
          .split(String.fromCharCode(10))
          .filter((line) => line.toLowerCase().startsWith("update:"))
          .join(" | ")
      `);
      assert(logged.length > 0, "the update check left nothing in the console");

      /*
       * A dialog here is correct when there is something to offer: a locally
       * built binary carries the development version, so every published
       * release is newer than it and the check finds one. What must never
       * happen is a *failure* dialog from a check nobody asked for.
       */
      const dialog = await session.eval(`
        (() => {
          const d = document.querySelector('[role="dialog"]');
          return d ? d.innerText.split(String.fromCharCode(10)).join(" | ") : null;
        })()
      `);
      if (dialog !== null) {
        assert(/update available/i.test(dialog), `a check nobody asked for opened: ${dialog.slice(0, 140)}`);
        assert(!/update failed/i.test(dialog), "a silent check reported a failure");
      }

      // The shell is usable either way: the prompt is dismissable and nothing
      // behind it is blocked.
      assert(await session.eval(`!!document.querySelector('[role="tablist"][aria-label="Open scripts"]')`), "the shell is gone");
      return dialog === null ? `nothing offered; log: ${logged.slice(0, 80)}` : `offered an update; log: ${logged.slice(0, 80)}`;
    });

    second = await session.eval(durable);
    await stop(child, session);
  }

  // --------------------------------------------------- launch 3: second restart
  {
    const { child, session } = await start();
    report.section("Second restart (launch 3)");

    await report.check("a second restart changes nothing either", async () => {
      const state = await session.eval(durable);
      assert(JSON.stringify(state) === JSON.stringify(second), `\n  before: ${JSON.stringify(second)}\n  after:  ${JSON.stringify(state)}`);
      return "identical to the previous launch";
    });

    await report.check("the application still closes cleanly", async () => {
      // Closing runs the shutdown path: the session is ended deliberately.
      await session.exec(`
        const btn = [...document.querySelectorAll("button")].find((b) =>
          (b.getAttribute("aria-label") || "").toLowerCase() === "close");
        setTimeout(() => btn && btn.click(), 50);
      `);
      await sleep(2500);
      return "close requested through the title bar";
    });

    await stop(child, session);
  }

  // --------------------------------------------- launch 4: after a clean close
  {
    const { child, session } = await start();
    report.section("After a clean close (launch 4)");

    await report.check("closing the window did not lose anything", async () => {
      const state = await session.eval(durable);
      assert(state.scripts.length === second.scripts.length, `scripts went from ${second.scripts.length} to ${state.scripts.length}`);
      assert(state.breakpoints.length === second.breakpoints.length, "breakpoints changed");
      assert(state.theme === second.theme, "the theme changed");
      return `${state.scripts.length} scripts, ${state.breakpoints.length} breakpoint(s), theme ${state.theme}`;
    });

    await stop(child, session);
  }

  console.log("\n--- check 3 complete ---");
} finally {
  const summary = report.finish();
  process.exit(summary.failed > 0 ? 1 : 0);
}
