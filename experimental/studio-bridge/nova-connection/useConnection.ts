import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useAppServices } from "@/app/services";
import { useAppStore } from "@/app/store";
import type { ConnectionSnapshot } from "@/features/connection/types";

export interface ConnectionView extends ConnectionSnapshot {
  providerLabel: string;
  connect: () => void;
  /** Disconnects, cancels an attempt in progress, or dismisses a failure. */
  disconnect: () => void;
}

export function useConnection(): ConnectionView {
  const { connection } = useAppServices();
  const { settings } = useAppStore();
  const snapshot = useSyncExternalStore(connection.subscribe, connection.getSnapshot);
  const { timeoutMs } = settings.connection;

  const connect = useCallback(() => void connection.connect({ timeoutMs }), [connection, timeoutMs]);
  const disconnect = useCallback(() => void connection.disconnect(), [connection]);

  return { ...snapshot, providerLabel: connection.provider.label, connect, disconnect };
}

/** Settings › Connection › Auto connect, applied once per launch with the settings loaded at startup. */
export function useAutoConnect(): void {
  const { connection } = useAppServices();
  const { settings } = useAppStore();
  const startup = useRef(settings.connection);

  useEffect(() => {
    const { autoConnect, timeoutMs } = startup.current;
    void connection.autoConnect({ enabled: autoConnect, timeoutMs });
  }, [connection]);
}
