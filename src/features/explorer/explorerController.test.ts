import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DiagnosticDetails, DiagnosticReporter } from "@/features/diagnostics/diagnostics";
import { createExplorerController, type ExplorerController } from "@/features/explorer/explorerController";
import { explorerPath, formatExplorerPath } from "@/features/explorer/explorerModel";
import type { ExplorerNodeData, ExplorerProvider } from "@/features/explorer/types";

/**
 * A provider under the test's control: it reports whatever data the test set
 * last, and can announce that the hierarchy changed.
 */
function createTestProvider(data: readonly ExplorerNodeData[]) {
  let current = data;
  const listeners = new Set<() => void>();
  let reads = 0;

  const provider: ExplorerProvider = {
    label: "Test Explorer",
    providerType: "test",
    mock: true,
    description: "Objects written by the test.",
    read: () => {
      reads += 1;
      return current;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    provider,
    reads: () => reads,
    listenerCount: () => listeners.size,
    replace: (next: readonly ExplorerNodeData[]) => {
      current = next;
    },
    announce: () => {
      for (const listener of listeners) listener();
    },
  };
}

interface Reported extends DiagnosticDetails {
  severity: string;
  message: string;
}

function createRecorder(): DiagnosticReporter & { entries: Reported[] } {
  const entries: Reported[] = [];
  const record = (severity: string) => (message: string, details?: DiagnosticDetails) => {
    entries.push({ severity, message, ...details });
  };
  return {
    entries,
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
}

const node = (id: string, name: string, parentId: string | null): ExplorerNodeData => ({
  id,
  name,
  className: parentId === null ? "Workspace" : "Folder",
  parentId,
});

/**
 * root
 * ├── a
 * │   └── a1
 * └── b
 */
const SAMPLE: readonly ExplorerNodeData[] = [
  node("root", "Root", null),
  node("a", "A", "root"),
  node("a1", "A1", "a"),
  node("b", "B", "root"),
];

function setup(data: readonly ExplorerNodeData[] = SAMPLE) {
  const source = createTestProvider(data);
  const report = createRecorder();
  const controller = createExplorerController({ provider: source.provider, report });
  return { controller, report, ...source };
}

const expanded = (controller: ExplorerController) => [...controller.getSnapshot().expandedIds].sort();

describe("explorer controller", () => {
  test("the first read opens the roots and selects nothing", () => {
    const { controller } = setup();
    assert.equal(controller.getSnapshot().model.count, 4);
    assert.deepEqual(expanded(controller), ["root"]);
    assert.equal(controller.getSnapshot().selectedId, null);
  });

  test("the provider's metadata is exposed without the provider itself", () => {
    const { controller } = setup();
    assert.deepEqual(controller.provider, {
      label: "Test Explorer",
      providerType: "test",
      mock: true,
      description: "Objects written by the test.",
    });
  });

  test("the snapshot only changes when something did", () => {
    const { controller } = setup();
    const before = controller.getSnapshot();
    controller.select(null);
    assert.equal(controller.getSnapshot(), before);
    controller.select("a");
    assert.notEqual(controller.getSnapshot(), before);
  });
});

describe("explorer selection", () => {
  test("selecting an object publishes it to subscribers", () => {
    const { controller } = setup();
    let published = 0;
    const stop = controller.subscribe(() => (published += 1));

    controller.select("a1");
    assert.equal(controller.getSnapshot().selectedId, "a1");
    assert.equal(published, 1);

    // Selecting the same object again is not a change.
    controller.select("a1");
    assert.equal(published, 1);

    stop();
    controller.select("b");
    assert.equal(published, 1);
  });

  test("clearing puts the selection back to nothing", () => {
    const { controller } = setup();
    controller.select("b");
    controller.clearSelection();
    assert.equal(controller.getSnapshot().selectedId, null);

    // Clearing twice is not a change.
    let published = 0;
    controller.subscribe(() => (published += 1));
    controller.clearSelection();
    assert.equal(published, 0);
  });

  test("selecting null clears the selection", () => {
    const { controller } = setup();
    controller.select("a");
    controller.select(null);
    assert.equal(controller.getSnapshot().selectedId, null);
  });

  test("an object that is not in the hierarchy clears the selection and is reported", () => {
    const { controller, report } = setup();
    controller.select("a");
    controller.select("ghost");

    assert.equal(controller.getSnapshot().selectedId, null);
    const entry = report.entries.at(-1);
    assert.equal(entry?.code, "EXPLORER_UNKNOWN_OBJECT");
    assert.equal(entry?.objectId, "ghost");
  });

  test("the selection is the object the path is built from", () => {
    const { controller } = setup();
    controller.select("a1");
    const { model, selectedId } = controller.getSnapshot();
    assert.equal(formatExplorerPath(explorerPath(model, selectedId)), "Root / A / A1");
  });
});

describe("explorer expansion", () => {
  test("expanding and collapsing one object", () => {
    const { controller } = setup();
    controller.setExpanded("a", true);
    assert.deepEqual(expanded(controller), ["a", "root"]);
    controller.setExpanded("a", false);
    assert.deepEqual(expanded(controller), ["root"]);
  });

  test("toggling flips whatever the object is now", () => {
    const { controller } = setup();
    controller.toggleExpanded("a");
    assert.equal(controller.isExpanded("a"), true);
    controller.toggleExpanded("a");
    assert.equal(controller.isExpanded("a"), false);
  });

  test("an object with no children cannot be expanded", () => {
    const { controller } = setup();
    controller.setExpanded("b", true);
    assert.equal(controller.isExpanded("b"), false);
  });

  test("an object that is not in the hierarchy cannot be expanded", () => {
    const { controller } = setup();
    controller.setExpanded("ghost", true);
    assert.equal(controller.isExpanded("ghost"), false);
  });

  test("a root with no children is not opened just for being a root", () => {
    const { controller } = setup([node("lonely", "Lonely", null), node("p", "P", null), node("c", "C", "p")]);
    assert.deepEqual(expanded(controller), ["p"]);
  });

  test("an object that loses its children stops claiming to be open", () => {
    const { controller, replace } = setup();
    controller.setExpanded("a", true);
    assert.equal(controller.isExpanded("a"), true);

    replace([node("root", "Root", null), node("a", "A", "root"), node("b", "B", "root")]);
    controller.reload();

    assert.equal(controller.isExpanded("a"), false);
  });

  test("Expand All opens every object that has children, and nothing else", () => {
    const { controller } = setup();
    controller.expandAll();
    assert.deepEqual(expanded(controller), ["a", "root"]);
  });

  test("Collapse All closes everything, including the roots", () => {
    const { controller } = setup();
    controller.expandAll();
    controller.collapseAll();
    assert.deepEqual(expanded(controller), []);
  });

  test("revealing opens the objects above one without selecting it", () => {
    const { controller } = setup();
    controller.collapseAll();
    controller.reveal("a1");
    assert.deepEqual(expanded(controller), ["a", "root"]);
    assert.equal(controller.getSnapshot().selectedId, null);
  });

  test("Expand All opens what has children now, not what had children before", () => {
    // A hierarchy that changes shape can leave the same *number* of objects
    // expanded, so expansion has to be compared by identity rather than count.
    const { controller, replace } = setup();
    controller.expandAll();
    assert.deepEqual(expanded(controller), ["a", "root"]);

    replace([node("root", "Root", null), node("a", "A", "root"), node("b", "B", "root"), node("b1", "B1", "b")]);
    controller.reload();
    controller.expandAll();

    assert.deepEqual(expanded(controller), ["b", "root"]);
    assert.equal(controller.isExpanded("b"), true);
  });

  test("revealing an object that is not there changes nothing", () => {
    const { controller } = setup();
    const before = controller.getSnapshot();
    controller.reveal("ghost");
    assert.equal(controller.getSnapshot(), before);
  });
});

describe("explorer reload", () => {
  test("reading again keeps a selection whose object is still reported", () => {
    const { controller, replace, reads } = setup();
    controller.select("a1");
    controller.setExpanded("a", true);

    replace([...SAMPLE, node("c", "C", "root")]);
    controller.reload();

    assert.equal(reads(), 2);
    assert.equal(controller.getSnapshot().model.count, 5);
    assert.equal(controller.getSnapshot().selectedId, "a1");
    assert.deepEqual(expanded(controller), ["a", "root"]);
  });

  test("a selection whose object has gone is cleared and reported", () => {
    const { controller, replace, report } = setup();
    controller.select("a1");

    replace([node("root", "Root", null), node("b", "B", "root")]);
    controller.reload();

    assert.equal(controller.getSnapshot().selectedId, null);
    assert.ok(report.entries.some((entry) => entry.code === "EXPLORER_SELECTION_LOST"));
  });

  test("expansion is dropped for objects that are no longer reported", () => {
    const { controller, replace } = setup();
    controller.expandAll();

    replace([node("root", "Root", null), node("b", "B", "root")]);
    controller.reload();

    assert.deepEqual(expanded(controller), ["root"]);
  });

  test("a provider that announces a change is read again", () => {
    const { controller, replace, announce, reads } = setup();
    replace([node("root", "Root", null)]);
    announce();

    assert.equal(reads(), 2);
    assert.equal(controller.getSnapshot().model.count, 1);
  });

  test("a provider that throws leaves an empty hierarchy and reports it", () => {
    const report = createRecorder();
    const controller = createExplorerController({
      provider: {
        label: "Broken",
        providerType: "test",
        mock: true,
        description: "Throws.",
        read: () => {
          throw new Error("no data");
        },
        subscribe: () => () => undefined,
      },
      report,
    });

    assert.equal(controller.getSnapshot().model.count, 0);
    assert.ok(report.entries.some((entry) => entry.code === "EXPLORER_PROVIDER_FAILED"));
  });
});

describe("explorer diagnostics", () => {
  test("a repaired hierarchy is reported once per problem", () => {
    const { report } = setup([node("root", "Root", null), node("orphan", "Orphan", "missing")]);
    const missing = report.entries.filter((entry) => entry.code === "EXPLORER_MISSING_PARENT");
    assert.equal(missing.length, 1);
    assert.equal(missing[0]?.objectId, "orphan");
  });

  test("a hierarchy full of problems is summarized instead of flooding the log", () => {
    const broken = Array.from({ length: 9 }, (_, index) => node(`x${index}`, `X${index}`, "missing"));
    const { report } = setup(broken);

    assert.equal(report.entries.filter((entry) => entry.code === "EXPLORER_MISSING_PARENT").length, 5);
    const summary = report.entries.find((entry) => entry.code === "EXPLORER_ISSUES_TRUNCATED");
    assert.ok(summary?.message.startsWith("4 further"));
  });

  test("no diagnostic carries anything but identity: no names, no values", () => {
    const { report } = setup([node("root", "Root", null), node("orphan", "Orphan", "missing")]);
    for (const entry of report.entries) {
      assert.ok(!entry.message.includes("Orphan"));
    }
  });
});

describe("explorer disposal", () => {
  test("disposing stops listening to the provider and to subscribers", () => {
    const { controller, listenerCount, announce, reads } = setup();
    let published = 0;
    controller.subscribe(() => (published += 1));

    controller.dispose();
    assert.equal(listenerCount(), 0);

    announce();
    assert.equal(reads(), 1);
    assert.equal(published, 0);
  });
});
