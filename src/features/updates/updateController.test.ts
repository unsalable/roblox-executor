import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { createUpdateController, STARTUP_CHECK_DELAY_MS, type UpdateController } from "@/features/updates/updateController";
import { createFakeUpdateProvider, type FakeUpdateProvider } from "@/features/updates/testing/fakeUpdateProvider";
import type { UpdateProgress } from "@/features/updates/types";
import { createFakeClock, type FakeClock } from "@/lib/testing/fakeClock";

const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

interface Harness {
  controller: UpdateController;
  provider: FakeUpdateProvider;
  clock: FakeClock;
  /** Every status the controller passed through, in order. */
  statuses: string[];
}

function harness(options: { available?: boolean; checkOnStartup?: boolean } = {}): Harness {
  const clock = createFakeClock();
  const provider = createFakeUpdateProvider({ available: options.available ?? true });
  const controller = createUpdateController({
    provider,
    clock,
    policy: () => ({ checkOnStartup: options.checkOnStartup ?? true }),
    log: silentLog,
  });

  const statuses: string[] = [];
  controller.subscribe(() => {
    const status = controller.getSnapshot().status;
    if (statuses[statuses.length - 1] !== status) statuses.push(status);
  });

  return { controller, provider, clock, statuses };
}

describe("an update check", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("starts with nothing checked and nothing shown", () => {
    const snapshot = h.controller.getSnapshot();
    assert.equal(snapshot.status, "idle");
    assert.equal(snapshot.release, null);
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.promptOpen, false);
    assert.equal(snapshot.lastCheckedAt, null);
  });

  it("no update: the newest build says so and interrupts nobody", async () => {
    h.provider.answerUpToDate();
    await h.controller.check();

    const snapshot = h.controller.getSnapshot();
    assert.equal(snapshot.status, "up-to-date");
    assert.equal(snapshot.release, null);
    assert.equal(snapshot.promptOpen, false, "a silent check must not open the prompt");
    assert.equal(snapshot.lastCheckedAt, h.clock.now());
    assert.deepEqual(h.statuses, ["checking", "up-to-date"]);
  });

  it("no update: a check the user asked for says so out loud", async () => {
    h.provider.answerUpToDate();
    await h.controller.check({ manual: true });

    assert.equal(h.controller.getSnapshot().promptOpen, true);
    assert.equal(h.controller.getSnapshot().manual, true);
  });

  it("same version is the same answer as no update", async () => {
    // The updater answers "nothing newer" for an equal version; Nova never
    // offers to install the build it is already running.
    h.provider.answerUpToDate();
    await h.controller.check();
    assert.equal(h.controller.getSnapshot().status, "up-to-date");
    assert.equal(h.controller.getSnapshot().release, null);
  });

  it("newer update: the release is offered and the prompt opens by itself", async () => {
    h.provider.answerAvailable("2026.1005.900", { notes: "Fixes things", publishedAt: "2026-10-05T09:00:00Z" });
    await h.controller.check();

    const snapshot = h.controller.getSnapshot();
    assert.equal(snapshot.status, "available");
    assert.equal(snapshot.release?.version, "2026.1005.900");
    assert.equal(snapshot.release?.currentVersion, "2026.921.1350");
    assert.equal(snapshot.release?.notes, "Fixes things");
    assert.equal(snapshot.promptOpen, true, "a newer release is worth interrupting for");
  });

  it("network unavailable: it fails quietly when nobody asked", async () => {
    h.provider.answerFailure(new Error("error sending request for url (https://github.com/...)"));
    await h.controller.check();

    const snapshot = h.controller.getSnapshot();
    assert.equal(snapshot.status, "error");
    assert.equal(snapshot.error?.code, "NETWORK_UNAVAILABLE");
    assert.equal(snapshot.promptOpen, false, "being offline is not an interruption");
  });

  it("network unavailable: it says so when the user asked", async () => {
    h.provider.answerFailure(new Error("error sending request"));
    await h.controller.check({ manual: true });

    assert.equal(h.controller.getSnapshot().error?.code, "NETWORK_UNAVAILABLE");
    assert.equal(h.controller.getSnapshot().promptOpen, true);
  });

  it("malformed release metadata is reported even to a check nobody asked for", async () => {
    h.provider.answerFailure(new Error("error decoding response body: expected value at line 1 column 1"));
    await h.controller.check();

    const snapshot = h.controller.getSnapshot();
    assert.equal(snapshot.error?.code, "RELEASE_MALFORMED");
    assert.equal(snapshot.promptOpen, true, "a broken release source is not normal and is worth saying");
    assert.equal(snapshot.release, null);
  });

  it("a build that cannot update itself says so instead of pretending to check", async () => {
    const offline = harness({ available: false });
    await offline.controller.check({ manual: true });

    assert.equal(offline.controller.getSnapshot().error?.code, "UPDATER_UNAVAILABLE");
    assert.equal(offline.provider.calls.check, 0, "it must not reach the source at all");
  });

  it("refuses a second check while one is in flight", async () => {
    const open = h.provider.holdCheck();
    h.provider.answerUpToDate();

    const first = h.controller.check();
    await h.controller.check({ manual: true });
    assert.equal(h.controller.getSnapshot().status, "checking");

    open();
    await first;
    assert.equal(h.provider.calls.check, 1);
  });

  it("ignores the answer to a check that was abandoned", async () => {
    const open = h.provider.holdCheck();
    h.provider.answerAvailable("2026.1005.900");
    const abandoned = h.controller.check();

    h.controller.dispose();
    open();
    await abandoned;

    assert.equal(h.controller.getSnapshot().status, "checking", "a disposed controller keeps its last state");
    assert.equal(h.provider.calls.close, 1, "the abandoned release must be released");
  });

  it("clears the previous answer before asking again", async () => {
    h.provider.answerAvailable("2026.1005.900");
    await h.controller.check();
    assert.equal(h.provider.calls.close, 0);

    h.provider.answerUpToDate();
    await h.controller.check({ manual: true });

    assert.equal(h.controller.getSnapshot().release, null);
    assert.equal(h.provider.calls.close, 1, "the release the source no longer names must be let go");
  });
});

describe("installing an update", () => {
  let h: Harness;
  beforeEach(async () => {
    h = harness();
    h.provider.answerAvailable("2026.1005.900");
    await h.controller.check();
  });

  it("successful installation: download, install, and a restart left to offer", async () => {
    await h.controller.install();

    const snapshot = h.controller.getSnapshot();
    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.progress, null);
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.promptOpen, true);
    assert.deepEqual(h.statuses, ["checking", "available", "downloading", "installing", "ready"]);
  });

  it("reports progress while it downloads and then while it installs", async () => {
    const seen: UpdateProgress[] = [];
    h.controller.subscribe(() => {
      const { progress, status } = h.controller.getSnapshot();
      if (progress && status === "downloading") seen.push(progress);
    });

    h.provider.installProgress([
      { phase: "downloading", downloadedBytes: 0, totalBytes: 400 },
      { phase: "downloading", downloadedBytes: 250, totalBytes: 400 },
      { phase: "downloading", downloadedBytes: 400, totalBytes: 400 },
      { phase: "installing", downloadedBytes: 400, totalBytes: 400 },
    ]);
    await h.controller.install();

    assert.deepEqual(
      seen.map((p) => p.downloadedBytes),
      [0, 0, 250, 400],
    );
    assert.equal(h.controller.getSnapshot().status, "ready");
  });

  it("still reaches ready when the source declared no size and no install phase", async () => {
    h.provider.installProgress([{ phase: "downloading", downloadedBytes: 12, totalBytes: null }]);
    await h.controller.install();

    assert.equal(h.controller.getSnapshot().status, "ready");
    assert.deepEqual(h.statuses, ["checking", "available", "downloading", "installing", "ready"]);
  });

  it("invalid signature: it fails and nothing is installed", async () => {
    h.provider.failInstall(new Error("failed to verify the signature of the update"));
    await h.controller.install();

    const snapshot = h.controller.getSnapshot();
    assert.equal(snapshot.status, "error");
    assert.equal(snapshot.error?.code, "SIGNATURE_INVALID");
    assert.match(snapshot.error!.message, /not installed/);
    assert.equal(snapshot.promptOpen, true, "a rejected signature is always shown");
    assert.equal(snapshot.progress, null);
  });

  it("download failure: it fails and can be retried", async () => {
    h.provider.failInstall(new Error("download failed: incomplete body"));
    await h.controller.install();
    assert.equal(h.controller.getSnapshot().error?.code, "DOWNLOAD_FAILED");

    h.provider.installProgress([{ phase: "installing", downloadedBytes: 1, totalBytes: 1 }]);
    await h.controller.install();

    assert.equal(h.controller.getSnapshot().status, "ready");
    assert.equal(h.provider.calls.install, 2, "retrying installs again rather than asking the source again");
  });

  it("an install failure keeps the release so the retry does not have to check again", async () => {
    h.provider.failInstall(new Error("installer exited with exit code 1"));
    await h.controller.install();

    assert.equal(h.controller.getSnapshot().error?.code, "INSTALL_FAILED");
    assert.equal(h.controller.getSnapshot().release?.version, "2026.1005.900");
    assert.equal(h.provider.calls.check, 1);
  });

  it("refuses to install when nothing was offered", async () => {
    const empty = harness();
    empty.provider.answerUpToDate();
    await empty.controller.check();
    await empty.controller.install();

    assert.equal(empty.controller.getSnapshot().status, "up-to-date");
    assert.equal(empty.provider.calls.install, 0);
  });

  it("refuses to check while an update is installing", async () => {
    h.provider.installProgress([{ phase: "installing", downloadedBytes: 1, totalBytes: 1 }]);
    await h.controller.install();
    await h.controller.check({ manual: true });

    assert.equal(h.controller.getSnapshot().status, "ready", "an installed update is not re-checked");
    assert.equal(h.provider.calls.check, 1);
  });
});

describe("restarting into an installed update", () => {
  it("restarts once the update is installed", async () => {
    const h = harness();
    h.provider.answerAvailable("2026.1005.900");
    await h.controller.check();
    await h.controller.install();
    await h.controller.restart();

    assert.equal(h.provider.calls.relaunch, 1);
  });

  it("does not restart when there is nothing installed", async () => {
    const h = harness();
    h.provider.answerAvailable("2026.1005.900");
    await h.controller.check();
    await h.controller.restart();

    assert.equal(h.provider.calls.relaunch, 0);
  });

  it("keeps the update installed when the restart itself fails", async () => {
    const h = harness();
    h.provider.answerAvailable("2026.1005.900");
    await h.controller.check();
    await h.controller.install();

    const failing = { ...h.provider, relaunch: () => Promise.reject(new Error("no")) };
    const controller = createUpdateController({ provider: failing, clock: h.clock, log: silentLog });
    await controller.restart();

    assert.equal(h.controller.getSnapshot().status, "ready");
  });
});

describe("the prompt", () => {
  it("Later puts an offered release aside without asking the source again", async () => {
    const h = harness();
    h.provider.answerAvailable("2026.1005.900");
    await h.controller.check();

    h.controller.dismiss();
    assert.equal(h.controller.getSnapshot().promptOpen, false);
    assert.equal(h.controller.getSnapshot().status, "idle");
    assert.equal(h.controller.getSnapshot().release?.version, "2026.1005.900", "the release is kept");

    h.controller.open();
    assert.equal(h.controller.getSnapshot().promptOpen, true);
    assert.equal(h.provider.calls.check, 1, "reopening must not ask again");
  });

  it("Later on an installed update leaves it installed", async () => {
    const h = harness();
    h.provider.answerAvailable("2026.1005.900");
    await h.controller.check();
    await h.controller.install();

    h.controller.dismiss();
    assert.equal(h.controller.getSnapshot().status, "ready");
    assert.equal(h.controller.getSnapshot().promptOpen, false);
  });

  it("a release put aside can still be installed after reopening", async () => {
    const h = harness();
    h.provider.answerAvailable("2026.1005.900");
    await h.controller.check();
    h.controller.dismiss();

    await h.controller.check({ manual: true });
    await h.controller.install();

    assert.equal(h.controller.getSnapshot().status, "ready");
  });
});

describe("the startup check", () => {
  it("waits before asking, so the window is responsive first", async () => {
    const h = harness();
    h.provider.answerUpToDate();

    h.controller.start();
    assert.equal(h.provider.calls.check, 0, "it must not ask while the shell is still starting");

    await h.clock.advance(STARTUP_CHECK_DELAY_MS);
    assert.equal(h.provider.calls.check, 1);
    assert.equal(h.controller.getSnapshot().manual, false);
  });

  it("only happens once however often start is called", async () => {
    const h = harness();
    h.provider.answerUpToDate();

    h.controller.start();
    h.controller.start();
    h.controller.start();
    await h.clock.advance(STARTUP_CHECK_DELAY_MS);

    assert.equal(h.provider.calls.check, 1);
  });

  it("does not ask at all when the setting is off", async () => {
    const h = harness({ checkOnStartup: false });
    h.controller.start();
    await h.clock.advance(STARTUP_CHECK_DELAY_MS * 2);

    assert.equal(h.provider.calls.check, 0);
    assert.equal(h.controller.getSnapshot().status, "idle");
    assert.equal(h.clock.pendingTimers(), 0);
  });

  it("does not ask when the build cannot update itself", async () => {
    const h = harness({ available: false });
    h.controller.start();
    await h.clock.advance(STARTUP_CHECK_DELAY_MS * 2);

    assert.equal(h.provider.calls.check, 0);
    assert.equal(h.controller.getSnapshot().status, "idle", "and it says nothing about it either");
  });

  it("offline at startup leaves the application completely usable and silent", async () => {
    const h = harness();
    h.provider.answerFailure(new Error("error sending request"));

    h.controller.start();
    await h.clock.advance(STARTUP_CHECK_DELAY_MS);

    assert.equal(h.controller.getSnapshot().promptOpen, false);
    assert.equal(h.controller.getSnapshot().error?.code, "NETWORK_UNAVAILABLE");
  });
});

describe("disposal", () => {
  it("cancels the pending startup check", async () => {
    const h = harness();
    h.controller.start();
    h.controller.dispose();
    await h.clock.advance(STARTUP_CHECK_DELAY_MS * 2);

    assert.equal(h.provider.calls.check, 0);
    assert.equal(h.clock.pendingTimers(), 0);
  });

  it("releases a held release", async () => {
    const h = harness();
    h.provider.answerAvailable("2026.1005.900");
    await h.controller.check();

    h.controller.dispose();
    assert.equal(h.provider.calls.close, 1);
  });

  it("does nothing after it is disposed", async () => {
    const h = harness();
    h.controller.dispose();
    await h.controller.check({ manual: true });
    await h.controller.install();

    assert.equal(h.provider.calls.check, 0);
    assert.equal(h.controller.getSnapshot().status, "idle");
  });

  it("is safe to dispose twice", () => {
    const h = harness();
    h.controller.dispose();
    h.controller.dispose();
  });
});

describe("what the UI is allowed to know about the updater", () => {
  it("reports the fixed source and never a way to change it", () => {
    const h = harness();
    assert.equal(h.controller.provider.source, "test://releases");
    assert.equal(h.controller.provider.available, true);
    assert.equal(Object.keys(h.controller).includes("setSource"), false);
  });
});
