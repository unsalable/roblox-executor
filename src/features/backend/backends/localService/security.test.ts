import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { createBackendController, type BackendLog } from "@/features/backend/backendController";
import { createLocalServiceDeveloperBackend } from "@/features/backend/backends/LocalServiceDeveloperBackend";
import { createFakeLocalService } from "@/features/backend/testing/fakeLocalService";
import { createTargetController } from "@/features/target/targetController";
import type { TargetProvider } from "@/features/target/types";
import { defaultSettings } from "@/types/settings";
import { normalizeSettings } from "@/lib/storage";
import { createFakeClock } from "@/lib/testing/fakeClock";

/**
 * The local service's security boundary, as tests rather than as comments.
 *
 * Two halves. The first walks the shipped source tree and asserts that the
 * capabilities Nova has never had are still absent — a real local backend is
 * exactly the change that could have introduced one, so the absence is checked
 * rather than assumed. The second drives the backend and asserts that the one
 * secret in the application, the local service's session token, reaches no log line, no
 * diagnostic and no persisted value.
 *
 * The scan covers what ships: `src/`, `src-tauri/src/`, `scripts/`,
 * `index.html` and `package.json`. Two things are deliberately out of scope,
 * and both are checked below to be genuinely unreachable from the application:
 * `experimental/`, a parked archive that nothing compiles, bundles, type checks
 * or loads, and `scripts/verify-release/`, which drives the *built* binary from
 * outside it — it launches the executable and talks to a debugging port, which
 * is exactly what this sweep forbids the application itself from doing.
 */

const root = new URL("../../../../../", import.meta.url);
const path = (relative: string) => fileURLToPath(new URL(relative, root));

const SCANNED_DIRECTORIES = ["src", "src-tauri/src", "scripts"];
// The manifests are scanned too: a capability Nova must not have would arrive
// as a dependency or a Tauri permission long before it arrived as a call.
const SCANNED_FILES = [
  "index.html",
  "package.json",
  "src-tauri/Cargo.toml",
  "src-tauri/tauri.conf.json",
  "src-tauri/capabilities/default.json",
];
const SCANNED_EXTENSIONS = [".ts", ".tsx", ".rs", ".mjs", ".js", ".html", ".json"];

function walk(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const full = `${directory}/${entry}`;
    if (statSync(full).isDirectory()) {
      walk(full, found);
      continue;
    }
    if (!SCANNED_EXTENSIONS.some((extension) => entry.endsWith(extension))) continue;
    found.push(full);
  }
  return found;
}

const sources = (): { file: string; text: string }[] => [
  ...SCANNED_DIRECTORIES.flatMap((directory) => walk(path(directory))),
  ...SCANNED_FILES.map((file) => path(file)),
].map((file) => ({ file: file.slice(fileURLToPath(root).length).replaceAll("\\", "/"), text: readFileSync(file, "utf8") }));

/**
 * What can reach the running application.
 *
 * A `*.test.ts` file is excluded from the forbidden-API sweep for one reason:
 * these very tests name those APIs
 * in the assertions that prove they are absent. Naming one in an assertion is
 * the opposite of using it, and no test file is bundled — `tsconfig.json` type
 * checks them, Vite builds from `src/main.tsx`, and Cargo compiles them out of
 * a release build. The files that *do* ship are swept in full.
 */
const shipped = () =>
  sources().filter(({ file }) => !file.endsWith(".test.ts") && !file.startsWith(VERIFICATION_HARNESS));

/**
 * The release verification harness. It is a tool, not part of the product: it
 * starts the built executable and drives it over WebView2's debugging port, so
 * it necessarily spawns a process and opens a socket. Excluding it from the
 * sweep is safe only because nothing in the application can reach it, which is
 * asserted below rather than assumed.
 */
const VERIFICATION_HARNESS = "scripts/verify-release/";

/**
 * Case-sensitive on purpose: these are the exact symbol names, and a
 * case-insensitive sweep would flag the Rust test that proves an operation
 * named after one of them is refused.
 */
const FORBIDDEN: { pattern: RegExp; what: string }[] = [
  { pattern: /\bOpenProcess\b/, what: "opening a process handle" },
  { pattern: /\bReadProcessMemory\b/, what: "reading another process's memory" },
  { pattern: /\bWriteProcessMemory\b/, what: "writing another process's memory" },
  { pattern: /\bVirtualAllocEx\b|\bVirtualProtectEx\b/, what: "allocating or protecting memory elsewhere" },
  { pattern: /\bCreateRemoteThread\b/, what: "starting a thread in another process" },
  { pattern: /\bLoadLibrary(?:A|W|ExA|ExW)?\b|\bGetProcAddress\b|\bdlopen\b/, what: "loading a library" },
  { pattern: /\bEnumProcesses\b|\bCreateToolhelp32Snapshot\b|\bProcess32(?:First|Next)\b/, what: "enumerating processes" },
  { pattern: /\bNtQuerySystemInformation\b|\bZwQuery/, what: "querying the system for processes" },
  { pattern: /\bchild_process\b|\bexecSync\b|\bspawnSync\b/, what: "running a command" },
  { pattern: /\bstd::process::Command\b|\bCommand::new\b/, what: "running a command" },
  { pattern: /\bpowershell\b|\bcmd\.exe\b|\brundll32\b|\bregsvr32\b/, what: "invoking a shell or loader" },
  { pattern: /\bTcpListener\b|\bUdpSocket\b|\bInAddr_?Any\b|\b0\.0\.0\.0\b/, what: "listening on a network address" },
  { pattern: /\bXMLHttpRequest\b|\bnew WebSocket\b|\bsendBeacon\b/, what: "reaching the network" },
  { pattern: /\bHKEY_[A-Z_]+\b|\bwinreg\b|\bRegSetValue\b|\bschtasks\b/, what: "installing persistence" },
  { pattern: /\bnew Function\s*\(/, what: "compiling code at runtime" },
];

describe("what the shipped source tree still does not contain", () => {
  test("no process, memory, injection, shell, persistence or listener capability exists anywhere", () => {
    const hits: string[] = [];
    for (const { file, text } of shipped()) {
      for (const { pattern, what } of FORBIDDEN) {
        const match = pattern.exec(text);
        if (match !== null) hits.push(`${file}: ${match[0]} — ${what}`);
      }
    }
    assert.deepEqual(hits, [], `the local service must add no capability to reach outside Nova:\n${hits.join("\n")}`);
  });

  /**
   * The one exclusion from the sweep above, justified rather than asserted by
   * comment. The verification harness drives the built binary from outside it,
   * so it does the very things the application must never do; that is only safe
   * while nothing in the application can reach it.
   */
  test("the release verification harness cannot be reached from the application", () => {
    // `shipped()` already drops the harness and the test files, which are the
    // only two things allowed to name it.
    const reachable = shipped().filter(({ file, text }) => file !== "package.json" && /verify-release/.test(text));
    assert.deepEqual(
      reachable.map(({ file }) => file),
      [],
      "nothing the application compiles, bundles or loads may reference the harness",
    );

    // Nor is it in any build input: TypeScript checks `src` only, and Vite
    // bundles from the entry `index.html` names.
    const tsconfig = JSON.parse(readFileSync(path("tsconfig.json"), "utf8")) as { include: string[] };
    assert.deepEqual(tsconfig.include, ["src", "vite.config.ts"], "tsconfig must not reach into scripts/");
    assert.ok(!readFileSync(path("index.html"), "utf8").includes("scripts/"), "index.html must load nothing from scripts/");

    // package.json may name it -- that is the command that runs it -- but only
    // as a script, never as an application dependency or a build step.
    const manifest = JSON.parse(readFileSync(path("package.json"), "utf8")) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
    };
    const referencing = Object.entries(manifest.scripts)
      .filter(([, command]) => command.includes("verify-release"))
      .map(([name]) => name);
    assert.deepEqual(referencing, ["verify:release"], "only the verification command may run the harness");
    assert.ok(!manifest.dependencies["verify-release"], "the harness is not a dependency");
    for (const stage of ["build", "build:web", "dev"]) {
      assert.ok(
        !manifest.scripts[stage]?.includes("verify-release"),
        `the harness must not be part of ${stage}`,
      );
    }
  });

  test("nothing calls out to a URL, and the only IPC call site is the one bridge module", () => {
    const network: string[] = [];
    const invokers: string[] = [];
    for (const { file, text } of shipped()) {
      if (file.endsWith(".json")) continue;
      // `fetchAppInfo` and friends are Nova's own names; a call to the global is not.
      if (/[^.\w]fetch\s*\(/.test(text)) network.push(file);
      if (/\binvoke\s*</.test(text) || /[^.\w]invoke\s*\(/.test(text)) invokers.push(file);
    }
    assert.deepEqual(network, [], "nothing in Nova fetches a URL");
    assert.deepEqual(invokers, ["src/lib/tauri.ts"], "every IPC call goes through the one bridge module");
  });

  /**
   * The two places a secret must never reach: a view, which renders what it is
   * given, and the persistence model, which writes what it is given to disk.
   *
   * Only a token *value* is looked for — a property read, written or declared —
   * because prose about tokens is not one. (Nova has another, unrelated meaning
   * for the word: `features/editor` colours Monaco's syntax tokens.)
   */
  test("no view and nothing persisted can so much as name a token value", () => {
    const readers: string[] = [];
    for (const { file, text } of shipped()) {
      const persistence = file === "src/lib/storage.ts" || file === "src/types/settings.ts";
      if (!file.endsWith(".tsx") && !persistence) continue;
      if (/\.token\b|\btoken\s*:|\btoken\s*=/.test(text)) readers.push(file);
    }
    assert.deepEqual(readers, [], "a session token must reach no view and nothing that is written to disk");
  });
});

describe("the session token reaches nothing that can show it", () => {
  const silent = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

  function recordingLog(): BackendLog & { text: () => string } {
    const lines: string[] = [];
    const at = (level: string) => (message: string, data?: unknown) => {
      lines.push(`${level} ${message} ${String(data ?? "")}`);
    };
    return {
      text: () => lines.join("\n"),
      debug: at("debug"),
      info: at("info"),
      warn: at("warn"),
      error: at("error"),
    };
  }

  test("nothing the backend logs, reports or diagnoses contains the token", async () => {
    const clock = createFakeClock();
    const service = createFakeLocalService();
    const log = recordingLog();
    const targetLog = recordingLog();
    let nextId = 0;

    const backend = createLocalServiceDeveloperBackend({
      transport: service.transport,
      clock,
      createId: () => `request-${++nextId}`,
      policy: () => ({ healthCheckIntervalMs: 500 }),
    });
    const controller = createBackendController({ backend, clock, log });
    const target = createTargetController({
      provider: backend.providers.target as TargetProvider,
      clock,
      policy: () => ({ autoDetect: true, autoInject: false, autoReconnect: false, injectTimeoutMs: 1000 }),
      log: targetLog,
    });

    const submission = controller.start();
    assert.ok(submission.accepted);
    await clock.advance(50);
    await submission.settled;
    await target.detect();
    await clock.advance(50);
    const injecting = target.inject();
    assert.ok(injecting.accepted);
    await clock.advance(50);
    await injecting.result;
    await clock.advance(1500);

    const token = service.currentToken();
    assert.ok(token !== null && token.length > 0, "the service did issue one");

    const everything = [
      log.text(),
      targetLog.text(),
      JSON.stringify(controller.getSnapshot()),
      JSON.stringify(target.getSnapshot()),
      JSON.stringify(backend.session.getInfo()),
      JSON.stringify(backend.session.getStats()),
      JSON.stringify(backend.getDiagnostics?.() ?? []),
      JSON.stringify(backend.providers.target?.getDiagnostics()),
    ].join("\n");

    assert.ok(!everything.includes(token), "the session token must reach nothing that can be read or shown");
    // The same sweep the console test runs, extended for a token shape:
    // a long unbroken run of hex or base64url is what a secret looks like.
    for (const forbidden of [/\bpid\b/i, /0x[0-9a-f]{4,}/i, /\.exe\b/i, /ReadProcessMemory/i, /[A-Fa-f0-9]{24,}/]) {
      assert.ok(!forbidden.test(log.text()), `a diagnostic must not contain ${forbidden}`);
      assert.ok(!forbidden.test(targetLog.text()), `a diagnostic must not contain ${forbidden}`);
    }

    target.dispose();
    controller.dispose();
  });

  /**
   * The requirement is "a backend restart cannot modify workspace or
   * editor state", and the mechanism that guarantees it is structural rather
   * than behavioural: the backend hands its providers over once, the
   * composition root builds the controllers on them once, and a restart changes
   * whether those providers may be *used* — never which objects they are. So
   * that is what is asserted. Nothing above the providers is rebuilt, which is
   * why the editor, the open scripts and the breakpoints are untouched.
   */
  test("a restart replaces the session and nothing above it", async () => {
    const clock = createFakeClock();
    const service = createFakeLocalService();
    let nextId = 0;
    const backend = createLocalServiceDeveloperBackend({
      transport: service.transport,
      clock,
      createId: () => `request-${++nextId}`,
      policy: () => ({ healthCheckIntervalMs: 1000 }),
    });
    const controller = createBackendController({ backend, clock, log: silent });

    const providersBefore = backend.providers;
    const targetBefore = backend.providers.target;

    const submission = controller.start();
    assert.ok(submission.accepted);
    await clock.advance(50);
    await submission.settled;
    const sessionBefore = service.currentSessionId();

    const restarting = controller.restart();
    await clock.advance(50);
    await restarting;
    await clock.advance(50);

    assert.equal(controller.getSnapshot().state, "ready");
    assert.notEqual(service.currentSessionId(), sessionBefore, "the session is what a restart replaces");
    assert.equal(backend.providers, providersBefore, "the provider set is the same object");
    assert.equal(backend.providers.target, targetBefore, "the target provider is the same object");

    controller.dispose();
  });

  test("nothing the backend can reach knows how to write to disk", () => {
    const owned = shipped().filter(
      ({ file }) =>
        file.startsWith("src/features/backend/backends/localService/") ||
        file === "src/features/backend/backends/LocalServiceDeveloperBackend.ts" ||
        file.startsWith("src-tauri/src/local_service/"),
    );
    assert.ok(owned.length >= 6, `expected the local service modules, found ${owned.length}`);
    for (const { file, text } of owned) {
      for (const forbidden of ["lib/storage", "localStorage", "scripts/persistence", "debugger/persistence"]) {
        assert.ok(!text.includes(forbidden), `${file} must not be able to reach ${forbidden}`);
      }
    }
  });

  test("the settings model has nowhere to keep a session, so nothing can persist one", () => {
    assert.deepEqual(Object.keys(defaultSettings.developer).sort(), [
      "autoStartBackend",
      "backendId",
      "backendStartupTimeoutMs",
      "healthCheckIntervalMs",
    ]);

    // Even if something wrote one, it could not be read back: unknown keys are
    // dropped rather than merged.
    const normalized = normalizeSettings({
      developer: { backendId: "local-service", token: "token-1", sessionId: "session-1" },
    });
    assert.equal(JSON.stringify(normalized).includes("token-1"), false);
    assert.equal(JSON.stringify(normalized).includes("session-1"), false);
  });
});
