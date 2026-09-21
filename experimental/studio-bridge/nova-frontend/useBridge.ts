import { useSyncExternalStore } from "react";
import type { StudioBridge } from "@/features/bridge/session";
import type { BridgeSnapshot } from "@/features/bridge/types";

/** Subscribes to the bridge's own state. Re-renders only when the bridge publishes a change. */
export function useBridgeSnapshot(bridge: StudioBridge): BridgeSnapshot {
  return useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);
}

const NO_SUBSCRIPTION = () => () => {};
const NO_SNAPSHOT = () => null;

/** The same subscription for surfaces that render with or without the bridge. */
export function useOptionalBridgeSnapshot(bridge: StudioBridge | null): BridgeSnapshot | null {
  return useSyncExternalStore(bridge?.subscribe ?? NO_SUBSCRIPTION, bridge?.getSnapshot ?? NO_SNAPSHOT);
}
