import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildInstantFromVersion,
  formatBuildId,
  isReleaseVersion,
  versionFromReleaseTag,
} from "@/app/releaseVersion";

describe("release tags become versions", () => {
  it("writes the instant as a semantic version", () => {
    assert.equal(versionFromReleaseTag("release-2026-09-21-1350"), "2026.921.1350");
  });

  it("drops the leading zeros a semantic version may not carry", () => {
    assert.equal(versionFromReleaseTag("release-2026-01-02-0900"), "2026.102.900");
    assert.equal(versionFromReleaseTag("release-2026-01-01-0000"), "2026.101.0");
  });

  it("keeps a four-digit month and day intact", () => {
    assert.equal(versionFromReleaseTag("release-2026-12-31-2359"), "2026.1231.2359");
  });

  it("ignores surrounding whitespace", () => {
    assert.equal(versionFromReleaseTag("  release-2026-09-21-1350\n"), "2026.921.1350");
  });

  it("refuses anything that is not a release tag", () => {
    for (const tag of ["v1.0.0", "1.0.0", "release", "release-2026-09-21", "release-2026-09-21-135", "nightly-2026-09-21-1350", ""]) {
      assert.equal(versionFromReleaseTag(tag), null, tag);
    }
  });

  it("refuses an instant that does not exist", () => {
    for (const tag of [
      "release-2026-13-01-1200",
      "release-2026-00-01-1200",
      "release-2026-09-31-1200",
      "release-2026-09-00-1200",
      "release-2026-09-21-2400",
      "release-2026-09-21-1360",
      "release-1999-09-21-1200",
    ]) {
      assert.equal(versionFromReleaseTag(tag), null, tag);
    }
  });

  it("accepts 29 February in any year rather than rejecting a real build", () => {
    assert.equal(versionFromReleaseTag("release-2026-02-29-1200"), "2026.229.1200");
    assert.equal(versionFromReleaseTag("release-2026-02-30-1200"), null);
  });
});

describe("release versions order the way the updater compares them", () => {
  /** The comparison the updater makes: numeric, major then minor then patch. */
  const compare = (a: string, b: string): number => {
    const left = a.split(".").map(Number);
    const right = b.split(".").map(Number);
    for (let index = 0; index < 3; index += 1) {
      const difference = (left[index] ?? 0) - (right[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return 0;
  };

  const ascending = [
    "release-2026-01-01-0000",
    "release-2026-01-01-0001",
    "release-2026-01-01-0900",
    "release-2026-01-02-0000",
    "release-2026-09-21-1350",
    "release-2026-10-05-0900",
    "release-2026-12-31-2359",
    "release-2027-01-02-0000",
  ].map((tag) => versionFromReleaseTag(tag)!);

  it("every later build is a larger version than the one before it", () => {
    for (let index = 1; index < ascending.length; index += 1) {
      const previous = ascending[index - 1]!;
      const current = ascending[index]!;
      assert.ok(compare(current, previous) > 0, `${current} should be newer than ${previous}`);
    }
  });

  it("a release build is always newer than the development version", () => {
    assert.ok(compare(ascending[0]!, "0.1.0") > 0);
  });
});

describe("versions become build identifiers", () => {
  it("reads a release version back as the instant it was built at", () => {
    assert.deepEqual(buildInstantFromVersion("2026.921.1350"), {
      year: 2026,
      month: 9,
      day: 21,
      hour: 13,
      minute: 50,
    });
  });

  it("restores the zeros that were dropped", () => {
    assert.deepEqual(buildInstantFromVersion("2026.102.900"), {
      year: 2026,
      month: 1,
      day: 2,
      hour: 9,
      minute: 0,
    });
  });

  it("round-trips every tag it accepts", () => {
    for (const tag of ["release-2026-09-21-1350", "release-2026-01-02-0900", "release-2026-12-31-2359", "release-2026-01-01-0000"]) {
      const version = versionFromReleaseTag(tag)!;
      const instant = buildInstantFromVersion(version)!;
      const rebuilt = `release-${instant.year}-${String(instant.month).padStart(2, "0")}-${String(instant.day).padStart(2, "0")}-${String(instant.hour).padStart(2, "0")}${String(instant.minute).padStart(2, "0")}`;
      assert.equal(rebuilt, tag);
    }
  });

  it("shows a release build as its date and time in UTC", () => {
    assert.equal(formatBuildId("2026.921.1350"), "2026-09-21 13:50 UTC");
    assert.equal(formatBuildId("2026.102.900"), "2026-01-02 09:00 UTC");
    assert.equal(formatBuildId("2026.101.0"), "2026-01-01 00:00 UTC");
  });

  it("leaves a version that never came from a tag exactly as it is", () => {
    for (const version of ["0.1.0", "test", "1.2.3", "", "2026.921"]) {
      assert.equal(formatBuildId(version), version);
      assert.equal(buildInstantFromVersion(version), null);
      assert.equal(isReleaseVersion(version), false);
    }
  });

  it("recognises a release version", () => {
    assert.equal(isReleaseVersion("2026.921.1350"), true);
    assert.equal(isReleaseVersion("0.1.0"), false);
  });

  it("refuses a version whose digits are not a real instant", () => {
    assert.equal(buildInstantFromVersion("2026.1301.1200"), null);
    assert.equal(buildInstantFromVersion("2026.921.2400"), null);
  });
});
