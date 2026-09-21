import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { explorerClassIcon } from "@/features/explorer/classIcons";
import { buildExplorerModel } from "@/features/explorer/explorerModel";
import {
  describePropertyValue,
  formatPropertyValue,
  groupProperties,
  summarizeNode,
  ungroupedProperties,
} from "@/features/explorer/properties";
import { createMockExplorerProvider } from "@/features/explorer/providers/MockExplorerProvider";
import type { ExplorerProperty, ExplorerPropertyGroup } from "@/features/explorer/types";

const property = (
  name: string,
  group: ExplorerPropertyGroup,
  value: ExplorerProperty["value"],
): ExplorerProperty => ({ id: `${group}.${name}`, name, group, value, readOnly: true });

describe("property formatting", () => {
  test("strings are shown as they are", () => {
    assert.equal(formatPropertyValue({ kind: "string", value: "Camera" }), "Camera");
    assert.equal(formatPropertyValue({ kind: "string", value: "" }), "");
  });

  test("whole numbers keep no decimal point", () => {
    assert.equal(formatPropertyValue({ kind: "number", value: 70 }), "70");
    assert.equal(formatPropertyValue({ kind: "number", value: -3 }), "-3");
    assert.equal(formatPropertyValue({ kind: "number", value: 0 }), "0");
  });

  test("fractions are rounded rather than shown in full", () => {
    assert.equal(formatPropertyValue({ kind: "number", value: 196.2 }), "196.2");
    assert.equal(formatPropertyValue({ kind: "number", value: 1 / 3 }), "0.333");
  });

  test("a unit is appended, not folded into the number", () => {
    assert.equal(formatPropertyValue({ kind: "number", value: 5, unit: "s" }), "5 s");
  });

  test("numbers that are not finite say so instead of printing NaN", () => {
    assert.equal(formatPropertyValue({ kind: "number", value: Number.POSITIVE_INFINITY }), "∞");
    assert.equal(formatPropertyValue({ kind: "number", value: Number.NEGATIVE_INFINITY }), "-∞");
    assert.equal(formatPropertyValue({ kind: "number", value: Number.NaN }), "—");
  });

  test("booleans read as true and false", () => {
    assert.equal(formatPropertyValue({ kind: "boolean", value: true }), "true");
    assert.equal(formatPropertyValue({ kind: "boolean", value: false }), "false");
  });

  test("an enum shows the value it holds now", () => {
    assert.equal(formatPropertyValue({ kind: "enum", value: "Custom", options: ["Fixed", "Custom"] }), "Custom");
  });

  test("a vector is its components, comma separated", () => {
    assert.equal(formatPropertyValue({ kind: "vector", value: [0, 10, 0], axes: ["X", "Y", "Z"] }), "0, 10, 0");
    assert.equal(formatPropertyValue({ kind: "vector", value: [], axes: [] }), "");
  });

  test("a value the provider cannot report is a dash, never a guess", () => {
    assert.equal(formatPropertyValue({ kind: "unknown" }), "—");
  });
});

describe("property descriptions", () => {
  test("a vector's description names its axes", () => {
    const value = property("Position", "Transform", { kind: "vector", value: [1, 2.5, 3], axes: ["X", "Y", "Z"] });
    assert.equal(describePropertyValue(value), "X 1  Y 2.5  Z 3");
  });

  test("an enum's description lists what else it could be", () => {
    const value = property("CameraType", "Data", { kind: "enum", value: "Custom", options: ["Fixed", "Custom"] });
    assert.equal(describePropertyValue(value), "Custom — one of Fixed, Custom");
  });

  test("an unknown value explains itself", () => {
    assert.equal(describePropertyValue(property("X", "Data", { kind: "unknown" })), "The provider does not report this value.");
  });

  test("anything else describes itself the way it is shown", () => {
    assert.equal(describePropertyValue(property("Name", "Identity", { kind: "string", value: "Camera" })), "Camera");
  });
});

describe("property grouping", () => {
  const properties = [
    property("Enabled", "State", { kind: "boolean", value: true }),
    property("Name", "Identity", { kind: "string", value: "Camera" }),
    property("Position", "Transform", { kind: "vector", value: [0, 0, 0], axes: ["X", "Y", "Z"] }),
    property("Class", "Identity", { kind: "string", value: "Camera" }),
  ];

  test("groups come in inspector order, whatever order the properties arrived in", () => {
    assert.deepEqual(
      groupProperties(properties).map((entry) => entry.group),
      ["Identity", "Transform", "State"],
    );
  });

  test("properties keep the order the provider listed them in", () => {
    const identity = groupProperties(properties)[0];
    assert.deepEqual(identity?.properties.map((entry) => entry.name), ["Name", "Class"]);
  });

  test("a group with nothing in it is left out", () => {
    assert.ok(groupProperties(properties).every((entry) => entry.group !== "Appearance"));
    assert.deepEqual(groupProperties([]), []);
  });

  test("a group the inspector does not know is kept, not hidden", () => {
    const odd = { ...property("Odd", "Identity", { kind: "string", value: "x" }), group: "Custom" as ExplorerPropertyGroup };
    assert.deepEqual(ungroupedProperties([...properties, odd]).map((entry) => entry.name), ["Odd"]);
    assert.deepEqual(ungroupedProperties(properties), []);
  });
});

describe("object summary", () => {
  const model = buildExplorerModel(createMockExplorerProvider().read());

  test("an object with children counts them", () => {
    const node = model.nodes.get("environment");
    assert.ok(node);
    assert.equal(summarizeNode(node), "Folder · 2 properties · 2 children");
  });

  test("a leaf says nothing about children", () => {
    const node = model.nodes.get("lighting");
    assert.ok(node);
    assert.equal(summarizeNode(node), "Lighting · 7 properties");
  });

  test("one child and one property are written in the singular", () => {
    const single = buildExplorerModel([
      {
        id: "parent",
        name: "Parent",
        className: "Folder",
        parentId: null,
        properties: [property("Name", "Identity", { kind: "string", value: "Parent" })],
      },
      { id: "child", name: "Child", className: "Part", parentId: "parent" },
    ]);
    const node = single.nodes.get("parent");
    assert.ok(node);
    assert.equal(summarizeNode(node), "Folder · 1 property · 1 child");
  });
});

describe("class icons", () => {
  test("known classes get their own glyph", () => {
    assert.equal(explorerClassIcon("Camera"), "camera");
    assert.equal(explorerClassIcon("Part"), "cube");
    assert.equal(explorerClassIcon("Folder"), "folder");
  });

  test("a class nobody listed falls back rather than being hidden", () => {
    assert.equal(explorerClassIcon("SurfaceGui"), "object");
    assert.equal(explorerClassIcon(""), "object");
  });

  test("a class named after something on Object's prototype still falls back", () => {
    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
      assert.equal(explorerClassIcon(name), "object", `${name} must not resolve to an inherited member`);
    }
  });

  test("every class the mock reports has an icon", () => {
    for (const entry of createMockExplorerProvider().read()) {
      assert.equal(typeof explorerClassIcon(entry.className), "string");
    }
  });
});

describe("the mock provider's data", () => {
  test("every property is read-only, because there is nothing to write to", () => {
    for (const entry of createMockExplorerProvider().read()) {
      for (const property of entry.properties ?? []) {
        assert.equal(property.readOnly, true, `${entry.name}.${property.name} must be read-only`);
      }
    }
  });

  test("every object reports its name and class the same way the tree does", () => {
    for (const entry of createMockExplorerProvider().read()) {
      const identity = (entry.properties ?? []).filter((property) => property.group === "Identity");
      const name = identity.find((property) => property.name === "Name");
      const className = identity.find((property) => property.name === "Class");
      assert.equal(name && formatPropertyValue(name.value), entry.name);
      assert.equal(className && formatPropertyValue(className.value), entry.className);
    }
  });

  test("property ids are unique within an object", () => {
    for (const entry of createMockExplorerProvider().read()) {
      const ids = (entry.properties ?? []).map((property) => property.id);
      assert.equal(new Set(ids).size, ids.length, `${entry.name} has a duplicate property id`);
    }
  });

  test("the provider says it is a mock, so the UI can say so too", () => {
    const provider = createMockExplorerProvider();
    assert.equal(provider.mock, true);
    assert.match(provider.description, /No game, process or file is read\./);
  });
});
