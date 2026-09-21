// Stamps a release tag's version into the three files that carry a version, so
// the built application, the installer and the updater all report the same one.
//
// Nova has no marketing version: a release is identified by when it was built.
// `versionFromReleaseTag` turns the tag into the semantic version the updater
// compares — see src/app/releaseVersion.ts, which is where that scheme is
// defined and unit-tested. This script is the only writer of those three files'
// version fields, and it refuses a tag it does not recognise rather than
// guessing a version that could compare as older than the build already
// installed.
//
// Run through the TypeScript loader that `npm test` uses, so the rule lives in
// one tested module rather than being restated here:
//
//   npm run release:version -- release-2026-09-21-1350
//
// With no argument it reads GITHUB_REF_NAME, which is the tag on a tag push.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { versionFromReleaseTag } from "../src/app/releaseVersion.ts";

const root = new URL("../", import.meta.url);
const at = (relativePath) => fileURLToPath(new URL(relativePath, root));

const tag = (process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "").trim();
if (tag === "") {
  console.error("usage: npm run release:version -- release-YYYY-MM-DD-HHMM");
  process.exit(1);
}

const version = versionFromReleaseTag(tag);
if (version === null) {
  console.error(`"${tag}" is not a Nova release tag. Expected release-YYYY-MM-DD-HHMM, e.g. release-2026-09-21-1350.`);
  process.exit(1);
}

/** Replaces the first match of `pattern`, and fails loudly when there is none. */
function rewrite(path, pattern, replacement) {
  const file = at(path);
  const before = readFileSync(file, "utf8");
  const after = before.replace(pattern, replacement);
  if (after === before) {
    console.error(`${path}: nothing matched ${pattern}; the version could not be stamped.`);
    process.exit(1);
  }
  writeFileSync(file, after);
}

// The version the application reports. tauri.conf.json reads this file, so this
// is the one the binary, the installer and the updater's comparison all use.
rewrite("package.json", /("version"\s*:\s*)"[^"]*"/, `$1"${version}"`);

// The crate version. Tauri overrides it for the bundle, but leaving it behind
// would make `cargo` and the application disagree about what this build is.
rewrite("src-tauri/Cargo.toml", /^version = "[^"]*"$/m, `version = "${version}"`);

// Cargo.lock's own entry for this crate, so `cargo build --locked` still works.
rewrite(
  "src-tauri/Cargo.lock",
  /(\[\[package\]\]\nname = "nova"\nversion = )"[^"]*"/,
  `$1"${version}"`,
);

console.log(version);
