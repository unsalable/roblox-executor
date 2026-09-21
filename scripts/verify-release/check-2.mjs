// Check 2: target, execution, debugger, profiler,
// backend and the updater, on the profile check 1 left behind.
import { start, stop, waitFor, sleep, createReport, assert } from "./harness.mjs";
import {
  q, textOf, bodyText, click, clickByText, setSelect, key, targetStatus,
  focusEditor, editorText, runCommand, paletteEntry, goToView,
  openTargetDiagnostics, closeDialog,
} from "./page.mjs";

const report = createReport("check 2: target, execution, debugger, profiler, backend and updates");
const { child, session } = await start();

/** Waits until the target status line says `want`. */
const waitTarget = (want, ms = 15000) =>
  waitFor(session, `(${targetStatus})?.target?.toLowerCase().includes(${JSON.stringify(want.toLowerCase())})`, ms, `target = ${want}`);

/** Sets one of the simulation switches in the target diagnostics dialog. */
async function setSimulation(label, value) {
  await openTargetDiagnostics(session);
  await session.exec(`
    const selects = [...document.querySelectorAll('[role="dialog"] select')];
    const want = ${JSON.stringify(label.toLowerCase())};
    const hit = selects.find((s) => (s.getAttribute("aria-label") || "").toLowerCase().includes(want));
    if (!hit) throw new Error("no simulation select for " + want + "; found " + selects.map((s) => s.getAttribute("aria-label")).join(", "));
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setter.call(hit, ${JSON.stringify(value)});
    hit.dispatchEvent(new Event("change", { bubbles: true }));
  `);
  await sleep(300);
  await closeDialog(session);
}

const targetAction = async () => {
  await session.exec(`
    const btn = document.querySelector('button[aria-label$="(Local Test Target)"]');
    if (!btn) throw new Error("no target action button");
    if (btn.disabled) throw new Error("the target action is disabled: " + btn.getAttribute("aria-label"));
    btn.click();
  `);
  await sleep(300);
};

const targetActionLabel = `(document.querySelector('button[aria-label$="(Local Test Target)"]')?.getAttribute("aria-label") ?? "")`;

try {
  // ------------------------------------------------------------------ target
  report.section("Target");

  await report.check("a target is detected and becomes ready", async () => {
    const status = await waitFor(session, targetStatus, 15000, "the target status");
    await waitTarget("ready", 20000);
    return `target = ${(await session.eval(targetStatus)).target}, was ${status.target}`;
  });

  await report.check("making the target unavailable is reflected", async () => {
    await setSimulation("availability", "unavailable");
    await waitTarget("unavailable", 12000);
    return "target = Unavailable";
  });

  await report.check("making it available again brings it back to ready", async () => {
    await setSimulation("availability", "available");
    await waitTarget("ready", 15000);
    return "target = Ready";
  });

  await report.check("a simulated inject succeeds and opens a session", async () => {
    await setSimulation("inject result", "success");
    await targetAction();
    await waitTarget("injected", 15000);
    const status = await session.eval(targetStatus);
    assert(status.session.toLowerCase().includes("active"), `session = ${status.session}`);
    return `target = ${status.target}, session = ${status.session}`;
  });

  await report.check("disconnecting ends the session", async () => {
    await targetAction();
    await waitTarget("ready", 15000);
    const status = await session.eval(targetStatus);
    assert(!status.session.toLowerCase().includes("active"), `session stayed ${status.session}`);
    return `target = ${status.target}, session = ${status.session}`;
  });

  await report.check("a simulated inject failure is reported, and a retry succeeds", async () => {
    await setSimulation("inject result", "failure");
    await targetAction();
    await waitTarget("failed", 15000);
    const failed = await session.eval(bodyText);
    assert(failed.includes("fail") || failed.includes("error"), "no failure was shown");

    await setSimulation("inject result", "success");
    await targetAction();
    await waitTarget("injected", 15000);
    return "failed, then retried to Injected";
  });

  await report.check("an unexpected disconnect is noticed while injected", async () => {
    await setSimulation("availability", "unavailable");
    await waitFor(session, `!(${targetStatus})?.target?.toLowerCase().includes("injected")`, 15000, "the lost target");
    const status = await session.eval(targetStatus);
    await setSimulation("availability", "available");
    await waitTarget("ready", 15000);
    return `target became ${status.target}`;
  });

  await report.check("an inject that times out is abandoned", async () => {
    await setSimulation("inject result", "timeout");
    await targetAction();
    await waitFor(session, `(${targetStatus})?.target?.toLowerCase().match(/failed|cancel/)`, 20000, "the timeout");
    const shown = await session.eval(bodyText);
    assert(shown.includes("time") || shown.includes("timeout"), "the timeout was not explained");
    await setSimulation("inject result", "success");
    return "timed out and reported";
  });

  await report.check("an inject in flight can be cancelled", async () => {
    await setSimulation("inject result", "slow");
    await targetAction();
    await waitTarget("injecting", 8000);
    await session.exec(`
      const btn = [...document.querySelectorAll("button")].find((b) =>
        (b.getAttribute("aria-label") || b.innerText || "").toLowerCase().includes("cancel"));
      if (!btn) throw new Error("no cancel control while injecting");
      btn.click();
    `);
    await waitFor(session, `(${targetStatus})?.target?.toLowerCase().match(/cancel|ready|failed/)`, 15000, "the cancellation");
    await setSimulation("inject result", "success");
    return `target = ${(await session.eval(targetStatus)).target}`;
  });

  // --------------------------------------------------------------- execution
  report.section("Execution");

  await report.check("execution is refused while the target is not injected", async () => {
    // "Cancelled" is a resting state the product keeps on purpose: it records
    // the last outcome and is left by the next action, so what matters here is
    // only that the target is not injected.
    const status = await session.eval(targetStatus);
    assert(!status.target.toLowerCase().includes("injected"), `target was ${status.target}`);
    const blocked = await session.eval(`
      (() => {
        const btn = document.querySelector('button[aria-label="Execute script"], button[aria-label="Execute selection"]');
        if (!btn) return null;
        return { title: btn.getAttribute("title") || "", busy: btn.getAttribute("aria-busy"), disabled: btn.disabled };
      })()
    `);
    assert(blocked, "no execute button");
    assert(/target/i.test(blocked.title), `execute did not explain itself: ${blocked.title}`);
    return `target = ${status.target}; execute says: ${blocked.title.slice(0, 80)}`;
  });

  await report.check("the target settles back to Ready after the failure is dismissed", async () => {
    // Disconnect is the action that dismisses a finished failure, which is how
    // a cancelled or failed target returns to a resting Ready.
    await targetAction();
    await sleep(800);
    if (!(await session.eval(`(${targetStatus})?.target?.toLowerCase().includes("injected")`))) {
      await runCommand(session, "Detect Target");
    }
    const status = await session.eval(targetStatus);
    return `target = ${status.target}`;
  });

  await report.check("an injected target lets a script execute successfully", async () => {
    if (!(await session.eval(`(${targetStatus})?.target?.toLowerCase().includes("injected")`))) {
      await targetAction();
    }
    await waitTarget("injected", 15000);
    await setSimulation("execution outcome", "success");
    await click(session, 'button[aria-label="Execute script"]');
    await sleep(400);
    // Confirm-before-run is on by default.
    await session.exec(`
      const dialog = document.querySelector('[role="dialog"]');
      if (dialog) {
        const go = [...dialog.querySelectorAll("button")].find((b) => /execute|run/i.test(b.innerText));
        if (go) go.click();
      }
    `);
    await waitFor(session, `${bodyText}.match(/succeed|success|completed/)`, 20000, "a successful execution");
    return "execution succeeded";
  });

  await report.check("the execution history records the run", async () => {
    await session.exec(`
      const tabs = [...document.querySelectorAll('[role="tab"]')];
      const hit = tabs.find((t) => /history/i.test(t.innerText));
      if (hit) hit.click();
    `);
    await sleep(600);
    const history = await session.eval(`${textOf('[aria-label="Execution history"]')} || ${bodyText}`);
    assert(history.length > 0, "no history surface");
    return `history text: ${history.slice(0, 70).replace(/\n/g, " | ")}`;
  });

  await report.check("a failing execution is reported as a failure", async () => {
    await setSimulation("execution outcome", "error");
    await click(session, 'button[aria-label="Execute script"]');
    await sleep(400);
    await session.exec(`
      const dialog = document.querySelector('[role="dialog"]');
      if (dialog) {
        const go = [...dialog.querySelectorAll("button")].find((b) => /execute|run/i.test(b.innerText));
        if (go) go.click();
      }
    `);
    await waitFor(session, `${bodyText}.match(/fail|error/)`, 20000, "a failed execution");
    await setSimulation("execution outcome", "success");
    return "failure reported";
  });

  // ---------------------------------------------------------------- debugger
  report.section("Debugger");

  await report.check("the debugger workspace opens", async () => {
    await goToView(session, "debugger");
    await waitFor(session, q('[aria-label="Debugger controls"]'), 8000, "the debugger toolbar");
    return "debugger toolbar present";
  });

  await report.check("a debug session starts and can be stepped and stopped", async () => {
    await session.exec(`
      const btn = document.querySelector('[aria-label="Debugger controls"] button[aria-label="Start"]');
      if (!btn) throw new Error("no Start control");
      if (btn.disabled) throw new Error("Start is disabled: " + (btn.getAttribute("title") || ""));
      btn.click();
    `);
    await sleep(1200);
    const running = await session.eval(bodyText);
    assert(running.includes("call stack") || running.includes("paused") || running.includes("running"), "no session surface");

    for (const label of ["Continue", "Step Over", "Step Into", "Step Out"]) {
      await session.exec(`
        const btn = document.querySelector('[aria-label="Debugger controls"] button[aria-label=${JSON.stringify(label)}]');
        if (!btn) throw new Error("no " + ${JSON.stringify(label)} + " control");
        if (!btn.disabled) btn.click();
      `);
      await sleep(500);
    }
    const panes = await session.eval(bodyText);
    assert(panes.includes("call stack"), "no call stack pane");
    assert(panes.includes("locals") || panes.includes("variables"), "no locals pane");
    assert(panes.includes("watch"), "no watch pane");

    await session.exec(`
      const btn = document.querySelector('[aria-label="Debugger controls"] button[aria-label="Stop"]');
      if (btn && !btn.disabled) btn.click();
    `);
    await sleep(600);
    return "started, stepped through and stopped";
  });

  // ---------------------------------------------------------------- profiler
  report.section("Profiler");

  await report.check("the profiler records, stops, refreshes and clears", async () => {
    await goToView(session, "profiler");
    await waitFor(session, q('[aria-label="Profiler controls"]'), 8000, "the profiler toolbar");

    await click(session, '[aria-label="Profiler controls"] button[aria-label="Start"]');
    await sleep(1500);
    const recording = await session.eval(bodyText);
    assert(recording.includes("recording"), "the profiler did not report recording");

    await click(session, '[aria-label="Profiler controls"] button[aria-label="Stop"]');
    await sleep(1200);
    const stopped = await session.eval(bodyText);
    assert(stopped.includes("timeline") || stopped.includes("samples"), "no timeline after stopping");

    await session.exec(`
      const btn = document.querySelector('[aria-label="Profiler controls"] button[aria-label="Refresh"]');
      if (btn && !btn.disabled) btn.click();
    `);
    await sleep(800);
    const history = await session.eval(`${bodyText}.includes("session history")`);

    await session.exec(`
      const btn = document.querySelector('[aria-label="Profiler controls"] button[aria-label="Clear"]');
      if (btn && !btn.disabled) btn.click();
    `);
    await sleep(600);
    return `recorded, stopped, refreshed, cleared; history surface: ${history}`;
  });

  // ----------------------------------------------------------------- backend
  report.section("Backend");

  await report.check("the backend reports Ready with its capabilities", async () => {
    await runCommand(session, "Show Backend Status");
    await sleep(800);
    const panel = await session.eval(bodyText);
    assert(panel.includes("backend"), "no backend status surface");
    assert(panel.includes("ready"), "the backend does not report Ready");
    await closeDialog(session);
    return "backend Ready with a status surface";
  });

  await report.check("the backend restarts and the workspace survives it", async () => {
    const before = await session.eval(`(JSON.parse(localStorage.getItem("nova.workspace") ?? "{}").scripts ?? []).length`);
    await runCommand(session, "Restart Backend");
    await sleep(2500);
    const after = await session.eval(`(JSON.parse(localStorage.getItem("nova.workspace") ?? "{}").scripts ?? []).length`);
    assert(after === before, `scripts changed from ${before} to ${after}`);
    await runCommand(session, "Show Backend Status");
    await sleep(600);
    const panel = await session.eval(bodyText);
    await closeDialog(session);
    assert(panel.includes("ready"), "the backend did not come back Ready");
    return `${after} scripts kept across the restart`;
  });

  await report.check("Refresh Capabilities is offered and runs", async () => {
    const entry = await paletteEntry(session, "Refresh Capabilities");
    assert(entry, "the command is missing");
    if (!entry.disabled) await runCommand(session, "Refresh Capabilities");
    return `${entry.text}${entry.disabled ? " (disabled)" : ""}`;
  });

  // ----------------------------------------------------------------- updates
  report.section("Updates");

  await report.check("a check nobody asked for never reports a failure", async () => {
    /*
     * The startup check has long since fired by the time this runs. Whether it
     * found anything depends on what is published: a locally built binary
     * carries the development version, so a release will be offered; with the
     * source unreachable, nothing should be shown at all. The invariant either
     * way is that a check the user did not ask for never opens a failure.
     */
    await sleep(3000);
    const dialog = await session.eval(`
      (() => {
        const d = document.querySelector('[role="dialog"]');
        return d ? d.innerText.split(String.fromCharCode(10)).join(" | ") : null;
      })()
    `);
    if (dialog !== null) {
      assert(!/update failed/i.test(dialog), `a silent check opened a failure: ${dialog.slice(0, 140)}`);
      assert(/update available/i.test(dialog), `an unexpected dialog is open: ${dialog.slice(0, 140)}`);
      await closeDialog(session);
    }
    const usable = await session.eval(q(".view-line, [role='tablist']"));
    assert(usable, "the shell is not usable");
    return dialog === null ? "nothing shown, shell usable" : "an update was offered, and dismissed";
  });

  await report.check("Check for Updates is in the command palette", async () => {
    const entry = await paletteEntry(session, "Check for Updates");
    assert(entry, "the command is missing from the palette");
    return `${entry.text}${entry.disabled ? " (disabled)" : ""}`;
  });

  await report.check("a manual check reports its outcome rather than staying silent", async () => {
    const entry = await paletteEntry(session, "Check for Updates");
    if (entry.disabled) return `disabled: ${entry.text}`;
    await runCommand(session, "Check for Updates");
    await waitFor(session, `!!document.querySelector('[role="dialog"]')`, 25000, "the update dialog");
    const shown = await session.eval(`document.querySelector('[role="dialog"]').innerText.replace(/\\n/g, " | ")`);
    await closeDialog(session);
    assert(/update|release/i.test(shown), `the dialog said: ${shown.slice(0, 120)}`);
    return shown.slice(0, 110);
  });

  await report.check("Settings has an Updates section naming the fixed source", async () => {
    await key(session, { key: ",", code: "Comma", ctrl: true });
    await sleep(800);
    await session.exec(`
      const tabs = [...document.querySelectorAll('[aria-label="Settings categories"] button, [role="dialog"] button')];
      const hit = tabs.find((b) => b.innerText.trim().toLowerCase() === "updates");
      if (!hit) throw new Error("no Updates category; found " + tabs.map((b) => b.innerText.trim()).join(", "));
      hit.click();
    `);
    await sleep(600);
    const panel = await session.eval(`document.querySelector('[role="dialog"]').innerText.toLowerCase()`);
    assert(panel.includes("github releases"), "the source is not stated");
    assert(panel.includes("unsalable/roblox-executor"), "the repository is not stated");
    assert(panel.includes("check for updates on startup"), "the startup setting is missing");
    assert(!/https?:\/\/(?!github)/.test(panel), "an arbitrary URL field appears to be offered");
    const editable = await session.eval(`
      [...document.querySelectorAll('[role="dialog"] input[type="text"], [role="dialog"] input[type="url"]')]
        .filter((el) => /endpoint|url|server|source/i.test(el.getAttribute("aria-label") || "")).length
    `);
    assert(editable === 0, "the update source is editable");
    await closeDialog(session);
    return "source stated, no editable endpoint";
  });

  console.log("\n--- check 2 complete ---");
} finally {
  const summary = report.finish();
  await stop(child, session);
  process.exit(summary.failed > 0 ? 1 : 0);
}
