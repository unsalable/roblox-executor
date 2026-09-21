import { config } from "@/app/config";
import type { UpdateCheck, UpdateProgress, UpdateProvider } from "@/features/updates/types";
import { runningInTauri } from "@/lib/tauri";

/**
 * Tauri's updater, which is the whole of Nova's update mechanism.
 *
 * Three facts about it are the reason there is nothing else here:
 *
 * - **The endpoint lives in `src-tauri/tauri.conf.json`,** not in this file and
 *   not in any setting. Nothing the user or stored data can reach decides where
 *   an update comes from.
 * - **The public key lives there too,** and the updater verifies every artifact
 *   against it in Rust before writing it anywhere. An artifact that does not
 *   verify is never installed, and this file could not install one if it tried.
 * - **`downloadAndInstall` is the only thing that runs anything.** Nova
 *   downloads the installer the source named and hands it to the updater; it
 *   does not execute downloaded code by any other route.
 *
 * The plugin modules are imported lazily, for the same reason `lib/tauri.ts`
 * imports the window module lazily: they read Tauri internals that do not exist
 * when the frontend runs in a plain browser (`npm run dev:web`).
 */

/** Shown wherever Nova has to say where an update would come from. */
export const RELEASE_SOURCE = `GitHub Releases (${config.releaseRepository})`;

/**
 * True when this build can update itself: a packaged Tauri build, and not a
 * development one. A development build is excluded on purpose — it is not
 * installed, so there is nothing for an installer to replace, and gating it
 * here is what keeps `npm run dev` from reaching the network at all.
 */
const canUpdate = runningInTauri && !config.isDev;

export function createTauriUpdateProvider(): UpdateProvider {
  return {
    label: "GitHub Releases",
    source: RELEASE_SOURCE,
    available: canUpdate,

    check: async (): Promise<UpdateCheck> => {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update === null) return { status: "up-to-date" };

      return {
        status: "available",
        release: {
          version: update.version,
          currentVersion: update.currentVersion,
          notes: update.body ?? null,
          publishedAt: update.date ?? null,
        },
        install: {
          run: (onProgress: (progress: UpdateProgress) => void) => {
            // The plugin reports chunk sizes rather than a running total, and
            // a source that declares no content length reports no total at all.
            let downloadedBytes = 0;
            let totalBytes: number | null = null;

            return update.downloadAndInstall((event) => {
              switch (event.event) {
                case "Started":
                  totalBytes = event.data.contentLength ?? null;
                  onProgress({ phase: "downloading", downloadedBytes: 0, totalBytes });
                  return;
                case "Progress":
                  downloadedBytes += event.data.chunkLength;
                  onProgress({ phase: "downloading", downloadedBytes, totalBytes });
                  return;
                case "Finished":
                  onProgress({ phase: "installing", downloadedBytes, totalBytes });
                  return;
              }
            });
          },
          close: () => update.close(),
        },
      };
    },

    relaunch: async () => {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    },
  };
}
