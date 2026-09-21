// Drives the built nova.exe over the WebView2 debugging port.
//
// The unit tests cover the pure logic; this covers the rest — that the release
// binary starts, that Monaco takes real keystrokes, that state survives a
// restart and that the page reaches nothing outside Nova. None of that can be
// asserted from a test runner, and a browser cannot stand in for it: WebView2
// is what the product actually runs on.
//
// Every run uses a fresh, isolated user-data folder under the system temp
// directory, so a verification run never touches the profile a real install
// keeps in %LOCALAPPDATA%\dev.nova.desktop.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

export const EXE = process.env.NOVA_EXE ?? join(root, "src-tauri", "target", "release", "nova.exe");
export const PORT = Number(process.env.NOVA_DEBUG_PORT ?? 9411);
export const PROFILE = join(tmpdir(), "nova-verify-profile");

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function freshProfile() {
  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });
}

export function launch() {
  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: PROFILE,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
    stdio: "ignore",
  });
  child.on("error", (error) => console.error(`could not launch ${EXE}: ${error.message}`));
  return child;
}

/** Waits for the page target to answer and returns its websocket URL. */
export async function waitForPage(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const page = (await response.json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // The port is not listening yet.
    }
    await sleep(300);
  }
  throw new Error(`the debugging port ${PORT} never answered; is ${EXE} built?`);
}

export class Session {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    /** Every CDP event seen, which is how the network scan gets its list. */
    this.events = [];
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method) {
        this.events.push(message);
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    });
  }

  /** Every URL the page requested since `Network.enable`. */
  requestedUrls() {
    return this.events
      .filter((event) => event.method === "Network.requestWillBeSent")
      .map((event) => event.params?.request?.url)
      .filter(Boolean);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
        }
      }, 30000);
    });
  }

  /**
   * Evaluates an EXPRESSION and returns its value.
   *
   * The parentheses sit exactly where they do on purpose: anything else gives
   * "JSON.stringify(...) is not a function" rather than the value.
   */
  async eval(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression: `JSON.stringify((() => (${expression}))())`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`eval failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    const value = result.result.value;
    return value === undefined ? undefined : JSON.parse(value);
  }

  /** Runs STATEMENTS, which an expression wrapper could not hold. */
  async exec(statements) {
    const result = await this.send("Runtime.evaluate", {
      expression: `(async () => { ${statements} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`exec failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // Already gone.
    }
  }
}

export async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("the debugging websocket failed")), { once: true });
  });
  const session = new Session(socket);
  await session.send("Runtime.enable");
  await session.send("Page.enable");
  return session;
}

/** Launches Nova, connects, and waits until the shell has painted. */
export async function start({ fresh = false } = {}) {
  if (fresh) freshProfile();
  const child = launch();
  const session = await connect(await waitForPage());
  await waitFor(session, `!!document.querySelector('[role="tablist"][aria-label="Open scripts"]')`, 25000, "the shell");
  return { child, session };
}

export async function stop(child, session) {
  session?.close();
  try {
    child.kill();
  } catch {
    // Already gone.
  }
  // WebView2 needs a moment to release the profile folder before the next launch.
  await sleep(1200);
}

export async function waitFor(session, expression, timeoutMs = 10000, what = expression) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await session.eval(expression);
      if (last) return last;
    } catch (error) {
      last = `threw: ${error.message}`;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

export function createReport(title) {
  const results = [];
  return {
    async check(name, run) {
      try {
        const detail = await run();
        results.push({ name, ok: true });
        console.log(`  PASS  ${name}${detail ? ` -- ${detail}` : ""}`);
      } catch (error) {
        results.push({ name, ok: false, detail: error.message });
        console.log(`  FAIL  ${name} -- ${error.message}`);
      }
    },
    section(name) {
      console.log(`\n== ${name}`);
    },
    finish() {
      const failed = results.filter((result) => !result.ok);
      console.log(`\n${title}: ${results.length - failed.length}/${results.length} checks passed`);
      for (const failure of failed) console.log(`  - ${failure.name}: ${failure.detail}`);
      return { total: results.length, failed: failed.length };
    },
  };
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}
