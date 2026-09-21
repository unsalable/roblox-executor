import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHECKABLE_STATUSES,
  canTransitionUpdate,
  classifyUpdateError,
  InvalidUpdateTransitionError,
  isUpdateBusy,
  isUpdateInstalling,
  shouldReportFailure,
  transitionUpdate,
  UPDATE_STATUSES,
  updateError,
} from "@/features/updates/updateState";
import type { UpdateErrorCode, UpdateStatus } from "@/features/updates/types";

describe("the update state machine", () => {
  it("starts nowhere but idle", () => {
    assert.ok(UPDATE_STATUSES.includes("idle"));
  });

  it("allows the whole successful path and nothing that skips a step", () => {
    const path: readonly UpdateStatus[] = ["idle", "checking", "available", "downloading", "installing", "ready"];
    for (let index = 1; index < path.length; index += 1) {
      assert.ok(canTransitionUpdate(path[index - 1]!, path[index]!), `${path[index - 1]} → ${path[index]}`);
    }

    assert.equal(canTransitionUpdate("idle", "available"), false);
    assert.equal(canTransitionUpdate("idle", "downloading"), false);
    assert.equal(canTransitionUpdate("checking", "downloading"), false);
    assert.equal(canTransitionUpdate("available", "installing"), false);
    assert.equal(canTransitionUpdate("downloading", "ready"), false);
  });

  it("lets a check fail but never lets it install", () => {
    assert.ok(canTransitionUpdate("checking", "error"));
    assert.equal(canTransitionUpdate("checking", "ready"), false);
  });

  it("lets a download and an install fail", () => {
    assert.ok(canTransitionUpdate("downloading", "error"));
    assert.ok(canTransitionUpdate("installing", "error"));
  });

  it("makes an installed update terminal, because the running build is the old one", () => {
    for (const status of UPDATE_STATUSES) {
      assert.equal(canTransitionUpdate("ready", status), false, `ready → ${status}`);
    }
  });

  it("lets a failure be retried from where it happened", () => {
    assert.ok(canTransitionUpdate("error", "checking"));
    assert.ok(canTransitionUpdate("error", "available"));
  });

  it("lets Later put an offered release back to idle without losing it", () => {
    assert.ok(canTransitionUpdate("available", "idle"));
  });

  it("throws rather than silently applying an impossible transition", () => {
    assert.throws(() => transitionUpdate("idle", "ready"), InvalidUpdateTransitionError);
    assert.equal(transitionUpdate("idle", "checking"), "checking");
  });

  it("agrees with itself about which statuses can start a check", () => {
    for (const status of UPDATE_STATUSES) {
      assert.equal(
        CHECKABLE_STATUSES.includes(status),
        canTransitionUpdate(status, "checking"),
        `${status} should ${canTransitionUpdate(status, "checking") ? "" : "not "}be checkable`,
      );
    }
  });

  it("knows when it is busy and when it must not be interrupted", () => {
    assert.deepEqual(UPDATE_STATUSES.filter(isUpdateBusy), ["checking", "downloading", "installing"]);
    assert.deepEqual(UPDATE_STATUSES.filter(isUpdateInstalling), ["downloading", "installing"]);
  });
});

describe("what a failing updater actually failed at", () => {
  const cases: readonly [string, UpdateErrorCode][] = [
    // Signature, and everything that means one.
    ["Signature verification failed", "SIGNATURE_INVALID"],
    ["failed to verify the signature of the update", "SIGNATURE_INVALID"],
    ["minisign: invalid signature", "SIGNATURE_INVALID"],
    ["the public key does not match", "SIGNATURE_INVALID"],
    ["untrusted comment mismatch", "SIGNATURE_INVALID"],
    // Network.
    ["error sending request for url (https://github.com/...)", "NETWORK_UNAVAILABLE"],
    ["failed to lookup address information: Temporary failure in name resolution", "NETWORK_UNAVAILABLE"],
    ["tcp connect error: No route to host", "NETWORK_UNAVAILABLE"],
    ["operation timed out", "NETWORK_UNAVAILABLE"],
    ["dns error", "NETWORK_UNAVAILABLE"],
    // Malformed release metadata.
    ["error decoding response body: expected value at line 1 column 1", "RELEASE_MALFORMED"],
    ["invalid release: missing field `version`", "RELEASE_MALFORMED"],
    ["unexpected end of JSON input", "RELEASE_MALFORMED"],
    // Download.
    ["download failed: incomplete body", "DOWNLOAD_FAILED"],
    ["content length mismatch", "DOWNLOAD_FAILED"],
    // Install.
    ["failed to run the NSIS installer", "INSTALL_FAILED"],
    ["installer exited with exit code 1", "INSTALL_FAILED"],
    ["Access is denied. (os error 5)", "INSTALL_FAILED"],
  ];

  for (const [message, code] of cases) {
    it(`reads "${message.slice(0, 48)}" as ${code}`, () => {
      assert.equal(classifyUpdateError(new Error(message)).code, code);
    });
  }

  it("keeps a tampered artifact apart from a plain download problem", () => {
    // Both words appear; the signature is the one that matters.
    assert.equal(classifyUpdateError(new Error("download failed: signature verification failed")).code, "SIGNATURE_INVALID");
  });

  it("admits it does not know rather than guessing", () => {
    const failure = classifyUpdateError(new Error("something nobody has seen before"));
    assert.equal(failure.code, "CHECK_FAILED");
    assert.equal(failure.details, "something nobody has seen before");
  });

  it("keeps the original text so the user has something to report", () => {
    assert.equal(classifyUpdateError(new Error("Signature verification failed")).details, "Signature verification failed");
    assert.equal(classifyUpdateError("plain string failure").details, "plain string failure");
  });

  it("never produces [object Object] from a thrown non-error", () => {
    const failure = classifyUpdateError({ kind: "weird" });
    assert.ok(!failure.details?.includes("[object Object]"));
    assert.ok(failure.details?.includes("weird"));
  });

  it("always carries a sentence for the UI", () => {
    for (const [message] of cases) {
      const failure = classifyUpdateError(new Error(message));
      assert.ok(failure.message.length > 0);
      assert.ok(!failure.message.includes("undefined"));
    }
  });

  it("says plainly that a bad signature was not installed", () => {
    assert.match(classifyUpdateError(new Error("signature")).message, /not installed/);
  });
});

describe("which failures the user is shown", () => {
  const codes: readonly UpdateErrorCode[] = [
    "UPDATER_UNAVAILABLE",
    "NETWORK_UNAVAILABLE",
    "RELEASE_MALFORMED",
    "SIGNATURE_INVALID",
    "DOWNLOAD_FAILED",
    "INSTALL_FAILED",
    "CHECK_FAILED",
  ];

  it("shows every failure the user asked for", () => {
    for (const code of codes) {
      assert.equal(shouldReportFailure(updateError(code), true), true, code);
    }
  });

  it("stays silent about being offline when Nova asked by itself", () => {
    assert.equal(shouldReportFailure(updateError("NETWORK_UNAVAILABLE"), false), false);
    assert.equal(shouldReportFailure(updateError("UPDATER_UNAVAILABLE"), false), false);
  });

  it("still reports a bad signature found by a check nobody asked for", () => {
    assert.equal(shouldReportFailure(updateError("SIGNATURE_INVALID"), false), true);
    assert.equal(shouldReportFailure(updateError("RELEASE_MALFORMED"), false), true);
  });

  it("carries details only when there are some", () => {
    assert.equal(updateError("CHECK_FAILED").details, undefined);
    assert.equal(updateError("CHECK_FAILED", "why").details, "why");
  });
});
