import { logger } from "@/lib/logger";
import { defaultSettings, TIMEOUT_LIMITS, type Settings, type SettingsSection } from "@/types/settings";

/**
 * Local persistence. Everything Nova keeps between launches goes through this
 * module; today it is the webview's local storage, so callers never touch
 * `localStorage` directly and the backend can change in one place.
 */

export type StoredRead =
  | { status: "missing" }
  | { status: "found"; raw: string; value: unknown }
  | { status: "unreadable"; raw: string | null; error: unknown };

export type StoredWrite = { ok: true } | { ok: false; error: unknown };

export function readStored(key: string): StoredRead {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch (error) {
    return { status: "unreadable", raw: null, error };
  }

  if (raw === null) return { status: "missing" };

  try {
    return { status: "found", raw, value: JSON.parse(raw) as unknown };
  } catch (error) {
    return { status: "unreadable", raw, error };
  }
}

/** Writes an already serialized value. */
export function writeStored(key: string, raw: string): StoredWrite {
  try {
    localStorage.setItem(key, raw);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

const SETTINGS_KEY = "nova.settings";

/** Stored values replace defaults only when they have the same type, so a damaged entry cannot break a setting. */
function mergeSection<T extends object>(defaults: T, stored: unknown): T {
  const merged = { ...defaults };
  if (!stored || typeof stored !== "object") return merged;

  for (const key of Object.keys(defaults) as (keyof T)[]) {
    const value = (stored as Partial<T>)[key];
    if (value !== undefined && typeof value === typeof defaults[key]) merged[key] = value;
  }
  return merged;
}

function clampTimeout(value: number, { min, max }: { min: number; max: number }, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

/**
 * Builds complete settings from whatever was stored. Sections and fields added
 * in later versions (e.g. `target`) fall back to their defaults and sections
 * that no longer exist are dropped, so older stored settings need no migration.
 */
export function normalizeSettings(value: unknown): Settings {
  const stored = (value && typeof value === "object" ? value : {}) as Partial<Record<SettingsSection, unknown>>;

  const executor = mergeSection(defaultSettings.executor, stored.executor);
  const target = mergeSection(defaultSettings.target, stored.target);
  const developer = mergeSection(defaultSettings.developer, stored.developer);

  return {
    general: mergeSection(defaultSettings.general, stored.general),
    editor: mergeSection(defaultSettings.editor, stored.editor),
    appearance: mergeSection(defaultSettings.appearance, stored.appearance),
    executor: {
      ...executor,
      timeoutMs: clampTimeout(executor.timeoutMs, TIMEOUT_LIMITS.execution, defaultSettings.executor.timeoutMs),
    },
    target: {
      ...target,
      injectTimeoutMs: clampTimeout(
        target.injectTimeoutMs,
        TIMEOUT_LIMITS.inject,
        defaultSettings.target.injectTimeoutMs,
      ),
    },
    developer: {
      ...developer,
      backendStartupTimeoutMs: clampTimeout(
        developer.backendStartupTimeoutMs,
        TIMEOUT_LIMITS.backendStartup,
        defaultSettings.developer.backendStartupTimeoutMs,
      ),
      healthCheckIntervalMs: clampTimeout(
        developer.healthCheckIntervalMs,
        TIMEOUT_LIMITS.healthCheck,
        defaultSettings.developer.healthCheckIntervalMs,
      ),
    },
    updates: mergeSection(defaultSettings.updates, stored.updates),
    performance: mergeSection(defaultSettings.performance, stored.performance),
  };
}

export function loadSettings(): Settings {
  const read = readStored(SETTINGS_KEY);

  if (read.status === "unreadable") {
    logger.warn("Stored settings could not be read, falling back to defaults", read.error);
    return structuredClone(defaultSettings);
  }
  if (read.status === "missing") return structuredClone(defaultSettings);

  return normalizeSettings(read.value);
}

export function saveSettings(settings: Settings): void {
  const result = writeStored(SETTINGS_KEY, JSON.stringify(settings));
  if (!result.ok) logger.error("Settings could not be persisted", result.error);
}
