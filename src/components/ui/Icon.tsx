/**
 * Minimal in-house icon set.
 *
 * A dedicated icon package would add a dependency for the ~30 glyphs the shell
 * needs, so the paths live here instead. Every glyph is drawn on the same
 * 24x24 grid with the same 1.5 stroke so the set stays visually consistent.
 */

const paths = {
  scripts: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M10 13l-2 2 2 2M14 13l2 2-2 2",
  console: "M4 5h16v14H4zM7 10l2.5 2L7 14M12.5 15H17",
  explorer: "M3 7a2 2 0 0 1 2-2h3.6l2 2.4H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  debugger: "M9 7a3 3 0 0 1 6 0M7 11a5 5 0 0 1 10 0v3a5 5 0 0 1-10 0zM4 12h3M17 12h3M4.8 7.5 7 9M19.2 7.5 17 9M4.8 17.5 7 16M19.2 17.5 17 16",
  profiler: "M4 19h16M7 19v-6M12 19V6M17 19v-9",
  settings:
    "M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4M19.3 14.3a1.5 1.5 0 0 0 .3 1.65l.05.05a1.8 1.8 0 1 1-2.55 2.55l-.05-.05a1.5 1.5 0 0 0-1.65-.3 1.5 1.5 0 0 0-.9 1.37V20a1.8 1.8 0 0 1-3.6 0v-.1a1.5 1.5 0 0 0-.98-1.37 1.5 1.5 0 0 0-1.65.3l-.05.05A1.8 1.8 0 1 1 4.7 16.3l.05-.05a1.5 1.5 0 0 0 .3-1.65 1.5 1.5 0 0 0-1.37-.9H3.5a1.8 1.8 0 0 1 0-3.6h.1a1.5 1.5 0 0 0 1.37-.98 1.5 1.5 0 0 0-.3-1.65L4.62 7.4A1.8 1.8 0 1 1 7.17 4.85l.05.05a1.5 1.5 0 0 0 1.65.3h.07a1.5 1.5 0 0 0 .9-1.37V3.7a1.8 1.8 0 0 1 3.6 0v.1a1.5 1.5 0 0 0 .9 1.37 1.5 1.5 0 0 0 1.65-.3l.05-.05a1.8 1.8 0 1 1 2.55 2.55l-.05.05a1.5 1.5 0 0 0-.3 1.65v.07a1.5 1.5 0 0 0 1.37.9h.14a1.8 1.8 0 0 1 0 3.6h-.1a1.5 1.5 0 0 0-1.37.9",
  plus: "M12 5v14M5 12h14",
  close: "M6 6l12 12M18 6L6 18",
  chevronDown: "M6 9.5 12 15.5 18 9.5",
  chevronLeft: "M14.5 6 8.5 12l6 6",
  chevronRight: "M9.5 6l6 6-6 6",
  minimize: "M5 12h14",
  maximize: "M5.5 5.5h13v13h-13z",
  restore: "M8 8V6.5h9.5V16H16M5.5 9.5h10.5v8H5.5z",
  play: "M7 4.8 19 12 7 19.2z",
  stop: "M6.5 6.5h11v11h-11z",
  pause: "M9 5.5v13M15 5.5v13",
  record: "M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14",
  refresh: "M20 12a8 8 0 1 1-2.35-5.65M20.2 4.2v3.9h-3.9",
  breakpoint: "M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12",
  stepOver: "M5.5 13a6.5 6.5 0 0 1 13 0M18.5 13.2l-2.6-2.9M18.5 13.2l2.6-2.9M12 20.2a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8",
  stepInto: "M12 3.8v9.4M12 13.2l-3-3.1M12 13.2l3-3.1M12 20.2a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8",
  stepOut: "M12 13.2V3.8M12 3.8l-3 3.1M12 3.8l3 3.1M12 20.2a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8",
  history: "M3.8 12a8.2 8.2 0 1 0 2.4-5.8L3.8 8.6M3.8 4.6v4h4M12 7.8V12l2.9 1.7",
  trash: "M4.5 7h15M9.5 7V4.8h5V7M6.5 7l1 12.2h9l1-12.2M10.5 10.5v5.5M13.5 10.5v5.5",
  search: "M10.8 17.6a6.8 6.8 0 1 0 0-13.6 6.8 6.8 0 0 0 0 13.6M15.8 15.8 20 20",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 11v5.5M12 7.6v.8",
  warning: "M10.7 4.2 3.4 17a1.5 1.5 0 0 0 1.3 2.3h14.6a1.5 1.5 0 0 0 1.3-2.3L13.3 4.2a1.5 1.5 0 0 0-2.6 0M12 9.5v4M12 16.4v.6",
  error: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6",
  debug: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M8.5 12h7",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5",
  filePlus: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M12 11v6M9 14h6",
  folder: "M3 7a2 2 0 0 1 2-2h3.6l2 2.4H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  folderOpen:
    "M3 17.5V7a2 2 0 0 1 2-2h3.6l2 2.4H17a2 2 0 0 1 2 2V10M3 17.5l2.2-6.2A1.8 1.8 0 0 1 6.9 10h13.3a1 1 0 0 1 .95 1.32l-2 6.3A2 2 0 0 1 17.24 19H4.5A1.5 1.5 0 0 1 3 17.5z",
  folderPlus: "M3 7a2 2 0 0 1 2-2h3.6l2 2.4H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10.5v5.5M9.25 13.25h5.5",
  star: "M12 3.8l2.5 5.1 5.6.8-4.05 3.95.96 5.58L12 16.6l-5.01 2.63.96-5.58L3.9 9.7l5.6-.8z",
  more: "M5.25 12h1.5M11.25 12h1.5M17.25 12h1.5",
  panelBottom: "M4 5h16v14H4zM4 14h16",
  sparkle: "M12 3.5 13.9 9.4 19.8 11.3 13.9 13.2 12 19.1 10.1 13.2 4.2 11.3 10.1 9.4z",
  copy: "M9.5 8.5h9a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 8 19v-9a1.5 1.5 0 0 1 1.5-1.5M5.5 15.5A1.5 1.5 0 0 1 4 14V5a1.5 1.5 0 0 1 1.5-1.5h9A1.5 1.5 0 0 1 16 5v1",
  expandAll: "M4 5.5h16M4 11h16M4 16.5h7M17 14v6M14 17h6",
  collapseAll: "M4 5.5h16M4 11h16M4 16.5h7M14 17h6",
  camera: "M4.5 8.5h2.8l1.4-2.2h6.6l1.4 2.2h2.8a1.5 1.5 0 0 1 1.5 1.5v7.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5V10a1.5 1.5 0 0 1 1.5-1.5M12 16.4a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8",
  cube: "M12 3.2 20 7.4v9.2L12 20.8 4 16.6V7.4zM4 7.4l8 4.2 8-4.2M12 11.6v9.2",
  spawn: "M6.8 3.5v17M6.8 5h10.4l-2.3 3.4 2.3 3.4H6.8",
  sun: "M12 16.4a4.4 4.4 0 1 0 0-8.8 4.4 4.4 0 0 0 0 8.8M12 2.8v1.8M12 19.4v1.8M4.9 4.9l1.3 1.3M17.8 17.8l1.3 1.3M2.8 12h1.8M19.4 12h1.8M4.9 19.1l1.3-1.3M17.8 6.2l1.3-1.3",
  users: "M9.2 11.4a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2M2.6 19.8a6.6 6.6 0 0 1 13.2 0M16.4 5.1a3.6 3.6 0 0 1 0 6.6M18 14.4a6.6 6.6 0 0 1 3.4 5.4",
  package: "M3.4 8.4h17.2v9.6a1.5 1.5 0 0 1-1.5 1.5H4.9a1.5 1.5 0 0 1-1.5-1.5zM2.6 5h18.8v3.4H2.6zM10 12.2h4",
  module: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M8.5 12.5h7M8.5 16h4",
  sound: "M5 9.4h3.2L12 6v12L8.2 14.6H5zM16 9.4a4 4 0 0 1 0 5.2M18.6 6.9a7.5 7.5 0 0 1 0 10.2",
  object: "M12 3.6 20.4 12 12 20.4 3.6 12z",
} as const;

export type IconName = keyof typeof paths;

interface IconProps {
  name: IconName;
  /** Square size in pixels. Keep to the 14 / 16 / 18 scale used by the shell. */
  size?: number;
  className?: string;
  filled?: boolean;
}

export function Icon({ name, size = 16, className, filled = false }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  );
}

/** The Nova brand mark. Deliberately geometric so it reads at 14px. */
export function BrandMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 2.5 21.5 12 12 21.5 2.5 12z" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" />
      <path d="M12 7.5 16.5 12 12 16.5 7.5 12z" fill="currentColor" opacity={0.9} />
    </svg>
  );
}
