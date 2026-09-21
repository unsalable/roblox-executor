// Check 4: the real backend — the Local Service.
//
// Everything the other checks drive runs on the Local Mock, whose providers are
// simulations. This one switches the shipped preference to the Local Service,
// which talks to a service in Nova's own Rust process over the application's
// IPC, and verifies the things only a real backend has: an authenticated
// session, a session that is replaced rather than reused on a restart, and
// tools it honestly reports as unsupported instead of simulating.
//
// It restores the Local Mock at the end, so the profile is left as it was.
import { start, stop, waitFor, sleep, createReport, assert } from "./harness.mjs";
import { bodyText, key, targetStatus, runCommand, closeDialog } from "./page.mjs";

const report = createReport("check 4: the Local Service backend");

/** Closes whatever dialog is open, and makes sure it actually closed. */
async function ensureClosed(session) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!(await session.eval(`!!document.querySelector('[role="dialog"]')`))) return;
    await closeDialog(session);
  }
  throw new Error("a dialog would not close");
}

/** Opens Settings on `category`. */
async function openSettings(session, category) {
  await ensureClosed(session);
  await key(session, { key: ",", code: "Comma", ctrl: true });
  await waitFor(session, `!!document.querySelector('[aria-label="Settings categories"]')`, 8000, "the Settings dialog");
  await session.exec(`
    const cats = [...document.querySelectorAll('[aria-label="Settings categories"] button')];
    const want = ${JSON.stringify(category.toLowerCase())};
    const hit = cats.find((b) => b.innerText.trim().toLowerCase() === want);
    if (!hit) throw new Error("no " + want + " category; found " + cats.map((b) => b.innerText.trim()).join(", "));
    hit.click();
  `);
  await sleep(600);
}

/** Chooses a developer backend and waits for the preference to be stored. */
async function chooseBackend(session, id) {
  await openSettings(session, "developer");
  await session.exec(`
    const select = document.querySelector('[role="dialog"] select[aria-label="Developer backend"]');
    if (!select) throw new Error("no backend picker; this build has only one backend");
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setter.call(select, ${JSON.stringify(id)});
    select.dispatchEvent(new Event("change", { bubbles: true }));
  `);
  await sleep(700);
  await ensureClosed(session);
  await waitFor(
    session,
    `JSON.parse(localStorage.getItem("nova.settings") ?? "{}").developer?.backendId === ${JSON.stringify(id)}`,
    5000,
    `the stored backend to become ${id}`,
  );
}

/** The developer status panel's text, with the dialog left closed. */
async function statusText(session) {
  await ensureClosed(session);
  await runCommand(session, "Show Backend Status");
  await waitFor(session, `!!document.querySelector('[role="dialog"]')`, 8000, "the diagnostics dialog");
  await sleep(400);
  const text = await session.eval(`(document.querySelector('[role="dialog"]')?.innerText ?? "").replace(/\\n/g, " | ")`);
  await ensureClosed(session);
  return text;
}

/** The session id the diagnostics report, or null. */
async function sessionId(session) {
  const text = await statusText(session);
  return /\b([0-9a-f]{32})\b/i.exec(text)?.[1] ?? null;
}

let firstSessionId = null;

try {
  // ------------------------------------------------- switch, then relaunch
  {
    const { child, session } = await start({ fresh: true });
    // A first launch creates the workspace, loads Monaco and starts the
    // backend; asking it anything before that settles just times out.
    await waitFor(session, `!!document.querySelector(".view-line")`, 25000, "Monaco");
    await sleep(2500);
    report.section("Choosing the real backend");

    await report.check("a fresh install starts on the Local Mock", async () => {
      const stored = await session.eval(`JSON.parse(localStorage.getItem("nova.settings") ?? "{}").developer?.backendId ?? "(default)"`);
      const text = await statusText(session);
      assert(/local mock/i.test(text), `the status panel said: ${text.slice(0, 160)}`);
      return `stored backendId = ${stored}; the panel names the Local Mock`;
    });

    await report.check("the Local Mock supports the debugger and the profiler", async () => {
      const text = await statusText(session);
      assert(/debug a script \| supported/i.test(text), `capabilities said: ${text.slice(0, 250)}`);
      assert(/record a profile \| supported/i.test(text), "the profiler is not reported as supported");
      return "both reported Supported, and both are marked Simulated";
    });

    await report.check("the backend picker offers the Local Service and stores the choice", async () => {
      await chooseBackend(session, "local-service");
      return "Settings › Developer now stores local-service";
    });

    await stop(child, session);
  }

  // ------------------------------------------------------- the real backend
  {
    const { child, session } = await start();
    await waitFor(session, `!!document.querySelector(".view-line")`, 25000, "Monaco");
    await sleep(2500);
    report.section("Running on the Local Service");

    await report.check("the real backend starts and reaches Ready", async () => {
      await waitFor(session, `${bodyText}.includes("local service")`, 15000, "the Local Service to be named");
      const text = await statusText(session);
      assert(/local service/i.test(text), `the panel said: ${text.slice(0, 160)}`);
      // The State row carries a screen-reader-only "Backend:" label between the
      // row's name and its value, so the value is one cell further along.
      assert(/state \|[^|]*\| ready/i.test(text), `the backend is not Ready: ${text.slice(0, 200)}`);
      return "backend Ready on the Local Service";
    });

    await report.check("its diagnostics report an authenticated session", async () => {
      const text = await statusText(session);
      // A session id is 16 bytes of OS randomness written as 32 hex characters.
      const id = /\b([0-9a-f]{32})\b/i.exec(text)?.[1] ?? null;
      assert(id !== null, `no session id in: ${text.slice(0, 300)}`);
      assert(/nova local service/i.test(text), "the service does not name itself");
      assert(/NOVA_LOCAL_SERVICE_V1/i.test(text), "the protocol version is not reported");
      firstSessionId = id;
      return `session ${id.slice(0, 8)}…, protocol NOVA_LOCAL_SERVICE_V1`;
    });

    await report.check("the token that authenticates the session is nowhere to be seen", async () => {
      // The session id is 32 hex characters and is shown on purpose; the token
      // is 32 bytes -- 64 hex characters -- and must appear nowhere at all.
      const text = await statusText(session);
      const ui = await session.eval(`document.body.innerText`);
      const storage = await session.eval(`Object.keys(localStorage).map((k) => localStorage.getItem(k)).join(" ")`);
      for (const [where, haystack] of [["the status panel", text], ["the UI", ui], ["local storage", storage]]) {
        const long = /\b[0-9a-f]{64,}\b/i.exec(haystack);
        assert(long === null, `a token-length string appears in ${where}: ${long?.[0]?.slice(0, 24)}…`);
        assert(!/sessionToken/i.test(haystack), `${where} names a session token value`);
      }
      return "no 64-hex string in the panel, the UI or local storage";
    });

    await report.check("the debugger and the profiler are reported unsupported, not simulated", async () => {
      const text = await statusText(session);
      assert(/debug a script \| not supported/i.test(text), `capabilities said: ${text.slice(0, 300)}`);
      assert(/record a profile \| not supported/i.test(text), "the profiler is not reported as unsupported");
      assert(/attach to a target \| supported/i.test(text), "the target is not reported as supported");
      return "debugger and profiler Not supported; target Supported";
    });

    await report.check("its target is real: it attaches without claiming to be a simulation", async () => {
      await waitFor(session, `(${targetStatus}) !== null`, 15000, "a target");
      const status = await session.eval(targetStatus);
      assert(!/local test target/i.test(status.session + status.target), "the simulated target is still in use");
      const simulated = await session.eval(`document.body.innerText.includes("SIM")`);
      assert(!simulated, "the target is still marked SIM");
      return `target = ${status.target}, provider is not marked simulated`;
    });

    await report.check("restarting the backend issues a new session and keeps the workspace", async () => {
      const before = firstSessionId;
      const scripts = await session.eval(`(JSON.parse(localStorage.getItem("nova.workspace") ?? "{}").scripts ?? []).length`);

      await runCommand(session, "Restart Backend");
      await sleep(3500);
      const after = await sessionId(session);
      assert(after !== null, "no session after the restart");
      assert(after !== before, `the session id did not change: ${after}`);

      const afterScripts = await session.eval(`(JSON.parse(localStorage.getItem("nova.workspace") ?? "{}").scripts ?? []).length`);
      assert(afterScripts === scripts, `scripts went from ${scripts} to ${afterScripts}`);
      return `session ${before.slice(0, 8)}… → ${after.slice(0, 8)}…, ${scripts} scripts untouched`;
    });

    await report.check("the health check keeps asking on its own", async () => {
      const first = await statusText(session);
      const firstCount = Number(/requests \| (\d+)/i.exec(first)?.[1] ?? -1);
      await sleep(7000);
      const second = await statusText(session);
      const secondCount = Number(/requests \| (\d+)/i.exec(second)?.[1] ?? -1);
      if (firstCount < 0 || secondCount < 0) return `no request counter shown; panel: ${second.slice(0, 160)}`;
      assert(secondCount > firstCount, `the request count stayed at ${firstCount}`);
      return `requests ${firstCount} → ${secondCount} with nobody touching the UI`;
    });

    await report.check("switching back to the Local Mock is stored", async () => {
      await chooseBackend(session, "local-mock");
      return "Settings › Developer stores local-mock again";
    });

    await stop(child, session);
  }

  // -------------------------------------------------- back on the simulation
  {
    const { child, session } = await start();
    await waitFor(session, `!!document.querySelector(".view-line")`, 25000, "Monaco");
    await sleep(2500);
    report.section("Back on the Local Mock");

    await report.check("the simulated backend is in force again, with its tools supported", async () => {
      const text = await statusText(session);
      assert(/local mock/i.test(text), `the panel said: ${text.slice(0, 160)}`);
      assert(/debug a script \| supported/i.test(text), "the debugger is not supported again");
      assert(/record a profile \| supported/i.test(text), "the profiler is not supported again");
      return "Local Mock, debugger and profiler Supported";
    });

    await report.check("no session from the real backend survived the switch", async () => {
      const storage = await session.eval(`Object.keys(localStorage).map((k) => localStorage.getItem(k)).join(" ")`);
      assert(!/\b[0-9a-f]{32,}\b/i.test(storage), "a session-shaped string was persisted");
      return "nothing session-shaped is stored";
    });

    await stop(child, session);
  }

  console.log("\n--- check 4 complete ---");
} finally {
  const summary = report.finish();
  process.exit(summary.failed > 0 ? 1 : 0);
}
