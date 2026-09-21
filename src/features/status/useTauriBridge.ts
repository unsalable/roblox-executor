import { useEffect, useState } from "react";
import { logger } from "@/lib/logger";
import { fetchAppInfo, runningInTauri, type AppInfo } from "@/lib/tauri";

export type BridgeState =
  | { status: "unavailable" }
  | { status: "checking" }
  | { status: "ready"; info: AppInfo }
  | { status: "error" };

export const bridgeLabel: Record<BridgeState["status"], string> = {
  unavailable: "Not available (browser)",
  checking: "Checking",
  ready: "Ready",
  error: "Error",
};

/**
 * IPC probe: calls the `app_info` command once to confirm the Rust
 * bridge answers. Kept as a hook so both the status bar and the diagnostics
 * list can read the same result.
 */
export function useTauriBridge(): BridgeState {
  const [bridge, setBridge] = useState<BridgeState>(() =>
    runningInTauri ? { status: "checking" } : { status: "unavailable" },
  );

  useEffect(() => {
    if (!runningInTauri) return;

    let active = true;
    fetchAppInfo()
      .then((info) => {
        if (active) setBridge({ status: "ready", info });
      })
      .catch((error: unknown) => {
        logger.error("Tauri bridge did not respond", error);
        if (active) setBridge({ status: "error" });
      });

    return () => {
      active = false;
    };
  }, []);

  return bridge;
}
