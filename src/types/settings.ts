export type ThemeMode = "dark" | "light" | "system";

/**
 * The developer backend a fresh install uses. Declared here rather than imported
 * from the backend feature, so the settings model stays a plain data module with
 * no dependency on the code it configures; the registry checks that it resolves.
 */
export const DEFAULT_BACKEND_ID = "local-mock";

export interface Settings {
  general: {
    /**
     * "Confirm before closing". When on, closing a tab with unsaved changes
     * asks Save / Discard / Cancel, and closing the window while any script
     * has unsaved changes asks Save All / Close Without Saving / Cancel.
     * When off, both close immediately and unsaved changes are kept as
     * drafts that are restored on the next launch — nothing is discarded
     * silently either way. Clean scripts never ask.
     */
    confirmOnExit: boolean;
  };
  editor: {
    fontSize: number;
    tabSize: number;
    wordWrap: boolean;
    minimap: boolean;
  };
  appearance: {
    theme: ThemeMode;
  };
  executor: {
    /** Ask before an execution starts. */
    confirmBeforeRun: boolean;
    /** Clear the console right before an accepted execution starts. */
    clearConsoleBeforeRun: boolean;
    /** An execution still running after this long is stopped and reported as timed out. */
    timeoutMs: number;
  };
  target: {
    /** Look for the target when Nova starts, and keep following its availability. */
    autoDetect: boolean;
    /** Inject as soon as the target becomes ready. Never executes a script by itself. */
    autoInject: boolean;
    /** An injection still pending after this long is abandoned and reported as timed out. */
    injectTimeoutMs: number;
    /** Inject again after an unexpected disconnect. Off by default. */
    autoReconnect: boolean;
  };
  developer: {
    /**
     * Which developer backend supplies the target, debugger and profiler
     * providers. A stored id this build does not know falls back to the default
     * backend and says so, so a preference can never leave Nova without one.
     */
    backendId: string;
    /** Start the developer backend when Nova launches. */
    autoStartBackend: boolean;
    /** A backend still starting after this long is abandoned and reported as timed out. */
    backendStartupTimeoutMs: number;
    /**
     * How often a backend that watches something asks it how it is doing. Only
     * a backend that has something to watch reads it; the Local Mock has
     * nothing outside itself to ask, and says so in Settings.
     */
    healthCheckIntervalMs: number;
  };
  updates: {
    /**
     * Ask Nova's release source whether a newer build exists, shortly after
     * launch. This is the only request Nova makes to anything outside the
     * machine it runs on; with it off, Nova makes none at all and updates are
     * found only by "Check for Updates".
     */
    checkOnStartup: boolean;
  };
  performance: {
    showDiagnostics: boolean;
  };
}

export type SettingsSection = keyof Settings;

/** Allowed ranges for the timeout and interval settings, in milliseconds. */
export const TIMEOUT_LIMITS = {
  execution: { min: 1000, max: 60_000 },
  inject: { min: 1000, max: 30_000 },
  backendStartup: { min: 1000, max: 30_000 },
  healthCheck: { min: 1000, max: 60_000 },
} as const;

export const defaultSettings: Settings = {
  general: {
    confirmOnExit: true,
  },
  editor: {
    fontSize: 14,
    tabSize: 2,
    wordWrap: false,
    minimap: false,
  },
  appearance: {
    theme: "dark",
  },
  executor: {
    confirmBeforeRun: true,
    clearConsoleBeforeRun: false,
    timeoutMs: 5000,
  },
  target: {
    autoDetect: true,
    autoInject: false,
    injectTimeoutMs: 5000,
    autoReconnect: false,
  },
  developer: {
    backendId: DEFAULT_BACKEND_ID,
    autoStartBackend: true,
    backendStartupTimeoutMs: 5000,
    healthCheckIntervalMs: 5000,
  },
  updates: {
    checkOnStartup: true,
  },
  performance: {
    showDiagnostics: false,
  },
};
