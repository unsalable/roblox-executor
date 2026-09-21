import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { loadSettings, saveSettings } from "@/lib/storage";
import type { AppState } from "@/types/app";
import type { Settings, SettingsSection, ThemeMode } from "@/types/settings";

/**
 * Application-wide settings. Target and execution state are not kept here:
 * their controllers (see `app/services.tsx`) are the single source of truth,
 * and components subscribe to them directly.
 */
interface AppStore extends AppState {
  updateSettings: <S extends SettingsSection>(section: S, patch: Partial<Settings[S]>) => void;
}

const AppStoreContext = createContext<AppStore | null>(null);

function applyTheme(mode: ThemeMode, prefersLight: boolean): void {
  document.documentElement.dataset.theme =
    mode === "system" ? (prefersLight ? "light" : "dark") : mode;
}

export function AppStoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(() => ({ settings: loadSettings() }));

  const { theme } = state.settings.appearance;

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const sync = () => applyTheme(theme, media.matches);

    sync();
    if (theme !== "system") return;

    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [theme]);

  useEffect(() => {
    saveSettings(state.settings);
  }, [state.settings]);

  const updateSettings = useCallback(
    <S extends SettingsSection>(section: S, patch: Partial<Settings[S]>) => {
      setState((current) => ({
        ...current,
        settings: {
          ...current.settings,
          [section]: { ...current.settings[section], ...patch },
        },
      }));
    },
    [],
  );

  const store = useMemo<AppStore>(
    () => ({
      ...state,
      updateSettings,
    }),
    [state, updateSettings],
  );

  return <AppStoreContext.Provider value={store}>{children}</AppStoreContext.Provider>;
}

export function useAppStore(): AppStore {
  const store = useContext(AppStoreContext);
  if (!store) throw new Error("useAppStore must be used within AppStoreProvider");
  return store;
}
