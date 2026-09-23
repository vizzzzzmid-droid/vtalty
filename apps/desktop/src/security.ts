import type { BrowserWindow, WebFrameMain } from "electron";
import { webContents } from "electron";
import { navigationDecision } from "./shared.js";

/**
 * All navigation/permission decisions funnel through here so they are
 * unit-testable without Electron. `instanceOrigin` is empty until the user
 * connects to a server; with no origin configured, only the local connect
 * screen (file://) may load.
 */

export function isConnectPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "file:" && parsed.pathname.endsWith("/connect.html");
  } catch {
    return false;
  }
}

export function decideNavigation(targetUrl: string, instanceOrigin: string): "allow" | "external" | "deny" {
  if (isConnectPage(targetUrl)) {
    return "allow";
  }
  return navigationDecision(targetUrl, instanceOrigin);
}

export type MediaPermission =
  | "media"
  | "display-capture"
  | "notifications"
  | "fullscreen"
  | "other";

/** Only media-ish permissions for the instance origin are ever granted. */
export function decidePermission(
  permission: string,
  requestingOrigin: string,
  instanceOrigin: string,
): MediaPermission {
  if (instanceOrigin.length === 0) {
    return "other";
  }
  try {
    if (new URL(requestingOrigin).origin !== new URL(instanceOrigin).origin) {
      return "other";
    }
  } catch {
    return "other";
  }
  if (
    permission === "media" ||
    permission === "display-capture" ||
    permission === "notifications" ||
    permission === "fullscreen"
  ) {
    return permission;
  }
  return "other";
}

export function frameBelongsToWindow(frame: WebFrameMain | null, window: BrowserWindow): boolean {
  if (frame === null) {
    return false;
  }
  try {
    return webContents.fromFrame(frame) === window.webContents;
  } catch {
    return false;
  }
}
