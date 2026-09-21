/**
 * The release identifier, and the one place the tag, the version and what the
 * user reads about their build are tied together.
 *
 * Nova has no marketing version. A release is identified by when it was built,
 * because that is the only fact about it that is always true and always
 * increases: the GitHub tag is `release-YYYY-MM-DD-HHMM`, and the version the
 * build actually reports is the same instant written as `YYYY.MMDD.HHMM`.
 *
 * The second form exists because the updater compares *versions*, not tags, and
 * it compares them as semantic versions. `YYYY.MMDD.HHMM` is a valid semantic
 * version whose ordering is the ordering of the instants it is built from:
 *
 * ```text
 * release-2026-09-21-1350  →  2026.921.1350
 * release-2026-10-05-0900  →  2026.1005.900
 * release-2027-01-02-0000  →  2027.102.0
 * ```
 *
 * The minor carries `MMDD` and the patch `HHMM`, so a later day is always a
 * larger minor within a year and a later minute always a larger patch within a
 * day — which is exactly what "is there a newer release?" has to mean. Nothing
 * here is shown to the user as `2026.921.1350`: {@link formatBuildId} turns it
 * back into the date and time it came from.
 */

/** The tag shape a release is published under. */
export const RELEASE_TAG_PATTERN = /^release-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})$/;

/** The version shape {@link versionFromReleaseTag} produces. */
const RELEASE_VERSION_PATTERN = /^(\d{4})\.(\d{1,4})\.(\d{1,4})$/;

export interface BuildInstant {
  readonly year: number;
  /** 1-12. */
  readonly month: number;
  /** 1-31. */
  readonly day: number;
  /** 0-23. */
  readonly hour: number;
  /** 0-59. */
  readonly minute: number;
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/**
 * True when the parts describe a real minute of a real day. February is allowed
 * 29 days in every year: a release tag is not a calendar, and rejecting a valid
 * build because of a leap-year rule would be worse than accepting 29 February
 * in a year that has none.
 */
function isRealInstant({ year, month, day, hour, minute }: BuildInstant): boolean {
  if (year < 2000 || year > 9999) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > DAYS_IN_MONTH[month - 1]!) return false;
  if (hour > 23 || minute > 59) return false;
  return true;
}

/**
 * The version a release tag builds under, or null when the tag is not a Nova
 * release tag. The caller decides what to do about null; nothing here guesses.
 */
export function versionFromReleaseTag(tag: string): string | null {
  const match = RELEASE_TAG_PATTERN.exec(tag.trim());
  if (match === null) return null;

  const [, year, month, day, hour, minute] = match as unknown as [string, string, string, string, string, string];
  const instant: BuildInstant = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
  };
  if (!isRealInstant(instant)) return null;

  // Number() drops the leading zeros a semantic version may not carry: a build
  // at 09:00 is patch 900, and one at midnight is patch 0.
  return `${instant.year}.${Number(`${month}${day}`)}.${Number(`${hour}${minute}`)}`;
}

/**
 * The instant a release version was built at, or null when the version did not
 * come from a release tag — a development build (`0.1.0`), for instance.
 */
export function buildInstantFromVersion(version: string): BuildInstant | null {
  const match = RELEASE_VERSION_PATTERN.exec(version.trim());
  if (match === null) return null;

  const [, year, monthDay, hourMinute] = match as unknown as [string, string, string, string];
  const date = monthDay.padStart(4, "0");
  const time = hourMinute.padStart(4, "0");

  const instant: BuildInstant = {
    year: Number(year),
    month: Number(date.slice(0, 2)),
    day: Number(date.slice(2, 4)),
    hour: Number(time.slice(0, 2)),
    minute: Number(time.slice(2, 4)),
  };
  return isRealInstant(instant) ? instant : null;
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/**
 * What a build is called on screen: the date and time it was built, in UTC,
 * because that is what the tag records and a local rendering would make two
 * machines disagree about which build they are running.
 *
 * A version that did not come from a release tag is returned unchanged, so a
 * development build reads as `0.1.0` rather than as a date it never had.
 */
export function formatBuildId(version: string): string {
  const instant = buildInstantFromVersion(version);
  if (instant === null) return version;

  return `${instant.year}-${pad(instant.month)}-${pad(instant.day)} ${pad(instant.hour)}:${pad(instant.minute)} UTC`;
}

/** True when this version was produced by a release tag rather than by a local build. */
export function isReleaseVersion(version: string): boolean {
  return buildInstantFromVersion(version) !== null;
}
