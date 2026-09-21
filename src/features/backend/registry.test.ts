import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  LOCAL_MOCK_BACKEND_DESCRIPTOR,
  LOCAL_MOCK_BACKEND_ID,
} from "@/features/backend/backends/LocalMockDeveloperBackend";
import { LOCAL_SERVICE_BACKEND_ID } from "@/features/backend/backends/LocalServiceDeveloperBackend";
import { backendRegistry } from "@/features/backend/backends/registry";
import { createBackendRegistry, type BackendRegistration } from "@/features/backend/registry";
import type { BackendDescriptor, DeveloperBackend } from "@/features/backend/types";
import { DEFAULT_BACKEND_ID } from "@/types/settings";

/**
 * The registry is a lookup table and nothing more: it holds no instance and no
 * state, so it can be built and questioned without composing a backend. Only
 * `create` would do that, and these tests count how often it is called rather
 * than using what it returns.
 */

const descriptor = (id: string, label: string): BackendDescriptor =>
  Object.freeze({ id, label, simulated: true, description: `${label} for the registry tests.` });

function registration(id: string, label = id): BackendRegistration & { created: () => number } {
  let created = 0;
  return {
    descriptor: descriptor(id, label),
    create: () => {
      created += 1;
      return {} as DeveloperBackend;
    },
    created: () => created,
  };
}

describe("the developer backend registry", () => {
  test("the first registration is the default", () => {
    const registry = createBackendRegistry([registration("first"), registration("second")]);
    assert.equal(registry.defaultId, "first");
    assert.deepEqual(
      registry.descriptors.map((entry) => entry.id),
      ["first", "second"],
    );
  });

  test("a registry with no backends is a programming error, not an empty one", () => {
    assert.throws(() => createBackendRegistry([]), /at least one backend/);
  });

  test("two backends may not share an id", () => {
    assert.throws(() => createBackendRegistry([registration("same"), registration("same", "Other")]), /unique/);
  });

  test("looking a backend up never composes it", () => {
    const first = registration("first");
    const registry = createBackendRegistry([first]);
    assert.ok(registry.get("first") !== null);
    assert.equal(registry.get("first")?.descriptor.label, "first");
    assert.equal(registry.get("missing"), null);
    assert.equal(first.created(), 0, "a lookup must not build a backend");
  });

  test("a stored preference resolves to the backend it names", () => {
    const registry = createBackendRegistry([registration("first"), registration("second")]);
    const resolution = registry.resolve("second");
    assert.equal(resolution.status, "resolved");
    assert.equal(resolution.registration.descriptor.id, "second");
  });

  test("an id this build does not know falls back to the default and says which id was asked for", () => {
    const registry = createBackendRegistry([registration("first")]);
    const resolution = registry.resolve("a-backend-from-a-later-build");
    assert.equal(resolution.status, "fallback", "Nova is never left without a backend");
    assert.equal(resolution.registration.descriptor.id, "first");
    assert.equal(
      resolution.status === "fallback" ? resolution.requestedId : null,
      "a-backend-from-a-later-build",
      "the preference that could not be honoured is reported, not swallowed",
    );
  });

  test("no preference at all resolves to the default without complaining", () => {
    const registry = createBackendRegistry([registration("first")]);
    for (const value of [null, undefined, ""]) {
      assert.equal(registry.resolve(value).status, "resolved", JSON.stringify(value));
    }
  });

  test("the registry cannot be added to after it is built", () => {
    const registry = createBackendRegistry([registration("first")]);
    assert.throws(() => {
      (registry as { defaultId: string }).defaultId = "other";
    });
  });
});

describe("the registry Nova ships", () => {
  test("the local mock is registered and is the default", () => {
    assert.equal(backendRegistry.defaultId, LOCAL_MOCK_BACKEND_ID);
    assert.ok(backendRegistry.get(LOCAL_MOCK_BACKEND_ID) !== null);
    assert.deepEqual(backendRegistry.get(LOCAL_MOCK_BACKEND_ID)?.descriptor, LOCAL_MOCK_BACKEND_DESCRIPTOR);
  });

  test("the backend a fresh install prefers is one this build actually has", () => {
    assert.equal(backendRegistry.resolve(DEFAULT_BACKEND_ID).status, "resolved");
  });

  test("the real backend is registered, and the mock is still the one a fresh install gets", () => {
    assert.deepEqual(
      backendRegistry.descriptors.map((entry) => entry.id),
      [LOCAL_MOCK_BACKEND_ID, LOCAL_SERVICE_BACKEND_ID],
    );
    assert.equal(backendRegistry.resolve(LOCAL_SERVICE_BACKEND_ID).status, "resolved");
  });

  /**
   * A second, real backend is where this stopped being "every backend is a
   * simulation" and became "every backend says which it is". The flag is checked per backend
   * rather than across all of them, because a wrong answer in either direction
   * is the dishonest one: a simulation that does not admit it, or a real
   * backend labelled as test data.
   */
  test("each shipped backend declares truthfully whether it is a simulation", () => {
    for (const entry of backendRegistry.descriptors) {
      assert.ok(entry.description.length > 0, `${entry.id} needs a description`);
    }

    const mock = backendRegistry.get(LOCAL_MOCK_BACKEND_ID)?.descriptor;
    assert.equal(mock?.simulated, true, "the local mock must declare that it is a simulation");

    const real = backendRegistry.get(LOCAL_SERVICE_BACKEND_ID)?.descriptor;
    assert.equal(real?.simulated, false, "the local service is not a simulation and must not claim to be");
  });

  test("the real backend's description says what its target actually is", () => {
    const { description } = backendRegistry.get(LOCAL_SERVICE_BACKEND_ID)?.descriptor ?? { description: "" };
    assert.match(description, /own process/i, "it must say where the service runs");
    assert.match(description, /not another application/i, "it must say what the target is not");
    assert.match(description, /no debugger and no profiler/i, "it must say which tools it does not supply");
  });
});
