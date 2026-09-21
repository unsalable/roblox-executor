import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { MAX_SOURCE_BYTES, PROTOCOL_VERSION } from "@/features/bridge/protocol";
import { DEFAULT_BRIDGE_PORT } from "@/types/settings";

/**
 * The bridge has three implementations of the same agreement: this frontend,
 * the Rust relay and the Studio plugin. Nothing at runtime can catch them
 * drifting apart — a mismatched protocol string would simply refuse every
 * connection — so the constants are compared here instead.
 */

const read = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(`../../../${relativePath}`, import.meta.url)), "utf8");

const rust = read("src-tauri/src/bridge/mod.rs");
const pluginProtocol = read("studio-plugin/src/Protocol.luau");
const pluginEntry = read("studio-plugin/src/init.server.luau");

function capture(source: string, pattern: RegExp, label: string): string {
  const match = pattern.exec(source);
  assert.ok(match?.[1] !== undefined, `could not find ${label}`);
  return match[1];
}

describe("bridge protocol parity", () => {
  test("all three sides agree on the protocol version", () => {
    assert.equal(capture(rust, /const PROTOCOL_VERSION: &str = "([^"]+)"/, "the Rust protocol version"), PROTOCOL_VERSION);
    assert.equal(capture(pluginProtocol, /Protocol\.VERSION = "([^"]+)"/, "the plugin protocol version"), PROTOCOL_VERSION);
  });

  test("all three sides agree on the source size limit", () => {
    const pluginLimit = capture(pluginProtocol, /Protocol\.MAX_SOURCE_BYTES = ([\d *]+)\n/, "the plugin source limit");
    assert.equal(eval(pluginLimit) as number, MAX_SOURCE_BYTES);

    // The relay's body cap has to leave room for the envelope around the source.
    const rustBody = capture(rust, /const MAX_BODY_BYTES: usize = ([\d *+]+);/, "the Rust body limit");
    assert.ok((eval(rustBody) as number) > MAX_SOURCE_BYTES, "the relay must accept a full-size source plus its envelope");
  });

  test("the plugin ships with the same default port as Nova", () => {
    assert.equal(Number(capture(pluginEntry, /local DEFAULT_PORT = (\d+)/, "the plugin default port")), DEFAULT_BRIDGE_PORT);
  });

  test("the relay and the plugin use the same routes and header", () => {
    for (const route of ["/nova/rpc", "/nova/poll", "/nova/info"]) {
      assert.ok(rust.includes(`"${route}"`), `the relay serves ${route}`);
    }
    const transport = read("studio-plugin/src/Transport.luau");
    for (const route of ["/nova/rpc", "/nova/poll", "/nova/info"]) {
      assert.ok(transport.includes(`"${route}"`), `the plugin calls ${route}`);
    }
    assert.ok(rust.includes('"x-nova-token"'), "the relay reads the session header");
    assert.ok(transport.includes('"X-Nova-Token"'), "the plugin sends the session header");
  });

  test("the plugin never contacts anything but loopback", () => {
    const transport = read("studio-plugin/src/Transport.luau");
    assert.match(transport, /host = "127\.0\.0\.1"/);
    const urls = transport.match(/https?:\/\/[^\s"']+/g) ?? [];
    for (const url of urls) {
      assert.match(url, /^http:\/\/%s:%d/, `unexpected URL in the plugin transport: ${url}`);
    }
  });

  test("the relay binds loopback and nothing else", () => {
    // Comments talk about 0.0.0.0 to explain why it is not used; the code must not.
    const code = rust
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

    assert.match(code, /TcpListener::bind\(\(Ipv4Addr::LOCALHOST, port\)\)/);
    assert.ok(!code.includes("0.0.0.0"), "the relay must never bind a public address");
    assert.ok(!code.includes("UNSPECIFIED"), "the relay must never bind a wildcard address");
  });
});
