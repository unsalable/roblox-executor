import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createBackendController, type BackendController } from "@/features/backend/backendController";
import {
  createLocalServiceDeveloperBackend,
  LOCAL_SERVICE_BACKEND_ID,
  LOCAL_SERVICE_BACKEND_LABEL,
  type LocalServiceDeveloperBackend,
} from "@/features/backend/backends/LocalServiceDeveloperBackend";
import { healthOf } from "@/features/backend/capabilities";
import { createFakeLocalService, type FakeLocalService } from "@/features/backend/testing/fakeLocalService";
import { createTargetController, type TargetController } from "@/features/target/targetController";
import type { TargetProvider } from "@/features/target/types";
import { createFakeClock, type FakeClock } from "@/lib/testing/fakeClock";

/**
 * The Local Service backend, through the controllers that drive it.
 *
 * The backend is built on the real session client and the real target
 * provider; only the outermost edge — the IPC bridge — is replaced, by the fake
 * service in `testing/fakeLocalService.ts`. So these exercise the production
 * pipeline: the backend lifecycle, the target state machine and the local
 * service's session underneath both.
 *
 * The two lifecycles are never collapsed. A ready backend with no target is an
 * ordinary state and is asserted as one; so is a backend that is ready while
 * two of its three tools do not exist at all.
 */

const HEALTH_MS = 1000;
const REQUEST_TIMEOUT_MS = 400;
const SETTLE_MS = 50;

const silent = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

interface Fixture {
  clock: FakeClock;
  service: FakeLocalService;
  backend: LocalServiceDeveloperBackend;
  controller: BackendController;
  target: TargetController;
  /** Starts the backend and waits for it to settle. */
  becomeReady: () => Promise<void>;
  dispose: () => void;
}

function setup(options: { available?: boolean } = {}): Fixture {
  const clock = createFakeClock();
  const service = createFakeLocalService(options.available === undefined ? {} : { available: options.available });
  let nextId = 0;

  const backend = createLocalServiceDeveloperBackend({
    transport: service.transport,
    clock,
    createId: () => `request-${++nextId}`,
    policy: () => ({ healthCheckIntervalMs: HEALTH_MS }),
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  });

  const controller = createBackendController({ backend, clock, log: silent });
  const target = createTargetController({
    provider: backend.providers.target as TargetProvider,
    clock,
    policy: () => ({ autoDetect: true, autoInject: false, autoReconnect: false, injectTimeoutMs: 1000 }),
    log: silent,
  });

  return {
    clock,
    service,
    backend,
    controller,
    target,
    becomeReady: async () => {
      const submission = controller.start();
      assert.ok(submission.accepted, "the backend refused to start");
      await clock.advance(SETTLE_MS);
      const result = await submission.settled;
      assert.equal(result.status, "started", "the backend did not reach ready");
      await clock.advance(SETTLE_MS);
    },
    dispose: () => {
      target.dispose();
      controller.dispose();
    },
  };
}

describe("the Local Service backend at rest", () => {
  test("it names itself, and says it is not a simulation", () => {
    const fixture = setup();
    assert.equal(fixture.backend.descriptor.id, LOCAL_SERVICE_BACKEND_ID);
    assert.equal(fixture.backend.descriptor.label, LOCAL_SERVICE_BACKEND_LABEL);
    assert.equal(fixture.backend.descriptor.simulated, false);
    assert.equal(fixture.backend.providers.target?.simulated, false);
    fixture.dispose();
  });

  test("it supplies a target and, honestly, neither of the other two tools", () => {
    const fixture = setup();
    const { capabilities } = fixture.controller.getSnapshot();

    assert.equal(fixture.backend.providers.debugger, null);
    assert.equal(fixture.backend.providers.profiler, null);
    assert.equal(capabilities.target.canConnect, true);
    assert.equal(capabilities.target.canCancelInject, true);
    assert.equal(capabilities.debugger.canDebug, false);
    assert.equal(capabilities.profiler.canProfile, false);
    fixture.dispose();
  });

  test("a tool it does not supply is reported as absent, with a reason", async () => {
    const fixture = setup();
    await fixture.becomeReady();
    const { health, providers } = fixture.controller.getSnapshot();

    assert.deepEqual(
      providers.map((provider) => provider.tool),
      ["target"],
      "a provider that does not exist is described to nobody",
    );
    for (const tool of ["debugger", "profiler"] as const) {
      const report = healthOf(health, tool);
      assert.equal(report.health, "unavailable", tool);
      assert.match(String(report.reason), /supplies no|no debugger|no profiler/i, tool);
    }
    fixture.dispose();
  });

  test("nothing has been sent before the backend is started", () => {
    const fixture = setup();
    assert.deepEqual(fixture.service.messages(), []);
    assert.equal(fixture.controller.getSnapshot().state, "created");
    fixture.dispose();
  });
});

describe("the Local Service backend lifecycle", () => {
  test("starting opens a real session and reports the service's own capabilities", async () => {
    const fixture = setup();
    await fixture.becomeReady();

    assert.equal(fixture.controller.getSnapshot().state, "ready");
    assert.equal(fixture.service.currentSessionId(), "session-1");
    assert.deepEqual(fixture.service.ops(), ["handshake", "health"]);
    assert.equal(healthOf(fixture.controller.getSnapshot().health, "target").health, "healthy");
    fixture.dispose();
  });

  test("stopping ends the session on the service and leaves nothing running", async () => {
    const fixture = setup();
    await fixture.becomeReady();

    const stopping = fixture.controller.stop();
    await fixture.clock.advance(SETTLE_MS);
    await stopping;

    assert.equal(fixture.controller.getSnapshot().state, "stopped");
    assert.equal(fixture.service.currentSessionId(), null, "the session was ended on the service");
    fixture.dispose();
    await fixture.clock.advance(HEALTH_MS * 3);
    assert.equal(fixture.clock.pendingTimers(), 0, "a stopped backend leaves no health check armed");
  });

  test("restarting issues a new session rather than reusing the old one", async () => {
    const fixture = setup();
    await fixture.becomeReady();
    const first = fixture.service.currentSessionId();

    const restarting = fixture.controller.restart();
    await fixture.clock.advance(SETTLE_MS);
    const result = await restarting;
    await fixture.clock.advance(SETTLE_MS);

    assert.equal(result.status, "started");
    assert.equal(fixture.service.sessionsIssued(), 2);
    assert.notEqual(fixture.service.currentSessionId(), first);
    assert.equal(fixture.controller.getSnapshot().state, "ready");
    fixture.dispose();
  });

  test("a start is idempotent: a second one joins the first, and opens one session", async () => {
    const fixture = setup();
    const first = fixture.controller.start();
    const second = fixture.controller.start();
    assert.ok(first.accepted && second.accepted);
    await fixture.clock.advance(SETTLE_MS);
    await Promise.all([first.settled, second.settled]);

    assert.equal(fixture.service.sessionsIssued(), 1, "two starts must not open two sessions");
    fixture.dispose();
  });

  test("a service that never answers is abandoned by the start timeout", async () => {
    const fixture = setup();
    fixture.service.setFault("silent");

    const submission = fixture.controller.start();
    assert.ok(submission.accepted);
    await fixture.clock.advance(REQUEST_TIMEOUT_MS + SETTLE_MS);
    const result = await submission.settled;

    assert.equal(result.status, "failed");
    assert.equal(result.status === "failed" ? result.error.code : null, "PROVIDER_TIMEOUT");
    assert.equal(fixture.controller.getSnapshot().state, "error");
    assert.ok(fixture.controller.getSnapshot().errorAt !== null, "a failure is stamped with when it happened");
    fixture.dispose();
  });

  test("a start that is stopped partway leaves no session behind", async () => {
    const fixture = setup();
    // The service opens the session and its answer is held, so the stop lands
    // while the handshake it is abandoning has already taken effect.
    fixture.service.setFault("withheld");
    const submission = fixture.controller.start();
    assert.ok(submission.accepted);
    await fixture.clock.flush();
    assert.equal(fixture.service.currentSessionId(), "session-1", "the service did open one");

    await fixture.controller.stop();
    fixture.service.setFault("none");
    fixture.service.releaseAnswers();
    await fixture.clock.advance(SETTLE_MS);

    assert.equal(fixture.controller.getSnapshot().state, "stopped");
    assert.equal(
      fixture.service.currentSessionId(),
      null,
      "the session the abandoned start opened was ended, not left running",
    );
    fixture.dispose();
  });

  test("a service without the target capability is refused rather than reported ready", async () => {
    const fixture = setup();
    fixture.service.setTargetCapability(false);

    const submission = fixture.controller.start();
    assert.ok(submission.accepted);
    await fixture.clock.advance(SETTLE_MS);
    const result = await submission.settled;

    assert.equal(result.status, "failed");
    assert.equal(result.status === "failed" ? result.error.code : null, "PROVIDER_CAPABILITY_UNSUPPORTED");
    assert.equal(fixture.service.currentSessionId(), null, "a refused start opens no session");
    fixture.dispose();
  });

  test("without an IPC bridge the backend fails with the reason, not a crash", async () => {
    const fixture = setup({ available: false });

    const submission = fixture.controller.start();
    assert.ok(submission.accepted);
    await fixture.clock.advance(SETTLE_MS);
    const result = await submission.settled;

    assert.equal(result.status === "failed" ? result.error.code : null, "PROVIDER_TRANSPORT_UNAVAILABLE");
    fixture.dispose();
  });
});

describe("health, capabilities and what the backend says about itself", () => {
  test("the health check keeps running and keeps reporting", async () => {
    const fixture = setup();
    await fixture.becomeReady();
    const before = fixture.service.ops().filter((op) => op === "health").length;

    await fixture.clock.advance(HEALTH_MS * 3);
    const after = fixture.service.ops().filter((op) => op === "health").length;

    assert.ok(after >= before + 3, `expected at least three more checks, saw ${after - before}`);
    fixture.dispose();
  });

  test("a health check that fails once is degraded, not a lost backend", async () => {
    const fixture = setup();
    await fixture.becomeReady();

    fixture.service.setFault("throw");
    await fixture.clock.advance(HEALTH_MS);

    const report = healthOf(fixture.controller.getSnapshot().health, "target");
    assert.equal(report.health, "degraded");
    assert.equal(fixture.controller.getSnapshot().state, "ready", "one failed question is not a stopped backend");

    fixture.service.setFault("none");
    await fixture.clock.advance(HEALTH_MS);
    assert.equal(healthOf(fixture.controller.getSnapshot().health, "target").health, "healthy");
    fixture.dispose();
  });

  test("the panel is told when the backend's own health moves, without being asked", async () => {
    const fixture = setup();
    await fixture.becomeReady();

    let published = 0;
    const unsubscribe = fixture.controller.subscribe(() => {
      published += 1;
    });
    fixture.service.setFault("throw");
    await fixture.clock.advance(HEALTH_MS);
    unsubscribe();

    assert.ok(published > 0, "a health change must reach the controller's subscribers on its own");
    fixture.dispose();
  });

  test("refreshing capabilities re-reads health and changes no state", async () => {
    const fixture = setup();
    await fixture.becomeReady();
    const before = fixture.controller.getSnapshot();

    fixture.controller.refreshCapabilities();
    const after = fixture.controller.getSnapshot();

    assert.equal(after.state, before.state);
    assert.deepEqual(after.capabilities, before.capabilities);
    assert.equal(healthOf(after.health, "target").health, "healthy");
    fixture.dispose();
  });

  test("the diagnostics name the transport, the protocol and the session — and never the token", async () => {
    const fixture = setup();
    await fixture.becomeReady();
    const { diagnostics } = fixture.controller.getSnapshot();
    const rows = new Map(diagnostics.map((entry) => [entry.label, entry.value]));

    assert.equal(rows.get("Transport"), "Fake IPC");
    assert.equal(rows.get("Protocol"), "NOVA_LOCAL_SERVICE_V1");
    assert.equal(rows.get("Service session"), "Open");
    assert.equal(rows.get("Session id"), "session-1");
    assert.equal(rows.get("Attachment"), "Not attached");
    assert.equal(rows.get("Sessions issued"), "1");

    const token = fixture.service.currentToken();
    assert.ok(token !== null);
    assert.ok(!JSON.stringify(diagnostics).includes(token), "a diagnostic must never carry the session token");
    fixture.dispose();
  });

  test("the diagnostics keep up with a service that is answering normally", async () => {
    const fixture = setup();
    await fixture.becomeReady();
    const requestsOf = () =>
      Number(fixture.controller.getSnapshot().diagnostics.find((entry) => entry.label === "Requests")?.value ?? "0");
    const before = requestsOf();

    await fixture.clock.advance(HEALTH_MS * 2);

    assert.ok(
      requestsOf() > before,
      "a health check that changes nothing still made a request, and the panel has to see it",
    );
    fixture.dispose();
  });

  test("a stopped backend reports nothing as healthy", async () => {
    const fixture = setup();
    await fixture.becomeReady();
    const stopping = fixture.controller.stop();
    await fixture.clock.advance(SETTLE_MS);
    await stopping;

    for (const report of fixture.controller.getSnapshot().health) {
      assert.equal(report.health, "unavailable", report.tool);
    }
    fixture.dispose();
  });
});

/**
 * A lifecycle operation here can be overtaken by the next one: the controller
 * abandons a timed-out start without waiting for it, and a restart needs no
 * permission from the stop it follows. So what an operation finds after an
 * `await` is not necessarily what it was acting on before, and these are the
 * cases where believing otherwise would show a ready target beside a stopped
 * backend, or tear down a session that something else had just opened.
 */
describe("an answer that outlives the operation that asked for it", () => {
  test("a health answer that lands after a stop cannot put the target back", async () => {
    const fixture = setup();
    await fixture.becomeReady();
    await fixture.target.detect();
    await fixture.clock.advance(SETTLE_MS);
    assert.equal(fixture.target.getSnapshot().status, "ready");

    // A health check goes out and its answer is held.
    fixture.service.setFault("withheld");
    await fixture.clock.advance(HEALTH_MS);
    fixture.service.setFault("none");

    const stopping = fixture.controller.stop();
    await fixture.clock.advance(SETTLE_MS);
    await stopping;

    // Now the health answer lands, saying the target is available and ready.
    fixture.service.releaseAnswers();
    await fixture.clock.advance(SETTLE_MS);

    assert.equal(fixture.controller.getSnapshot().state, "stopped");
    assert.equal(
      fixture.target.getSnapshot().status,
      "unavailable",
      "a stopped backend must never be shown beside a ready target",
    );
    assert.equal(healthOf(fixture.controller.getSnapshot().health, "target").health, "unavailable");
    fixture.dispose();
  });

  test("an attach whose answer never arrives leaves no attachment behind", async () => {
    const fixture = setup();
    await fixture.becomeReady();
    await fixture.target.detect();
    await fixture.clock.advance(SETTLE_MS);

    fixture.service.setFault("withheld");
    const submission = fixture.target.inject();
    assert.ok(submission.accepted);
    await fixture.clock.flush();
    assert.equal(fixture.service.isAttached(), true, "the service did attach");

    // The answer never comes back within the request deadline.
    await fixture.clock.advance(REQUEST_TIMEOUT_MS + SETTLE_MS);
    fixture.service.setFault("none");
    fixture.service.releaseAnswers();
    await fixture.clock.advance(SETTLE_MS);
    const result = await submission.result;

    assert.equal(result.success, false);
    assert.equal(fixture.target.getSnapshot().session, "inactive");
    assert.equal(
      fixture.service.isAttached(),
      false,
      "an attach Nova reported as failed must not be left holding the service",
    );
    fixture.dispose();
  });

  test("an attachment a failed detach left behind is undone at the next health check", async () => {
    const fixture = setup();
    await fixture.becomeReady();
    await fixture.target.detect();
    await fixture.clock.advance(SETTLE_MS);
    const submission = fixture.target.inject();
    assert.ok(submission.accepted);
    await fixture.clock.advance(SETTLE_MS);
    await submission.result;

    // The detach never reaches the service: Nova lets go, the service does not.
    fixture.service.setFault("throw");
    await fixture.target.disconnect();
    await fixture.clock.advance(SETTLE_MS);
    fixture.service.setFault("none");
    assert.equal(fixture.service.isAttached(), true, "the service kept the attachment");
    assert.equal(fixture.target.getSnapshot().session, "inactive", "Nova already let go");

    await fixture.clock.advance(HEALTH_MS + SETTLE_MS);
    assert.equal(
      fixture.service.isAttached(),
      false,
      "the two disagreed, and the health check repaired it rather than leaving it",
    );
    fixture.dispose();
  });
});

describe("the target the Local Service backend supplies", () => {
  test("backend stopped means no target, whatever the service would say", async () => {
    const fixture = setup();
    const status = await fixture.target.detect();

    assert.equal(status, "unavailable");
    assert.equal(fixture.controller.getSnapshot().state, "created");
    fixture.dispose();
  });

  test("backend ready and the target ready are two separate facts, both reported", async () => {
    const fixture = setup();
    await fixture.becomeReady();
    await fixture.target.detect();
    await fixture.clock.advance(SETTLE_MS);

    assert.equal(fixture.controller.getSnapshot().state, "ready");
    assert.equal(fixture.target.getSnapshot().status, "ready");
    assert.equal(fixture.target.getSnapshot().session, "inactive", "a ready target is not an open session");
    fixture.dispose();
  });

  test("injecting attaches the session on the service, and says so", async () => {
    const fixture = setup();
    await fixture.becomeReady();
    await fixture.target.detect();
    await fixture.clock.advance(SETTLE_MS);

    const submission = fixture.target.inject();
    assert.ok(submission.accepted);
    await fixture.clock.advance(SETTLE_MS);
    const result = await submission.result;

    assert.equal(result.success, true);
    assert.equal(fixture.service.isAttached(), true, "the attachment is real state on the service");
    assert.equal(fixture.target.getSnapshot().status, "injected");
    assert.equal(fixture.target.getSnapshot().session, "active");
    assert.equal(fixture.target.getSnapshot().diagnostics.simulated, false);
    assert.equal(fixture.target.getSnapshot().diagnostics.transport, "Fake IPC");
    fixture.dispose();
  });

  test("disconnecting detaches on the service and ends the session here", async () => {
    const fixture = setup();
    await fixture.becomeReady();
    await fixture.target.detect();
    await fixture.clock.advance(SETTLE_MS);
    const submission = fixture.target.inject();
    assert.ok(submission.accepted);
    await fixture.clock.advance(SETTLE_MS);
    await submission.result;

    await fixture.target.disconnect();
    await fixture.clock.advance(SETTLE_MS);

    assert.equal(fixture.service.isAttached(), false);
    assert.equal(fixture.target.getSnapshot().session, "inactive");
    fixture.dispose();
  });

  test("losing the session is reported as a disconnect, never silently repaired", async () => {
    const fixture = setup();
    await fixture.becomeReady();
    await fixture.target.detect();
    await fixture.clock.advance(SETTLE_MS);
    const submission = fixture.target.inject();
    assert.ok(submission.accepted);
    await fixture.clock.advance(SETTLE_MS);
    await submission.result;

    // The service ends the session on its own: a restart, or another window
    // taking it over. Nova finds out at its next health check.
    fixture.service.endSession();
    await fixture.clock.advance(HEALTH_MS + SETTLE_MS);

    const snapshot = fixture.target.getSnapshot();
    assert.equal(snapshot.status, "unavailable");
    assert.equal(snapshot.session, "inactive");
    assert.equal(snapshot.error?.code, "TARGET_DISCONNECTED");
    assert.equal(fixture.controller.getSnapshot().state, "ready", "losing the target does not stop the backend");
    fixture.dispose();
  });

  test("the backend opens a new session after one is lost, and the target comes back", async () => {
    const fixture = setup();
    await fixture.becomeReady();
    await fixture.target.detect();
    await fixture.clock.advance(SETTLE_MS);

    fixture.service.endSession();
    await fixture.clock.advance(HEALTH_MS + SETTLE_MS);
    assert.equal(fixture.target.getSnapshot().status, "unavailable");
    assert.equal(healthOf(fixture.controller.getSnapshot().health, "target").health, "error");

    // One recovery attempt per health interval, through the same handshake a
    // start uses. Nothing retries in a tight loop.
    await fixture.clock.advance(HEALTH_MS + SETTLE_MS);

    assert.equal(fixture.service.sessionsIssued(), 2);
    assert.equal(healthOf(fixture.controller.getSnapshot().health, "target").health, "healthy");
    assert.equal(fixture.target.getSnapshot().status, "ready", "the target is found again on its own");
    fixture.dispose();
  });

  test("an attachment the service no longer has is reported, not assumed", async () => {
    const fixture = setup();
    await fixture.becomeReady();
    await fixture.target.detect();
    await fixture.clock.advance(SETTLE_MS);
    const submission = fixture.target.inject();
    assert.ok(submission.accepted);
    await fixture.clock.advance(SETTLE_MS);
    await submission.result;

    fixture.service.loseAttachment();
    await fixture.clock.advance(HEALTH_MS + SETTLE_MS);

    assert.equal(fixture.target.getSnapshot().session, "inactive", "Nova must not claim an attachment it has lost");
    assert.equal(fixture.target.getSnapshot().status, "unavailable");
    fixture.dispose();
  });

  test("a cancelled injection leaves no attachment behind on the service", async () => {
    const fixture = setup();
    await fixture.becomeReady();
    await fixture.target.detect();
    await fixture.clock.advance(SETTLE_MS);

    // The attach reaches the service and succeeds there; only its answer is
    // held. That is the case worth proving: Nova stopped waiting, the service
    // went ahead, and the attachment must not survive the cancellation.
    fixture.service.setFault("withheld");
    const submission = fixture.target.inject();
    assert.ok(submission.accepted);
    await fixture.clock.flush();
    assert.equal(fixture.service.isAttached(), true, "the service did attach");

    assert.equal(fixture.target.cancelInject(), "requested");
    fixture.service.setFault("none");
    await fixture.clock.advance(SETTLE_MS);
    fixture.service.releaseAnswers();
    await fixture.clock.advance(SETTLE_MS);
    const result = await submission.result;

    assert.equal(result.cancelled, true);
    assert.equal(fixture.target.getSnapshot().session, "inactive");
    assert.equal(fixture.service.isAttached(), false, "a cancelled attach is undone, never left half-done");
    fixture.dispose();
  });

  test("restarting the backend while the target is attached ends the session cleanly", async () => {
    const fixture = setup();
    await fixture.becomeReady();
    await fixture.target.detect();
    await fixture.clock.advance(SETTLE_MS);
    const submission = fixture.target.inject();
    assert.ok(submission.accepted);
    await fixture.clock.advance(SETTLE_MS);
    await submission.result;
    assert.equal(fixture.service.isAttached(), true);

    const restarting = fixture.controller.restart();
    await fixture.clock.advance(SETTLE_MS);
    await restarting;
    await fixture.clock.advance(SETTLE_MS);

    assert.equal(fixture.controller.getSnapshot().state, "ready");
    assert.equal(fixture.service.isAttached(), false, "the new session starts unattached");
    assert.equal(fixture.target.getSnapshot().session, "inactive");
    assert.notEqual(fixture.target.getSnapshot().status, "injected", "nothing claims to still be attached");
    fixture.dispose();
  });
});
