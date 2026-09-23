import path from "node:path";

/**
 * Tray helpers — kept free of Electron imports so the rule "never hide the
 * window unless a visible tray exists" is unit-testable in a plain Node test.
 *
 * Regression context (real Windows report): the `files:` allowlist in
 * electron-builder.yml never shipped `assets/`, so the packaged app built an
 * empty NativeImage and skipped tray creation entirely — while minimize/close
 * still hid the window (minimizeToTray defaults to true). Window gone, no
 * taskbar entry, no tray icon. Two independent guarantees now:
 *   1. the icon is shipped as a real file outside the asar via
 *      `extraResources` (see electron-builder.yml);
 *   2. if it still cannot be created, `shouldHideToTray` refuses to hide the
 *      window, so it always stays reachable (and a fallback PNG keeps a tray
 *      icon visible in the common failure cases).
 */

/** 16x16 solid-violet PNG used when no icon file can be loaded. */
export const FALLBACK_TRAY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGPor/7/nxLMMGrAqAGjBgwXAwC2WQguyNp5OwAAAABJRU5ErkJggg==";

/**
 * Icon lookup order:
 *  - packaged: `<resources>/assets/icon.png` (electron-builder
 *    `extraResources` — a real path, not inside app.asar);
 *  - dev: `<appRoot>/assets/icon.png` (project dir, one level above dist/).
 */
export function trayIconCandidates(
  resourcesPath: string | undefined,
  appRoot: string,
): string[] {
  const candidates: string[] = [];
  if (typeof resourcesPath === "string" && resourcesPath.length > 0) {
    candidates.push(path.join(resourcesPath, "assets", "icon.png"));
  }
  candidates.push(path.join(appRoot, "assets", "icon.png"));
  return candidates;
}

/** First existing icon path, or null when none can be found. */
export function pickTrayIconPath(
  candidates: string[],
  exists: (candidate: string) => boolean,
): string | null {
  for (const candidate of candidates) {
    if (exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Hiding the window (minimize/close → tray) is only allowed when a tray icon
 * was actually created: otherwise the window would become unreachable —
 * exactly the bug users hit on Windows. Setting off → normal minimize/close.
 */
export function shouldHideToTray(
  minimizeToTray: boolean,
  trayReady: boolean,
): boolean {
  return minimizeToTray && trayReady;
}
