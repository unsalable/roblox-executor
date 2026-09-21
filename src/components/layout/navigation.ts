import type { IconName } from "@/components/ui/Icon";

export type WorkspaceView = "scripts" | "explorer" | "debugger" | "profiler";

export interface NavItem {
  id: WorkspaceView | "console";
  label: string;
  icon: IconName;
  description: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    id: "scripts",
    label: "Scripts",
    icon: "scripts",
    description: "Script workspace",
  },
  {
    id: "console",
    label: "Console",
    icon: "console",
    description: "Toggle the output panel",
  },
  {
    id: "explorer",
    label: "Explorer",
    icon: "explorer",
    description: "Browse an object hierarchy and inspect what each object reports.",
  },
  {
    id: "debugger",
    label: "Debugger",
    icon: "debugger",
    description: "Breakpoints, stepping and inspection for a simulated session.",
  },
  {
    id: "profiler",
    label: "Profiler",
    icon: "profiler",
    description: "Record a simulated session and read its timeline and frames.",
  },
];
