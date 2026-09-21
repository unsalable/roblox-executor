import type {
  ExplorerNodeData,
  ExplorerProperty,
  ExplorerPropertyGroup,
  ExplorerPropertyValue,
  ExplorerProvider,
} from "@/features/explorer/types";

/**
 * The local mock Explorer provider.
 *
 * Every object and every value below is written here, in this file. Nothing is
 * read from a game, a process, a file or a network endpoint, and the hierarchy
 * is the same on every launch — it exists so the Explorer, the inspector, the
 * search and the command palette have something real to operate on while the
 * data source is still a later decision. The UI says so wherever it shows it.
 */

const text = (value: string): ExplorerPropertyValue => ({ kind: "string", value });
const number = (value: number, unit?: string): ExplorerPropertyValue =>
  unit === undefined ? { kind: "number", value } : { kind: "number", value, unit };
const flag = (value: boolean): ExplorerPropertyValue => ({ kind: "boolean", value });
const choice = (value: string, options: readonly string[]): ExplorerPropertyValue => ({
  kind: "enum",
  value,
  options,
});
const vector3 = (x: number, y: number, z: number): ExplorerPropertyValue => ({
  kind: "vector",
  value: [x, y, z],
  axes: ["X", "Y", "Z"],
});

function property(
  group: ExplorerPropertyGroup,
  name: string,
  value: ExplorerPropertyValue,
  description?: string,
): ExplorerProperty {
  return {
    id: `${group}.${name}`,
    name,
    group,
    value,
    // Read-only throughout: there is nothing to write a change to, and an
    // editor that only changed this local copy would imply there was.
    readOnly: true,
    ...(description === undefined ? {} : { description }),
  };
}

/** Name and class, which every object has. */
const identity = (name: string, className: string): ExplorerProperty[] => [
  property("Identity", "Name", text(name)),
  property("Identity", "Class", text(className), "The class this object was reported as."),
];

interface MockNode {
  id: string;
  name: string;
  className: string;
  parentId: string | null;
  properties: ExplorerProperty[];
}

function node(
  id: string,
  name: string,
  className: string,
  parentId: string | null,
  properties: ExplorerProperty[] = [],
): MockNode {
  return { id, name, className, parentId, properties: [...identity(name, className), ...properties] };
}

/**
 * A fixed hierarchy, with enough leaves that the
 * inspector has more than one shape of object to show.
 */
const HIERARCHY: readonly MockNode[] = [
  node("workspace", "Workspace", "Workspace", null, [
    property("Data", "Gravity", number(196.2, "studs/s²")),
    property("State", "StreamingEnabled", flag(false)),
  ]),

  node("camera", "Camera", "Camera", "workspace", [
    property("Transform", "Position", vector3(0, 10, 0)),
    property("Transform", "Rotation", vector3(0, 0, 0)),
    property("Data", "FieldOfView", number(70, "°")),
    property("Data", "CameraType", choice("Custom", ["Fixed", "Attach", "Watch", "Track", "Follow", "Custom", "Scriptable"])),
    property("State", "Enabled", flag(true)),
  ]),

  node("baseplate", "Baseplate", "Part", "workspace", [
    property("Transform", "Position", vector3(0, -0.5, 0)),
    property("Transform", "Size", vector3(512, 20, 512)),
    property("Transform", "Rotation", vector3(0, 0, 0)),
    property("Appearance", "Material", choice("Plastic", ["Plastic", "Wood", "Slate", "Concrete", "Metal", "Grass"])),
    property("Appearance", "Color", text("103, 120, 140")),
    property("Appearance", "Transparency", number(0)),
    property("State", "Anchored", flag(true)),
    property("State", "CanCollide", flag(true)),
  ]),

  node("spawn", "SpawnLocation", "SpawnLocation", "workspace", [
    property("Transform", "Position", vector3(0, 10.5, 0)),
    property("Transform", "Size", vector3(12, 1, 12)),
    property("State", "Enabled", flag(true)),
    property("State", "Neutral", flag(true)),
    property("Data", "Duration", number(0, "s"), "Seconds of forcefield granted on spawn."),
  ]),

  node("environment", "Environment", "Folder", "workspace"),
  node("environment-folder", "Folder", "Folder", "environment"),
  node("lighting", "Lighting", "Lighting", "environment", [
    property("Appearance", "Ambient", text("0, 0, 0")),
    property("Appearance", "Brightness", number(2)),
    property("Appearance", "ClockTime", number(14.5, "h")),
    property("Appearance", "Technology", choice("ShadowMap", ["Legacy", "Voxel", "Compatibility", "ShadowMap", "Future"])),
    property("State", "GlobalShadows", flag(true)),
  ]),

  node("players", "Players", "Players", "workspace", [
    property("Data", "MaxPlayers", number(12)),
    property("Data", "RespawnTime", number(5, "s")),
    property("State", "CharacterAutoLoads", flag(true)),
  ]),

  node("replicated-storage", "ReplicatedStorage", "ReplicatedStorage", "workspace"),

  node("assets", "Assets", "Folder", "replicated-storage"),
  node("assets-crate", "Crate", "Model", "assets", [
    property("Transform", "Position", vector3(18, 3, -24)),
    property("Data", "PrimaryPart", text("Crate.Base")),
    property("State", "Archivable", flag(true)),
  ]),
  node("assets-ambience", "Ambience", "Sound", "assets", [
    property("Data", "Volume", number(0.35)),
    property("Data", "TimePosition", number(0, "s")),
    property("State", "Looped", flag(true)),
    property("State", "Playing", flag(false)),
  ]),

  node("modules", "Modules", "Folder", "replicated-storage"),
  node("modules-util", "Util", "ModuleScript", "modules", [
    property("Data", "RunContext", choice("Legacy", ["Legacy", "Server", "Client", "Plugin"])),
    property("State", "Archivable", flag(true)),
  ]),
  node("modules-config", "Config", "ModuleScript", "modules", [
    property("Data", "RunContext", choice("Legacy", ["Legacy", "Server", "Client", "Plugin"])),
    property("State", "Archivable", flag(true)),
  ]),
];

const MOCK_METADATA = { Source: "Local mock data", Provider: "Mock Explorer" } as const;

function toNodeData(entry: MockNode): ExplorerNodeData {
  return {
    id: entry.id,
    name: entry.name,
    className: entry.className,
    parentId: entry.parentId,
    properties: entry.properties,
    metadata: MOCK_METADATA,
  };
}

/**
 * The provider Nova ships with. It never changes after it is created, so
 * `subscribe` has nothing to report and returns an unsubscribe that does
 * nothing — the boundary exists for the provider that replaces this one.
 */
export function createMockExplorerProvider(): ExplorerProvider {
  const data = HIERARCHY.map(toNodeData);

  return {
    label: "Mock Explorer",
    providerType: "local-mock",
    mock: true,
    description: "A fixed hierarchy written inside Nova. No game, process or file is read.",
    read: () => data,
    subscribe: () => () => undefined,
  };
}

/**
 * A synthetic hierarchy of `count` objects, for measuring the Explorer against
 * larger trees than the mock ships. Test-only; the application never calls it.
 */
export function createExplorerScaleData(count: number, breadth = 8): readonly ExplorerNodeData[] {
  const data: ExplorerNodeData[] = [];
  for (let index = 0; index < count; index += 1) {
    const parentIndex = index === 0 ? -1 : Math.floor((index - 1) / breadth);
    data.push({
      id: `node-${index}`,
      name: index === 0 ? "Workspace" : `Object ${index}`,
      className: index % 3 === 0 ? "Folder" : "Part",
      parentId: parentIndex < 0 ? null : `node-${parentIndex}`,
      properties: identity(index === 0 ? "Workspace" : `Object ${index}`, "Part"),
    });
  }
  return data;
}
