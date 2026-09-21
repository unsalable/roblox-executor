export const config = {
  appName: __APP_NAME__,
  version: __APP_VERSION__,
  isDev: import.meta.env.DEV,
  environment: import.meta.env.DEV ? "development" : "production",
  /**
   * Where Nova's releases come from, for the places that have to say so.
   *
   * It is a label, not an address: the address the updater actually uses is
   * compiled into the application (`src-tauri/tauri.conf.json`), alongside the
   * public key every artifact is verified against. Nothing in the UI, in the
   * settings or in stored data can point Nova at another source.
   */
  releaseRepository: "unsalable/roblox-executor",
} as const;
