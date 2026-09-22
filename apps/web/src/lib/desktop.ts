/**
 * Desktop bridge detection for the web client. The app runs unchanged in a
 * plain browser (`window.desktop` undefined); inside Electron the preload
 * exposes a `window.desktop` object validated field-by-field here so a
 * compromised or outdated bridge cannot crash the client — missing fields
 * degrade to browser behavior.
 */
export interface DesktopSource {
  id: string;
  name: string;
  thumbnail: string;
}

export interface DesktopPickerRequest {
  requestId: string;
  sources: DesktopSource[];
}

export interface DesktopCapabilities {
  globalPtt: boolean;
  globalPttReason: string | null;
  screenPicker: boolean;
  systemAudio: "windows-loopback" | "unsupported";
}

export interface DesktopBridge {
  platform: "win32" | "linux" | "darwin";
  getVersion: () => Promise<string>;
  getCapabilities: () => Promise<DesktopCapabilities>;
  notify: (title: string, body: string, channelId?: string) => Promise<void>;
  setBadge: (count: number) => Promise<void>;
  onShowPicker: (callback: (request: DesktopPickerRequest) => void) => () => void;
  pickScreenSource: (requestId: string, sourceId: string) => Promise<void>;
  onPttKey: (callback: (active: boolean) => void) => () => void;
  onToggleMute: (callback: () => void) => () => void;
  onNotificationClick: (callback: (channelId: string) => void) => () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDesktopSource(value: unknown): value is DesktopSource {
  return (
    isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["name"] === "string" &&
    typeof value["thumbnail"] === "string"
  );
}

/** Null when not running inside the desktop app (plain browser). */
export function getDesktopBridge(): DesktopBridge | null {
  const candidate: unknown =
    typeof window === "undefined" ? undefined : (window as { desktop?: unknown }).desktop;
  if (!isRecord(candidate)) {
    return null;
  }
  const required = [
    "platform",
    "getVersion",
    "getCapabilities",
    "notify",
    "setBadge",
    "onShowPicker",
    "pickScreenSource",
    "onPttKey",
    "onToggleMute",
    "onNotificationClick",
  ] as const;
  for (const key of required) {
    if (
      (key === "platform" && typeof candidate[key] !== "string") ||
      (key !== "platform" && typeof candidate[key] !== "function")
    ) {
      return null;
    }
  }
  if (
    candidate["platform"] !== "win32" &&
    candidate["platform"] !== "linux" &&
    candidate["platform"] !== "darwin"
  ) {
    return null;
  }
  return candidate as unknown as DesktopBridge;
}

export function isDesktop(): boolean {
  return getDesktopBridge() !== null;
}

/** Validate an inbound notification-click before navigating (main is trusted, but be strict). */
export function parseNotificationClick(body: unknown): string | null {
  if (!isRecord(body)) {
    return null;
  }
  const channelId = body["channelId"];
  if (typeof channelId !== "string" || channelId.length === 0 || channelId.length > 128) {
    return null;
  }
  return channelId;
}

/** Validate an inbound picker request before rendering (main is trusted, but be strict). */
export function parsePickerRequest(body: unknown): DesktopPickerRequest | null {
  if (!isRecord(body)) {
    return null;
  }
  if (typeof body["requestId"] !== "string" || body["requestId"].length === 0) {
    return null;
  }
  if (!Array.isArray(body["sources"])) {
    return null;
  }
  if (body["sources"].length > 64) {
    return null;
  }
  const sources: DesktopSource[] = [];
  for (const entry of body["sources"]) {
    if (!isDesktopSource(entry)) {
      return null;
    }
    sources.push({ id: entry.id, name: entry.name, thumbnail: entry.thumbnail });
  }
  return { requestId: body["requestId"], sources };
}
