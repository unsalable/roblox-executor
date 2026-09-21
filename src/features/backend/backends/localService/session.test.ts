import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createLocalServiceSession, type LocalServiceSession } from "@/features/backend/backends/localService/session";
import { createFakeLocalService, type FakeLocalService } from "@/features/backend/testing/fakeLocalService";
import { createFakeClock, type FakeClock } from "@/lib/testing/fakeClock";

/**
 * The session client: authentication, deadlines and staleness.
 *
 * These are the transport-level guarantees the local service promises — a request that is
 * authenticated, a service that never answers, a malformed answer, an answer
 * for a request that is no longer live, and a session that has been replaced.
 * Every one of them is driven against a fake service rather than a real bridge,
 * because three of them cannot be produced by a service that works.
 *
 * The fake's tokens are counter-derived and knowable on purpose: the tests that
 * assert a token never leaks need a value to search for.
 */

const REQUEST_TIMEOUT_MS = 400;

interface Fixture {
  clock: FakeClock;
  service: FakeLocalService;
  session: LocalServiceSession;
}

function setup(options: { available?: boolean } = {}): Fixture {
  const clock = createFakeClock();
  const service = createFakeLocalService(options.available === undefined ? {} : { available: options.available });
  let nextId = 0;
  const session = createLocalServiceSession({
    transport: service.transport,
    clock,
    createId: () => `request-${++nextId}`,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  });
  return { clock, service, session };
}

const signal = () => new AbortController().signal;

async function opened(fixture: Fixture): Promise<void> {
  const result = await fixture.session.open({ signal: signal() });
  assert.equal(result.status, "ok", "the session did not open");
}

describe("opening a local service session", () => {
  test("a handshake opens a session and reports what the service can do", async () => {
    const { service, session } = setup();
    const result = await session.open({ signal: signal() });

    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.value.sessionId, "session-1");
    assert.equal(result.value.capabilities.target, true);
    assert.equal(result.value.capabilities.debugger, false);
    assert.equal(session.isOpen(), true);
    assert.deepEqual(service.ops(), ["handshake"]);
  });

  test("the session the client hands out never carries the token", async () => {
    const fixture = setup();
    await opened(fixture);
    const { service, session } = fixture;
    const info = session.getInfo();

    assert.ok(info !== null);
    assert.equal(service.currentToken(), "token-1");
    assert.ok(!JSON.stringify(info).includes("token-1"), "the session info must not contain the secret");
    assert.ok(!JSON.stringify(session.getStats()).includes("token-1"), "and neither may the stats");
  });

  test("a handshake requiring something the service lacks fails and opens nothing", async () => {
    const { service, session } = setup();
    service.setTargetCapability(false);
    const result = await session.open({ signal: signal() });

    assert.equal(result.status, "failed");
    assert.equal(result.status === "failed" ? result.error.code : null, "CAPABILITY_UNSUPPORTED");
    assert.equal(session.isOpen(), false);
  });

  test("without a bridge nothing is sent, and the refusal says why", async () => {
    const { service, session } = setup({ available: false });
    const result = await session.open({ signal: signal() });

    assert.equal(result.status === "failed" ? result.error.code : null, "TRANSPORT_UNAVAILABLE");
    assert.deepEqual(service.messages(), [], "a request must not reach a bridge that is not there");
  });
});

describe("a session that is authenticated on every request", () => {
  test("every request after the handshake carries the session and the token", async () => {
    const fixture = setup();
    await opened(fixture);
    await fixture.session.health();

    const [, healthMessage] = fixture.service.messages();
    const sent = JSON.parse(healthMessage ?? "{}") as Record<string, unknown>;
    assert.equal(sent.sessionId, "session-1");
    assert.equal(sent.token, "token-1");
  });

  test("a request with no session is refused before it is sent", async () => {
    const { service, session } = setup();
    const result = await session.health();

    assert.equal(result.status === "failed" ? result.error.code : null, "AUTH_REQUIRED");
    assert.deepEqual(service.messages(), [], "nothing is sent without a session");
  });

  test("a session the service no longer knows is dropped, not retried with", async () => {
    const fixture = setup();
    await opened(fixture);
    fixture.service.endSession();

    const result = await fixture.session.health();
    assert.equal(result.status === "failed" ? result.error.code : null, "SESSION_STALE");
    assert.equal(fixture.session.isOpen(), false, "a lost session is forgotten rather than kept");

    const again = await fixture.session.health();
    assert.equal(again.status === "failed" ? again.error.code : null, "AUTH_REQUIRED");
  });

  test("closing a session ends it on the service and forgets the token", async () => {
    const fixture = setup();
    await opened(fixture);
    await fixture.session.close();

    assert.equal(fixture.session.isOpen(), false);
    assert.equal(fixture.service.currentSessionId(), null, "the service was told to end it");
    assert.ok(fixture.service.ops().includes("shutdown"));
  });

  test("closing twice is safe and sends nothing the second time", async () => {
    const fixture = setup();
    await opened(fixture);
    await fixture.session.close();
    const sent = fixture.service.messages().length;
    await fixture.session.close();

    assert.equal(fixture.service.messages().length, sent);
  });
});

describe("a service that does not answer properly", () => {
  test("a service that never answers is abandoned by the deadline", async () => {
    const fixture = setup();
    await opened(fixture);
    fixture.service.setFault("silent");

    const pending = fixture.session.health();
    await fixture.clock.advance(REQUEST_TIMEOUT_MS);
    const result = await pending;

    assert.equal(result.status === "failed" ? result.error.code : null, "REQUEST_TIMEOUT");
    assert.equal(fixture.session.isOpen(), true, "one unanswered question is not a lost session");
  });

  test("a bridge that fails is reported as the bridge failing", async () => {
    const fixture = setup();
    await opened(fixture);
    fixture.service.setFault("throw");

    const result = await fixture.session.health();
    assert.equal(result.status === "failed" ? result.error.code : null, "TRANSPORT_FAILED");
  });

  test("an answer that is not a response is refused rather than read", async () => {
    const fixture = setup();
    await opened(fixture);

    for (const fault of ["garbage", "oversized"] as const) {
      fixture.service.setFault(fault);
      const result = await fixture.session.health();
      assert.equal(result.status === "failed" ? result.error.code : null, "RESPONSE_MALFORMED", fault);
    }
  });

  test("an answer for another request cannot be mistaken for this one", async () => {
    const fixture = setup();
    await opened(fixture);
    fixture.service.setFault("mismatched");

    const result = await fixture.session.health();
    assert.equal(result.status === "failed" ? result.error.code : null, "RESPONSE_MISMATCHED");
  });

  test("an answer in another protocol version is refused", async () => {
    const fixture = setup();
    await opened(fixture);
    fixture.service.setFault("wrong-protocol");

    const result = await fixture.session.health();
    assert.equal(result.status === "failed" ? result.error.code : null, "PROTOCOL_UNSUPPORTED");
  });

  test("a health report the client cannot read is refused rather than half-applied", async () => {
    const fixture = setup();
    await opened(fixture);
    fixture.service.setFault("mismatched");
    await fixture.session.health();
    fixture.service.setFault("none");

    const recovered = await fixture.session.health();
    assert.equal(recovered.status, "ok", "one unreadable answer does not break the session");
  });
});

describe("answers that outlive what asked for them", () => {
  test("an answer that arrives after the session was replaced is discarded", async () => {
    const fixture = setup();
    await opened(fixture);

    // Hold the answer, replace the session underneath it, then let it land.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = fixture.service.transport.send;
    // Only the health answer is held, so the handshake that replaces the
    // session can still complete while it is in flight.
    const slow = {
      ...fixture.service.transport,
      send: async (message: string) => {
        const answer = await original(message);
        if ((JSON.parse(message) as { op: string }).op === "health") await held;
        return answer;
      },
    };
    let nextId = 100;
    const session = createLocalServiceSession({
      transport: slow,
      clock: fixture.clock,
      createId: () => `request-${++nextId}`,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });
    await session.open({ signal: signal() });

    const inFlight = session.health();
    // A second handshake supersedes the first, exactly as the service does it.
    session.forget({ code: "SESSION_STALE", message: "replaced by the test" });
    await session.open({ signal: signal() });
    release();

    const result = await inFlight;
    assert.equal(result.status === "failed" ? result.error.code : null, "SESSION_STALE");
    assert.equal(session.isOpen(), true, "the session that replaced it is untouched");
  });

  test("a handshake that lands after the backend gave up leaves no session behind", async () => {
    const fixture = setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = fixture.service.transport.send;
    // Only the first handshake is held; the shutdown that ends the orphaned
    // session must still get through.
    let holdNext = true;
    const slow = {
      ...fixture.service.transport,
      send: async (message: string) => {
        const answer = await original(message);
        if (holdNext && (JSON.parse(message) as { op: string }).op === "handshake") {
          holdNext = false;
          await held;
        }
        return answer;
      },
    };
    let nextId = 200;
    const session = createLocalServiceSession({
      transport: slow,
      clock: fixture.clock,
      createId: () => `request-${++nextId}`,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });

    const opening = session.open({ signal: signal() });
    await session.close();
    release();

    const result = await opening;
    assert.equal(result.status, "cancelled");
    assert.equal(session.isOpen(), false);
    await fixture.clock.flush();
    assert.equal(fixture.service.currentSessionId(), null, "the orphaned session was ended on the service");
  });

  test("a close that is overtaken by a new session does not end the one that replaced it", async () => {
    const fixture = setup();
    await opened(fixture);

    // The shutdown reaches the service and its answer is held.
    fixture.service.setFault("withheld");
    const closing = fixture.session.close();
    await fixture.clock.flush();
    fixture.service.setFault("none");

    // Something starts the backend again before the stop has drained.
    const reopened = await fixture.session.open({ signal: signal() });
    assert.equal(reopened.status, "ok");

    fixture.service.releaseAnswers();
    await closing;
    await fixture.clock.flush();

    assert.equal(fixture.session.isOpen(), true, "the newer session survives the older stop");
    assert.equal(fixture.session.getInfo()?.sessionId, "session-2");
    assert.equal(fixture.service.currentSessionId(), "session-2");
  });

  test("an aborted request is cancelled, not failed", async () => {
    const fixture = setup();
    await opened(fixture);
    fixture.service.setFault("silent");

    const controller = new AbortController();
    const pending = fixture.session.attach({ signal: controller.signal });
    controller.abort();

    assert.equal((await pending).status, "cancelled");
  });

  test("a request whose signal is already aborted never waits", async () => {
    const fixture = setup();
    await opened(fixture);
    fixture.service.setFault("silent");
    const controller = new AbortController();
    controller.abort();

    const result = await fixture.session.attach({ signal: controller.signal });
    assert.equal(result.status, "cancelled");
    assert.equal(fixture.clock.pendingTimers(), 0, "an abandoned request leaves no timer armed");
  });
});

describe("what the session reports about itself", () => {
  test("a message larger than the protocol allows is refused before the bridge sees it", async () => {
    const fixture = setup();
    await opened(fixture);
    const huge = "x".repeat(70 * 1024);
    // The only op with a caller-shaped payload is the handshake; the client's
    // own limit is exercised through a request id long enough to break it.
    let nextId = 0;
    const session = createLocalServiceSession({
      transport: fixture.service.transport,
      clock: fixture.clock,
      createId: () => `${huge}-${++nextId}`,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });
    const sent = fixture.service.messages().length;
    const result = await session.open({ signal: signal() });

    assert.equal(result.status === "failed" ? result.error.code : null, "MESSAGE_TOO_LARGE");
    assert.equal(fixture.service.messages().length, sent, "nothing oversized reached the bridge");
  });

  test("statistics count requests and the last round trip, and keep the last failure", async () => {
    const fixture = setup();
    await opened(fixture);
    await fixture.session.health();

    const stats = fixture.session.getStats();
    assert.equal(stats.requests, 2);
    assert.equal(stats.lastError, null);
    assert.equal(stats.sessionsIssued, 1);
    assert.ok(stats.lastLatencyMs !== null && stats.lastLatencyMs >= 0);

    fixture.service.setFault("throw");
    await fixture.session.health();
    assert.equal(fixture.session.getStats().lastError?.code, "TRANSPORT_FAILED");
  });

  test("attaching and detaching move the service's own state", async () => {
    const fixture = setup();
    await opened(fixture);

    const attached = await fixture.session.attach({ signal: signal() });
    assert.equal(attached.status, "ok");
    assert.equal(fixture.service.isAttached(), true);

    const again = await fixture.session.attach({ signal: signal() });
    assert.equal(again.status === "failed" ? again.error.code : null, "ALREADY_ATTACHED");

    assert.equal((await fixture.session.detach()).status, "ok");
    assert.equal(fixture.service.isAttached(), false);
  });
});
