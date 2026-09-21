import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import {
  LOCAL_SERVICE_CAPABILITY_TARGET,
  LOCAL_SERVICE_MAX_MESSAGE_BYTES,
  LOCAL_SERVICE_OPS,
  LOCAL_SERVICE_PROTOCOL_VERSION,
  LOCAL_SERVICE_WIRE_ERROR_CODES,
} from "@/features/backend/backends/localService/protocol";
import { LOCAL_SERVICE_COMMAND } from "@/lib/tauri";

/**
 * The local service protocol has two implementations of one agreement: this
 * frontend and the Rust service. Nothing at runtime can catch them drifting
 * apart — a mismatched version string would simply refuse every request, and a
 * code one side never sends is a branch the other side can never reach — so the
 * constants are compared here instead, by reading the Rust source.
 *
 * This is the same mechanism the parked Studio bridge used across its three
 * implementations, kept because it is the only thing that makes "both sides
 * agree" a checked claim rather than a comment.
 */

const read = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../../${relativePath}`, import.meta.url)), "utf8");

const rustProtocol = read("src-tauri/src/local_service/protocol.rs");
const rustService = read("src-tauri/src/local_service/mod.rs");
const rustCommands = read("src-tauri/src/commands.rs");
const rustLib = read("src-tauri/src/lib.rs");
const rustMain = read("src-tauri/src/main.rs");
const rustBuild = read("src-tauri/build.rs");

function capture(source: string, pattern: RegExp, label: string): string {
  const match = pattern.exec(source);
  assert.ok(match?.[1] !== undefined, `could not find ${label}`);
  return match[1];
}

/** The Rust source with its line comments removed, for the "it must not be there" checks. */
const withoutComments = (source: string) =>
  source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

describe("local service protocol parity", () => {
  test("both sides agree on the protocol version", () => {
    assert.equal(
      capture(rustProtocol, /pub const PROTOCOL_VERSION: &str = "([^"]+)"/, "the Rust protocol version"),
      LOCAL_SERVICE_PROTOCOL_VERSION,
    );
  });

  test("both sides agree on the message size limit", () => {
    const rustLimit = capture(
      rustProtocol,
      /pub const MAX_MESSAGE_BYTES: usize = ([\d _*+]+);/,
      "the Rust message limit",
    );
    assert.equal(Number(eval(rustLimit)), LOCAL_SERVICE_MAX_MESSAGE_BYTES);
  });

  test("both sides agree on the operations, exactly", () => {
    const list = capture(rustProtocol, /pub const OPERATIONS: \[&str; \d+\] = \[([^\]]+)\]/, "the Rust operations");
    const rustOps = [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(rustOps, [...LOCAL_SERVICE_OPS]);
  });

  test("both sides agree on the capability a handshake may require", () => {
    assert.equal(
      capture(rustProtocol, /pub const CAPABILITY_TARGET: &str = "([^"]+)"/, "the Rust capability name"),
      LOCAL_SERVICE_CAPABILITY_TARGET,
    );
  });

  test("every refusal the service can send is one the frontend knows", () => {
    const rustCodes = [...rustProtocol.matchAll(/Self::\w+ => "([A-Z_]+)"/g)].map((match) => match[1]);
    assert.ok(rustCodes.length > 0, "the Rust error mapping was not found");
    assert.deepEqual([...rustCodes].sort(), [...LOCAL_SERVICE_WIRE_ERROR_CODES].sort());
  });

  test("the frontend calls the command the application registers", () => {
    assert.ok(
      new RegExp(`pub fn ${LOCAL_SERVICE_COMMAND}\\b`).test(rustCommands),
      `the Rust side must define ${LOCAL_SERVICE_COMMAND}`,
    );
    assert.ok(
      rustLib.includes(`commands::${LOCAL_SERVICE_COMMAND}`),
      `${LOCAL_SERVICE_COMMAND} must be registered in the invoke handler`,
    );
  });
});

describe("what the local service is not allowed to become", () => {
  /**
   * The strongest available guarantee, and the reason it is worth a test: Rust
   * cannot reach a Win32 API, load a library or touch another process without
   * `unsafe` or an `extern` declaration. Their absence is not evidence that the
   * service behaves — it is proof that it *cannot* do any of it.
   */
  test("the service contains no unsafe code and no foreign function interface", () => {
    // Every Rust file that is compiled, including the ones that are three lines
    // long: a file nobody reads is exactly where an `unsafe` block would be
    // least likely to be noticed.
    for (const [name, source] of [
      ["the protocol", rustProtocol],
      ["the service", rustService],
      ["the commands", rustCommands],
      ["the builder", rustLib],
      ["the entry point", rustMain],
      ["the build script", rustBuild],
    ] as const) {
      const code = withoutComments(source);
      assert.ok(!/\bunsafe\b/.test(code), `${name} must contain no unsafe block`);
      assert.ok(!/\bextern\b/.test(code), `${name} must declare no foreign function`);
      assert.ok(!/#\[link\b/.test(code), `${name} must link no native library`);
    }
  });

  test("the application opens no socket and binds no address", () => {
    // Every compiled file, not just the service's two: a listener added to the
    // builder or the entry point would be just as much of a listener.
    const code = [rustService, rustProtocol, rustCommands, rustLib, rustMain, rustBuild].map(withoutComments).join("\n");
    for (const forbidden of ["TcpListener", "UdpSocket", "SocketAddr", "0.0.0.0", "bind(", "::listen", "127.0.0.1"]) {
      assert.ok(!code.includes(forbidden), `Nova's Rust must never mention ${forbidden}`);
    }
  });

  test("the service starts no process and runs no command", () => {
    const code = withoutComments(rustService) + withoutComments(rustCommands) + withoutComments(rustLib);
    for (const forbidden of ["std::process", "Command::new", "Stdio", "dlopen", "LoadLibrary"]) {
      assert.ok(!code.includes(forbidden), `the local service must never mention ${forbidden}`);
    }
  });

  /**
   * `main.rs` is excluded from the check above because it legitimately calls
   * `std::process::exit` to report a failed start — so it gets its own check,
   * which allows exactly that one call and nothing else. Without this the
   * shortest file in the project would be the only unwatched one.
   */
  test("the entry point does nothing but start Nova and exit", () => {
    const code = withoutComments(rustMain);
    for (const forbidden of ["Command::new", "Stdio", "dlopen", "LoadLibrary", "OpenProcess", "std::fs"]) {
      assert.ok(!code.includes(forbidden), `the entry point must never mention ${forbidden}`);
    }
    for (const use of code.match(/std::process::\w+/g) ?? []) {
      assert.equal(use, "std::process::exit", "the entry point may only exit");
    }
  });

  /**
   * The Win32 calls a tool like this one is assumed to make. Rust cannot reach
   * any of them without `unsafe` or `extern`, which the first test already
   * forbids, but they are named here so the guarantee is legible to someone
   * reading the tests rather than only implied by the absence of a keyword.
   */
  test("nothing in the application names a process, memory or injection API", () => {
    const code = [rustService, rustProtocol, rustCommands, rustLib, rustMain, rustBuild].map(withoutComments).join("\n");
    for (const forbidden of [
      "OpenProcess",
      "ReadProcessMemory",
      "WriteProcessMemory",
      "VirtualAlloc",
      "VirtualProtect",
      "CreateRemoteThread",
      "NtCreateThreadEx",
      "QueueUserAPC",
      "EnumProcesses",
      "CreateToolhelp32Snapshot",
      "Process32First",
      "GetModuleHandle",
      "GetProcAddress",
      "SetWindowsHookEx",
      "WriteFileEx",
      "sysinfo",
      "winapi",
      "windows_sys",
    ]) {
      assert.ok(!code.includes(forbidden), `Nova's Rust must never mention ${forbidden}`);
    }
  });

  test("the service writes nothing to disk", () => {
    const code = withoutComments(rustService) + withoutComments(rustCommands) + withoutComments(rustLib);
    for (const forbidden of ["std::fs", "File::create", "OpenOptions", "write_all"]) {
      assert.ok(!code.includes(forbidden), `the local service must never mention ${forbidden}`);
    }
  });

  test("the application grants itself exactly the capabilities it needs", () => {
    const capabilities = read("src-tauri/capabilities/default.json");
    const granted = (JSON.parse(capabilities) as { permissions: string[] }).permissions;

    /**
     * An exact list rather than a pattern. A pattern has to be widened every
     * time a permission is added, and widening it is precisely the change this
     * test exists to catch; an exact list makes every addition a deliberate
     * edit to this file with a reason written beside it.
     *
     * The description in the capability file says the same thing in prose; only
     * the list is checked, because only the list is what Tauri acts on.
     */
    assert.deepEqual(
      [...granted].sort(),
      [
        "core:app:default",
        "core:event:default",
        "core:webview:default",
        "core:window:allow-close",
        "core:window:allow-minimize",
        "core:window:allow-start-dragging",
        "core:window:allow-toggle-maximize",
        "core:window:default",
        // Restarts Nova into an update it has already installed. It cannot
        // start, inspect or end any other process.
        "process:allow-restart",
        // Checks for, downloads and verifies that update. The endpoint and the
        // public key it verifies against are pinned below.
        "updater:default",
      ],
      "the capability set changed; every entry here is deliberate",
    );

    const listed = granted.join(" ");
    for (const forbidden of ["shell", "fs:", "http:", "process:default", "process:allow-exit", "dialog", "os:"]) {
      assert.ok(!listed.includes(forbidden), `the capability set must never grant ${forbidden}`);
    }
  });

  /**
   * The updater is the only thing in Nova that reaches the network, so where it
   * reaches and what it trusts are pinned here rather than left to a config
   * file nobody reads. A build that points somewhere else, or that would accept
   * an artifact without checking a signature, fails before it is released.
   */
  test("the updater has one fixed source and verifies what it downloads", () => {
    const config = JSON.parse(read("src-tauri/tauri.conf.json")) as {
      plugins?: { updater?: { endpoints?: string[]; pubkey?: string } };
      bundle?: { createUpdaterArtifacts?: boolean };
    };
    const updater = config.plugins?.updater;

    assert.ok(updater, "the updater must be configured in the application, not at runtime");
    assert.deepEqual(
      updater.endpoints,
      ["https://github.com/unsalable/roblox-executor/releases/latest/download/latest.json"],
      "exactly one endpoint, and it is Nova's own release source",
    );
    for (const endpoint of updater.endpoints ?? []) {
      assert.ok(endpoint.startsWith("https://github.com/"), `${endpoint} is not Nova's release source`);
    }

    assert.ok(
      typeof updater.pubkey === "string" && updater.pubkey.length > 0,
      "without a public key the updater would install whatever it was handed",
    );
    // A minisign public key, base64 of a block beginning "untrusted comment:".
    assert.match(
      Buffer.from(updater.pubkey!, "base64").toString("utf8"),
      /^untrusted comment: minisign public key/,
      "the pinned key must be a minisign public key",
    );
    // It is the *public* half: a private key block would be a leaked secret.
    assert.ok(
      !Buffer.from(updater.pubkey!, "base64").toString("utf8").includes("secret key"),
      "a private signing key must never appear in the application configuration",
    );

    assert.equal(
      config.bundle?.createUpdaterArtifacts,
      true,
      "without updater artifacts a release has nothing signed for the updater to install",
    );
  });

  /**
   * The updater fetches from Rust, not from the page, so reaching GitHub must
   * not have required opening the webview's network policy. This is what proves
   * the update path did not become a hole the rest of the frontend can use.
   */
  test("adding the updater did not let the page reach the network", () => {
    const { csp } = (JSON.parse(read("src-tauri/tauri.conf.json")) as {
      app: { security: { csp: string } };
    }).app.security;

    assert.ok(!csp.includes("github.com"), "the page must not be allowed to reach the release source");
    assert.ok(!/https:\/\/(?!$)/.test(csp.replace("http://asset.localhost", "").replace("http://ipc.localhost", "")));
  });

  /**
   * Every directive, not just the one the local service uses. A backend that
   * reaches a service over IPC is exactly the change that could have been made
   * to work by loosening `script-src` or `default-src` instead, so the whole
   * policy is pinned rather than the one line this feature touches.
   */
  test("the content security policy is unchanged, in every directive", () => {
    const config = read("src-tauri/tauri.conf.json");
    const { csp, devCsp } = (JSON.parse(config) as { app: { security: { csp: string; devCsp: string } } }).app.security;

    const directives = (policy: string) =>
      new Map(
        policy
          .split(";")
          .map((part) => part.trim())
          .filter((part) => part !== "")
          .map((part) => {
            const [name, ...sources] = part.split(/\s+/);
            return [name as string, sources];
          }),
      );

    const release = directives(csp);
    assert.deepEqual(release.get("default-src"), ["'self'"]);
    assert.deepEqual(release.get("script-src"), ["'self'"], "no 'unsafe-eval', no 'unsafe-inline', no host");
    assert.deepEqual(release.get("connect-src"), ["'self'", "ipc:", "http://ipc.localhost"]);
    assert.deepEqual(release.get("font-src"), ["'self'", "data:"]);
    // Neither of these falls back to default-src, so both are stated: nothing
    // may retarget relative URLs, and nothing may submit a form anywhere.
    assert.deepEqual(release.get("base-uri"), ["'self'"]);
    assert.deepEqual(release.get("form-action"), ["'none'"]);
    assert.deepEqual([...release.keys()].sort(), [
      "base-uri",
      "connect-src",
      "default-src",
      "font-src",
      "form-action",
      "img-src",
      "script-src",
      "style-src",
    ]);

    // The dev policy may relax script-src and reach the Vite dev server; it may
    // not reach anything else, and it is never what a release runs on.
    const development = directives(devCsp);
    assert.deepEqual([...development.keys()].sort(), [...release.keys()].sort());
    for (const [name, sources] of [...release, ...development]) {
      for (const source of sources) {
        assert.ok(
          /^'(self|unsafe-inline|none)'$|^(data|asset|ipc):$|^https?:\/\/(asset|ipc)\.localhost$|^wss?:\/\/localhost:1420$|^https?:\/\/localhost:1420$/.test(
            source,
          ),
          `${name} must not allow ${source}`,
        );
      }
    }
  });
});
