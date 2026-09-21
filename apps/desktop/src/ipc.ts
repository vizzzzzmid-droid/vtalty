import { app, ipcMain, Notification, shell, type BrowserWindow } from "electron";
import {
  IPC_CHANNELS,
  badgeSchema,
  connectRequestSchema,
  isConnectSender,
  isTrustedSender,
  normalizeServerUrl,
  notifySchema,
  screenPickResultSchema,
  serverUrlSchema,
} from "./shared.js";
import { resolveScreenPick } from "./picker.js";
import { loadSettings, rememberServer, saveSettings } from "./store.js";
import { validateScreenPickResult } from "./picker.js";

export interface IpcContext {
  window: () => BrowserWindow | null;
  instanceOrigin: () => string;
  loadInstance: (url: string) => Promise<void>;
  showConnectScreen: () => void;
}

/** Sender-frame origin check shared by every handler. */
function trusted(
  event: Electron.IpcMainInvokeEvent,
  context: IpcContext,
): boolean {
  const url: unknown = event.senderFrame?.url;
  return (
    typeof url === "string" && isTrustedSender(url, context.instanceOrigin())
  );
}

function denied(event: Electron.IpcMainInvokeEvent, context: IpcContext): boolean {
  return !trusted(event, context);
}

export function registerIpc(context: IpcContext): void {
  // Version/capabilities are safe to expose to both the connect screen and
  // the connected instance (no privileged action, no instance data).
  ipcMain.handle(IPC_CHANNELS.getVersion, (event) => {
    const url: unknown = event.senderFrame?.url;
    if (typeof url !== "string") {
      return "unknown";
    }
    const origin = context.instanceOrigin();
    if (!isTrustedSender(url, origin) && !isConnectSender(url)) {
      return "unknown";
    }
    return app.getVersion();
  });

  ipcMain.handle(IPC_CHANNELS.getCapabilities, (event) => {
    const url: unknown = event.senderFrame?.url;
    if (typeof url !== "string") {
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
    const url: unknown = event.senderFrame?.url;
    if (typeof url !== "string") {
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
    const url: unknown = event.senderFrame?.url;
    if (typeof url !== "string") {
      return [];
    }
    const origin = context.instanceOrigin();
    if (!isTrustedSender(url, origin) && !isConnectSender(url)) {
      return [];
    }
    return loadSettings().recentServers;
  });

  ipcMain.handle(IPC_CHANNELS.forgetServer, (event, body: unknown) => {
    // Recent-servers management belongs to the local connect screen.
    const url: unknown = event.senderFrame?.url;
    if (typeof url !== "string" || !isConnectSender(url)) {
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
    const parsed = notifySchema.safeParse(body);
    if (!parsed.success) {
      return;
    }
    const window = context.window();
    if (window !== null && !window.isFocused()) {
      new Notification({ title: parsed.data.title, body: parsed.data.body }).show();
    }
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
    if (denied(event, context)) {
      return null;
    }
    const key = typeof body === "object" && body !== null && "key" in body ? body.key : null;
    const allowed = new Set([
      "minimizeToTray",
      "startMinimized",
      "globalPttEnabled",
      "globalPttKeycode",
    ]);
    if (typeof key !== "string" || !allowed.has(key)) {
      return null;
    }
    const settings = loadSettings() as unknown as Record<string, unknown>;
    return settings[key] ?? null;
  });

  ipcMain.handle(IPC_CHANNELS.setSetting, (event, body: unknown) => {
    if (denied(event, context)) {
      return false;
    }
    if (typeof body !== "object" || body === null) {
      return false;
    }
    const record = body as Record<string, unknown>;
    const settings = loadSettings();
    const next = { ...settings };
    let changed = false;
    if (typeof record["minimizeToTray"] === "boolean") {
      next.minimizeToTray = record["minimizeToTray"];
      changed = true;
    }
    if (typeof record["startMinimized"] === "boolean") {
      next.startMinimized = record["startMinimized"];
      changed = true;
    }
    if (typeof record["globalPttEnabled"] === "boolean") {
      next.globalPttEnabled = record["globalPttEnabled"];
      changed = true;
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
