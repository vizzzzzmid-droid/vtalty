import { z } from "zod";

/**
 * IPC contract between main and renderers. Every channel is namespaced
 * `vitality:*`; every payload is zod-validated on receipt, and every sender
 * frame is origin-checked in main (see main.ts). Renderer code must go
 * through `window.desktop` (preload bridge) — never ipcRenderer directly.
 */

export const IPC_CHANNELS = {
  getVersion: "vitality:get-version",
  getCapabilities: "vitality:get-capabilities",
  connectToServer: "vitality:connect-to-server",
  getRecentServers: "vitality:get-recent-servers",
  forgetServer: "vitality:forget-server",
  backToConnect: "vitality:back-to-connect",
  notify: "vitality:notify",
  setBadge: "vitality:set-badge",
  getSetting: "vitality:get-setting",
  setSetting: "vitality:set-setting",
  screenPick: "vitality:screen-pick",
  pttKey: "vitality:ptt-key",
  toggleMute: "vitality:toggle-mute",
  showPicker: "vitality:show-picker",
  notificationClick: "vitality:notification-click",
} as const;

export const serverUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(
    (url) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return false;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return false;
      }
      // Credentials in the URL (user:pass@host) must never reach the
      // loader, the health check, or the recent-servers store: they would
      // leak into logs/history and enable phishing-shaped URLs.
      if (parsed.username.length > 0 || parsed.password.length > 0) {
        return false;
      }
      const host = parsed.hostname.toLowerCase();
      const local =
        host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
      // Plain HTTP is only ever allowed on loopback (dev).
      if (parsed.protocol === "http:" && !local) {
        return false;
      }
      return true;
    },
    { message: "Use an https:// URL (http:// only for localhost)" },
  );

/** Normalize a validated server URL to `origin + path` (no credentials). */
export function normalizeServerUrl(url: string): string | null {
  const parsed = serverUrlSchema.safeParse(url);
  if (!parsed.success) {
    return null;
  }
  try {
    const value = new URL(parsed.data);
    value.username = "";
    value.password = "";
    value.hash = "";
    return value.toString();
  } catch {
    return null;
  }
}

export const connectRequestSchema = z.object({
  url: serverUrlSchema,
});

export const recentServerSchema = z.object({
  url: serverUrlSchema,
  lastUsed: z.number().int().nonnegative(),
});

export const notifySchema = z.object({
  title: z.string().min(1).max(128),
  body: z.string().min(1).max(512),
  // Optional channel to open when the notification is clicked. Main echoes
  // it back to the renderer (never to the OS beyond display).
  channelId: z.string().min(1).max(128).optional(),
});

export const notificationClickSchema = z.object({
  channelId: z.string().min(1).max(128),
});

export type NotifyRequest = z.infer<typeof notifySchema>;
export type NotificationClick = z.infer<typeof notificationClickSchema>;

export const badgeSchema = z.object({
  count: z.number().int().min(0).max(9999),
});

export const screenSourceSchema = z.object({
  id: z.string().min(1).max(512),
  name: z.string().min(1).max(256),
  thumbnail: z.string().max(200000),
});

export const screenPickRequestSchema = z.object({
  requestId: z.string().min(1).max(128),
  sources: z.array(screenSourceSchema).max(64),
});

export const screenPickResultSchema = z.object({
  requestId: z.string().min(1).max(128),
  sourceId: z.string().max(512),
});

export const pttKeyEventSchema = z.object({
  active: z.boolean(),
});

export type ScreenSource = z.infer<typeof screenSourceSchema>;

// Shared contract for `window.desktop`: implemented by the Electron
// preload, feature-detected by the web client (works unchanged in a plain
// browser where `window.desktop` is undefined). Keep in sync with
// apps/desktop/src/preload.ts; breaking changes bump the shape check in
// apps/web/src/lib/desktop.ts.
export interface DesktopBridgeShape {
  platform: "win32" | "linux" | "darwin";
  getVersion: () => Promise<string>;
  getCapabilities: () => Promise<{
    globalPtt: boolean;
    globalPttReason: string | null;
    screenPicker: boolean;
    systemAudio: "windows-loopback" | "unsupported";
  }>;
  connectToServer: (url: string) => Promise<{ ok: boolean; error?: string }>;
  getRecentServers: () => Promise<{ url: string; lastUsed: number }[]>;
  forgetServer: (url: string) => Promise<void>;
  backToConnect: () => Promise<void>;
  notify: (title: string, body: string, channelId?: string) => Promise<void>;
  setBadge: (count: number) => Promise<void>;
  getSetting: (key: string) => Promise<unknown>;
  setSetting: (key: string, value: unknown) => Promise<boolean>;
  onShowPicker: (
    callback: (request: {
      requestId: string;
      sources: { id: string; name: string; thumbnail: string }[];
    }) => void,
  ) => () => void;
  pickScreenSource: (requestId: string, sourceId: string) => Promise<void>;
  onPttKey: (callback: (active: boolean) => void) => () => void;
  onToggleMute: (callback: () => void) => () => void;
  onNotificationClick: (callback: (channelId: string) => void) => () => void;
}


/**
 * Navigation guard (pure, unit-tested). The main window may only ever show
 * the configured instance origin (plus blank popups that we immediately
 * route); everything else opens externally or is denied.
 */
export function navigationDecision(
  targetUrl: string,
  instanceOrigin: string,
): "allow" | "external" | "deny" {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return "deny";
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return "deny";
  }
  let origin: URL;
  try {
    origin = new URL(instanceOrigin);
  } catch {
    return "deny";
  }
  return target.origin === origin.origin ? "allow" : "external";
}

/** Sender-frame origin check for every IPC handler (pure, unit-tested). */
export function isConnectSender(senderUrl: string | undefined): boolean {
  if (senderUrl === undefined || senderUrl.length === 0) {
    return false;
  }
  try {
    const parsed = new URL(senderUrl);
    return parsed.protocol === "file:" && parsed.pathname.endsWith("/connect.html");
  } catch {
    return false;
  }
}

/** Sender-frame origin check for every IPC handler (pure, unit-tested). */
export function isTrustedSender(
  senderUrl: string | undefined,
  instanceOrigin: string,
): boolean {
  if (senderUrl === undefined || senderUrl.length === 0) {
    return false;
  }
  // The local connect screen (file://) is trusted only while no instance is
  // connected and only for the connect-flow channels (checked per-handler).
  if (isConnectSender(senderUrl)) {
    return instanceOrigin.length === 0;
  }
  if (instanceOrigin.length === 0) {
    return false;
  }
  try {
    return new URL(senderUrl).origin === new URL(instanceOrigin).origin;
  } catch {
    return false;
  }
}
