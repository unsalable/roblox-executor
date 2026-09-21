import type { IconName } from "@/components/ui/Icon";

/**
 * Icon per object class, drawn from the shell's own icon set.
 *
 * Classes a provider reports are free-form, so anything unlisted falls back to
 * the generic object glyph rather than being hidden or guessed at.
 */
const CLASS_ICONS: Readonly<Record<string, IconName>> = {
  Workspace: "explorer",
  Folder: "folder",
  Camera: "camera",
  Part: "cube",
  Model: "cube",
  MeshPart: "cube",
  SpawnLocation: "spawn",
  Lighting: "sun",
  Players: "users",
  Player: "users",
  ReplicatedStorage: "package",
  ServerStorage: "package",
  ModuleScript: "module",
  Script: "scripts",
  LocalScript: "scripts",
  Sound: "sound",
};

export function explorerClassIcon(className: string): IconName {
  // Own properties only: a class named after something on Object's prototype
  // ("constructor", "toString") must fall back like any other unknown class.
  return Object.hasOwn(CLASS_ICONS, className) ? CLASS_ICONS[className]! : "object";
}
