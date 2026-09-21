/**
 * Copying short labels (an object name, an object path) to the system
 * clipboard.
 *
 * This is the browser clipboard API the webview already exposes to the page; no
 * Tauri plugin and no additional capability is involved. It can be refused —
 * without a user gesture, or where the webview denies it — so callers are told
 * whether the copy happened instead of being left to assume it did.
 */
export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
