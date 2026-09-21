import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createDiagnosticLog,
  createDiagnosticReporter,
  filterByCategory,
  reportDiagnostic,
  toDiagnosticEntry,
} from "@/features/diagnostics/diagnostics";
import { logger, subscribeToLogs, type LogEntry } from "@/lib/logger";

/** Collects what reaches the one log stream while `run` executes. */
function capture(run: () => void): LogEntry[] {
  const entries: LogEntry[] = [];
  const stop = subscribeToLogs((entry) => entries.push(entry));
  try {
    run();
  } finally {
    stop();
  }
  return entries;
}

describe("reporting a diagnostic", () => {
  test("a diagnostic is one entry in the one log stream, with its structure attached", () => {
    const [entry, ...rest] = capture(() =>
      reportDiagnostic({
        severity: "warn",
        category: "Explorer",
        message: "An object names a parent that was not reported.",
        code: "EXPLORER_MISSING_PARENT",
        source: "explorerController",
        objectId: "orphan",
      }),
    );

    assert.equal(rest.length, 0);
    assert.equal(entry?.level, "warn");
    assert.equal(entry?.message, "An object names a parent that was not reported.");
    assert.deepEqual(entry?.meta, {
      category: "Explorer",
      code: "EXPLORER_MISSING_PARENT",
      source: "explorerController",
      objectId: "orphan",
    });
    assert.ok(typeof entry?.timestamp === "number");
  });

  test("the optional fields are left out rather than sent as undefined", () => {
    const [entry] = capture(() => reportDiagnostic({ severity: "info", category: "System", message: "Ready." }));
    assert.deepEqual(entry?.meta, { category: "System" });
  });

  test("technical context travels as data, beside the message", () => {
    const [entry] = capture(() =>
      reportDiagnostic({ severity: "error", category: "Target", message: "Failed." }, { attempt: 2 }),
    );
    assert.deepEqual(entry?.data, { attempt: 2 });
  });

  test("a plain log line stays plain, so nothing else had to change", () => {
    const [entry] = capture(() => logger.info("Just a line"));
    assert.equal(entry?.meta, undefined);
    assert.equal(toDiagnosticEntry(entry as LogEntry), null);
  });
});

describe("bound reporters", () => {
  test("a reporter states its category and source once, then only the message", () => {
    const report = createDiagnosticReporter("Explorer", "explorerPanel");
    const [entry] = capture(() => report.warn("The clipboard refused the copy.", { code: "CLIPBOARD_UNAVAILABLE" }));

    assert.equal(entry?.level, "warn");
    assert.deepEqual(entry?.meta, {
      category: "Explorer",
      code: "CLIPBOARD_UNAVAILABLE",
      source: "explorerPanel",
    });
  });

  test("each severity reaches the stream at that severity", () => {
    const report = createDiagnosticReporter("System");
    const entries = capture(() => {
      report.info("one");
      report.warn("two");
      report.error("three");
    });
    assert.deepEqual(entries.map((entry) => entry.level), ["info", "warn", "error"]);
  });

  test("a logger-shaped log tags messages without changing them", () => {
    const log = createDiagnosticLog("Target", "targetController");
    const [entry] = capture(() => log.info("Injection started", "Provider: Local Test Target"));

    assert.equal(entry?.message, "Injection started");
    assert.equal(entry?.data, "Provider: Local Test Target");
    assert.deepEqual(entry?.meta, { category: "Target", source: "targetController" });
  });
});

describe("reading diagnostics back", () => {
  const entries = (): LogEntry[] =>
    capture(() => {
      createDiagnosticReporter("Explorer", "explorerController").warn("Repaired.", { code: "EXPLORER_MISSING_PARENT" });
      createDiagnosticLog("Target").info("Injection started");
      logger.info("A plain line");
    });

  test("only the structured entries come back as diagnostics", () => {
    const diagnostics = entries()
      .map(toDiagnosticEntry)
      .filter((entry) => entry !== null);
    assert.deepEqual(diagnostics.map((entry) => entry.category), ["Explorer", "Target"]);
  });

  test("a diagnostic keeps the log entry's id and time, so both views agree", () => {
    const captured = entries();
    const first = toDiagnosticEntry(captured[0] as LogEntry);
    assert.equal(first?.id, captured[0]?.id);
    assert.equal(first?.timestamp, captured[0]?.timestamp);
  });

  test("a category the application does not define is not treated as a diagnostic", () => {
    const [entry] = capture(() => logger.report("info", "Odd", { category: "Nonsense" }));
    assert.equal(toDiagnosticEntry(entry as LogEntry), null);
  });

  test("filtering by category leaves plain log lines out", () => {
    const captured = entries();
    assert.equal(filterByCategory(captured, "Target").length, 1);
    assert.equal(filterByCategory(captured, "Explorer").length, 1);
    assert.equal(filterByCategory(captured, "Editor").length, 0);
    assert.equal(filterByCategory(captured, null).length, captured.length);
  });

  test("a diagnostic keeps its code and source, and leaves out what it was not given", () => {
    const captured = entries();
    const withCode = toDiagnosticEntry(captured[0] as LogEntry);
    const withoutCode = toDiagnosticEntry(captured[1] as LogEntry);

    assert.equal(withCode?.code, "EXPLORER_MISSING_PARENT");
    assert.equal(withCode?.source, "explorerController");
    assert.equal(withoutCode?.code, undefined);
    assert.equal(withoutCode?.source, undefined);
  });
});
