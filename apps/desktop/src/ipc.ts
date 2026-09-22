import { app, ipcMain, Notification, shell, type BrowserWindow } from "electron";
import {
  IPC_CHANNELS,
  badgeSchema,
  connectRequestSchema,
  isConnectSender,
  isTrustedSender,
  normalizeServerUrl,
  notificationClickSchema,
  notifySchema,
  screenPickResultSchema,
  serverUrlSchema,
  type NotificationClick,
  type NotifyRequest,
} from "./shared.js";
import { resolveScreenPick } from "./picker.js";
import { loadSettings, rememberServer, saveSettings, type DesktopSettings } from "./store.js";
import { validateScreenPickResult } from "./picker.js";
import { validateAccelerator } from "./keymap.js";

export interface IpcContext {
  window: () => BrowserWindow | null;
  instanceOrigin: () => string;
  loadInstance: (url: string) => Promise<void>;
  showConnectScreen: () => void;
}

/**
 * Sender-frame origin check for the INVOKED (request/response) handlers.
 *
 * `event.senderFrame` is undefined for handlers invoked from a sandboxed
 * preload (`sandbox: true` drops the frame reference on the main side), so
 * we fall back to `event.sender.url` (the committed URL of the calling
 * WebContents). Both are checked against the same rules. Pure, unit-tested
 * via resolveIpcSenderUrl + isTrustedSender.
 */
export function resolveIpcSenderUrl(event: Electron.IpcMainInvokeEvent): string | undefined {
  const frameUrl: unknown = event.senderFrame?.url;
  if (typeof frameUrl === "string" && frameUrl.length > 0) {
    return frameUrl;
  }
  try {
    const contentsUrl: unknown = event.sender?.getURL();
    if (typeof contentsUrl === "string" && contentsUrl.length > 0) {
      return contentsUrl;
    }
  } catch {
    // sender destroyed mid-invoke: treat as untrusted.
  }
  return undefined;
}

function trusted(
  event: Electron.IpcMainInvokeEvent,
  context: IpcContext,
): boolean {
  return isTrustedSender(resolveIpcSenderUrl(event), context.instanceOrigin());
}

function denied(event: Electron.IpcMainInvokeEvent, context: IpcContext): boolean {
  return !trusted(event, context);
}

/**
 * Renderer-writable settings allowlist (pure, unit-tested). Everything else
 * in the store (recent servers, window bounds) is main-only.
 */
export const WRITABLE_SETTINGS = [
  "minimizeToTray",
  "startMinimized",
  "notificationsEnabled",
  "globalPttEnabled",
  "globalPttKeycode",
  "globalMuteAccelerator",
] as const;

export type WritableSettingKey = (typeof WRITABLE_SETTINGS)[number];

export function isWritableSettingKey(key: unknown): key is WritableSettingKey {
  return (
    typeof key === "string" &&
    (WRITABLE_SETTINGS as readonly string[]).includes(key)
  );
}

/** Read one renderer-visible setting (null for anything else). Pure. */
export function readAllowedSetting(
  settings: DesktopSettings,
  key: unknown,
): unknown {
  if (!isWritableSettingKey(key)) {
    return null;
  }
  const record = settings as unknown as Record<string, unknown>;
  return record[key] ?? null;
}

/**
 * Apply a renderer-supplied settings patch (zod-range-checked per field).
 * Pure: returns the merged settings and whether anything changed.
 */
export function applySettingsPatch(
  settings: DesktopSettings,
  body: unknown,
): { next: DesktopSettings; changed: boolean } {
  if (typeof body !== "object" || body === null) {
    return { next: settings, changed: false };
  }
  const record = body as Record<string, unknown>;
  const next = { ...settings };
  let changed = false;
  for (const key of ["minimizeToTray", "startMinimized", "notificationsEnabled", "globalPttEnabled"] as const) {
    if (typeof record[key] === "boolean") {
      next[key] = record[key];
      changed = true;
    }
  }
  if (
    typeof record["globalPttKeycode"] === "number" &&
    Number.isInteger(record["globalPttKeycode"]) &&
    record["globalPttKeycode"] >= 0 &&
    record["globalPttKeycode"] <= 65535
  ) {
    next.globalPttKeycode = record["globalPttKeycode"];
    changed = true;
  }
  if (
    typeof record["globalMuteAccelerator"] === "string" &&
    validateAccelerator(record["globalMuteAccelerator"]) === null
  ) {
    next.globalMuteAccelerator = record["globalMuteAccelerator"].trim();
    changed = true;
  }
  return { next, changed };
}

/** Validate a notify request body (pure, unit-tested). */
export function parseNotifyRequest(body: unknown): NotifyRequest | null {
  const parsed = notifySchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

/** Validate an outbound notification-click payload (pure, unit-tested). */
export function parseNotificationClick(body: unknown): NotificationClick | null {
  const parsed = notificationClickSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

export function registerIpc(context: IpcContext): void {
  // Version/capabilities are safe to expose to both the connect screen and
  // the connected instance (no privileged action, no instance data).
  ipcMain.handle(IPC_CHANNELS.getVersion, (event) => {
    const url = resolveIpcSenderUrl(event);
    if (url === undefined) {
      return "unknown";
    }
    const origin = context.instanceOrigin();
    if (!isTrustedSender(url, origin) && !isConnectSender(url)) {
      return "unknown";
    }
    return app.getVersion();
  });

  ipcMain.handle(IPC_CHANNELS.getCapabilities, (event) => {
    const url = resolveIpcSenderUrl(event);
    if (url === undefined) {
      return {
        globalPtt: false,
        globalPttReason: "untrusted sender",
        screenPicker: false,
        systemAudio: "unsupported" as const,
      };
    }
    const origin = context.instanceOrigin();
    if (!isTrustedSender(url, origin) && !isConnectSender(url)) {
      return {
        globalPtt: false,
        globalPttReason: "untrusted sender",
        screenPicker: false,
        systemAudio: "unsupported" as const,
      };
    }
    return {
      // PTT availability is probed lazily (hook loads on demand); the
      // renderer shows in-app PTT regardless.
      globalPtt: true,
      globalPttReason: null as string | null,
      screenPicker: true,
      systemAudio: (process.platform === "win32"
        ? "windows-loopback"
        : "unsupported") as "windows-loopback" | "unsupported",
    };
  });

  ipcMain.handle(IPC_CHANNELS.connectToServer, async (event, body: unknown) => {
    // Connect flow is allowed from the local connect screen (file://) and
    // from the connected instance (back-to-connect uses the same channel).
    const url = resolveIpcSenderUrl(event);
    if (url === undefined) {
      return { ok: false, error: "untrusted sender" };
    }
    const origin = context.instanceOrigin();
    if (!isTrustedSender(url, origin) && !isConnectSender(url)) {
      return { ok: false, error: "untrusted sender" };
    }
    const parsed = connectRequestSchema.safeParse(body);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid URL" };
    }
    const normalized = normalizeServerUrl(parsed.data.url);
    if (normalized === null) {
      return { ok: false, error: "invalid URL" };
    }
    // Health check from main (Node fetch, same TLS rules as the OS store —
    // private-CA servers must be trusted at OS level, never auto-accepted).
    // The check is pinned to `origin + /api/v1/health`: a validated URL
    // carrying a path/query cannot smuggle extra path segments into the
    // probe or the loader.
    try {
      const checkOrigin = new URL(normalized).origin;
      const response = await fetch(`${checkOrigin}/api/v1/health`);
      if (!response.ok) {
        return { ok: false, error: `server answered HTTP ${response.status}` };
      }
    } catch {
      return { ok: false, error: "server unreachable (network, TLS, or wrong URL?)" };
    }
    rememberServer(normalized);
    await context.loadInstance(normalized);
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.getRecentServers, (event) => {
    // Recent servers are shown only on the local connect screen; the
    // connected instance has no business enumerating the user's servers.
    const url = resolveIpcSenderUrl(event);
    if (url === undefined || !isConnectSender(url)) {
      return [];
    }
    return loadSettings().recentServers;
  });

  ipcMain.handle(IPC_CHANNELS.forgetServer, (event, body: unknown) => {
    // Recent-servers management belongs to the local connect screen.
    const url = resolveIpcSenderUrl(event);
    if (url === undefined || !isConnectSender(url)) {
      return;
    }
    const parsedUrl = typeof body === "object" && body !== null && "url" in body ? body.url : null;
    if (typeof parsedUrl !== "string") {
      return;
    }
    if (!serverUrlSchema.safeParse(parsedUrl).success) {
      return;
    }
    const settings = loadSettings();
    saveSettings({
      ...settings,
      recentServers: settings.recentServers.filter((entry) => entry.url !== parsedUrl),
    });
  });

  ipcMain.handle(IPC_CHANNELS.backToConnect, (event) => {
    if (denied(event, context)) {
      return;
    }
    context.showConnectScreen();
  });

  ipcMain.handle(IPC_CHANNELS.notify, (event, body: unknown) => {
    if (denied(event, context)) {
      return;
    }
    const parsed = parseNotifyRequest(body);
    if (parsed === null) {
      return;
    }
    if (!loadSettings().notificationsEnabled) {
      return;
    }
    const window = context.window();
    if (window === null || window.isDestroyed() || window.isFocused()) {
      return;
    }
    const note = new Notification({ title: parsed.title, body: parsed.body });
    const clickPayload =
      parsed.channelId !== undefined
        ? parseNotificationClick({ channelId: parsed.channelId })
        : null;
    note.on("click", () => {
      const target = context.window();
      if (target !== null && !target.isDestroyed()) {
        if (target.isMinimized()) {
          target.restore();
        }
        target.show();
        target.focus();
        if (clickPayload !== null) {
          target.webContents.send(IPC_CHANNELS.notificationClick, clickPayload);
        }
      }
    });
    note.show();
  });

  ipcMain.handle(IPC_CHANNELS.setBadge, (event, body: unknown) => {
    if (denied(event, context)) {
      return;
    }
    const parsed = badgeSchema.safeParse(body);
    if (!parsed.success) {
      return;
    }
    try {
      app.setBadgeCount(parsed.data.count);
    } catch {
      // Unsupported platform: silently ignore (documented).
    }
  });

  ipcMain.handle(IPC_CHANNELS.screenPick, (event, body: unknown) => {
    if (denied(event, context)) {
      return false;
    }
    const validated = validateScreenPickResult(body);
    if (validated === null) {
      return false;
    }
    // Double validation (defense in depth: same schema, checked twice).
    const reparsed = screenPickResultSchema.safeParse(body);
    if (!reparsed.success) {
      return false;
    }
    return resolveScreenPick(validated.requestId, validated.sourceId);
  });

  ipcMain.handle(IPC_CHANNELS.getSetting, (event, body: unknown) => {
    // Desktop settings (tray, PTT key, mute shortcut) are managed on the
    // local connect screen only — the remote origin cannot read or flip
    // them (e.g. silently enabling the global key hook).
    const url = resolveIpcSenderUrl(event);
    if (url === undefined || !isConnectSender(url)) {
      return null;
    }
    const key = typeof body === "object" && body !== null && "key" in body ? body.key : null;
    return readAllowedSetting(loadSettings(), key);
  });

  ipcMain.handle(IPC_CHANNELS.setSetting, (event, body: unknown) => {
    const url = resolveIpcSenderUrl(event);
    if (url === undefined || !isConnectSender(url)) {
      return false;
    }
    const { next, changed } = applySettingsPatch(loadSettings(), body);
    if (changed) {
      saveSettings(next);
    }
    return changed;
  });
}

export function openExternalSafe(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  // Allowlist: http(s) only. Everything else (file:, javascript:, custom
  // schemes) is dropped on the floor.
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    void shell.openExternal(parsed.toString());
  }
}
