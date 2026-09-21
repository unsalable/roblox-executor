import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Window } from "@tauri-apps/api/window";

export interface AppInfo {
  name: string;
  version: string;
  tauriVersion: string;
}

export const runningInTauri = isTauri();

export function fetchAppInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("app_info");
}

/** The Rust command the local developer service answers on. */
export const LOCAL_SERVICE_COMMAND = "local_service_request";

/**
 * Sends one raw local service protocol message and resolves with the raw
 * answer. It lives here so `invoke` still has exactly one call site in the
 * frontend; the protocol itself is the local service backend's own business.
 */
export function callLocalService(message: string): Promise<string> {
  return invoke<string>(LOCAL_SERVICE_COMMAND, { message });
}

/**
 * The window module is imported lazily: `getCurrentWindow()` reads Tauri
 * internals that do not exist when the frontend runs in a plain browser
 * (`npm run dev:web`).
 */
async function withWindow<T>(run: (appWindow: Window) => Promise<T>): Promise<T | null> {
  if (!runningInTauri) return null;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return run(getCurrentWindow());
}

export const windowControls = {
  minimize: () => withWindow((appWindow) => appWindow.minimize()),
  toggleMaximize: () => withWindow((appWindow) => appWindow.toggleMaximize()),
  close: () => withWindow((appWindow) => appWindow.close()),
  isMaximized: () => withWindow((appWindow) => appWindow.isMaximized()),
};

/**
 * Reports the maximized state so the title bar can swap between the maximize
 * and restore glyphs. Returns a cleanup function.
 */
export function subscribeToMaximizeState(listener: (maximized: boolean) => void): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;

  void withWindow(async (appWindow) => {
    listener(await appWindow.isMaximized());
    const stop = await appWindow.onResized(() => {
      void appWindow.isMaximized().then((maximized) => {
        if (!disposed) listener(maximized);
      });
    });

    if (disposed) stop();
    else unlisten = stop;
    return null;
  });

  return () => {
    disposed = true;
    unlisten?.();
  };
}
