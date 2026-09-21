import type { BrowserWindow } from "electron";
import { desktopCapturer } from "electron";
import { randomUUID } from "node:crypto";
import { IPC_CHANNELS, screenPickResultSchema, type ScreenSource } from "./shared.js";

interface PendingPick {
  requestId: string;
  resolve: (sourceId: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

const PICK_TIMEOUT_MS = 120_000;
const pending = new Map<string, PendingPick>();

/**
 * Screen sources for the custom picker (thumbnails included). Runs in main
 * because desktopCapturer is main-side only.
 */
export async function listScreenSources(window: BrowserWindow): Promise<ScreenSource[]> {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons: true,
  });
  void window;
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    thumbnail: source.thumbnail.isEmpty() ? "" : source.thumbnail.toDataURL(),
  }));
}

/**
 * Ask the renderer (custom React picker) to resolve a display-media
 * request. Sources are fetched up-front so the dialog opens with
 * thumbnails ready. Resolves null on timeout/cancel — the caller must
 * then deny the capture.
 */
export async function requestScreenPick(
  window: BrowserWindow,
): Promise<{ requestId: string; sourceId: string | null; sources: ScreenSource[] }> {
  const sources = await listScreenSources(window);
  const requestId = randomUUID();
  const sourceId = await new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve(null);
    }, PICK_TIMEOUT_MS);
    pending.set(requestId, { requestId, resolve, timer });
    window.webContents.send(IPC_CHANNELS.showPicker, { requestId, sources });
  });
  return { requestId, sourceId, sources };
}

/** Called by the `screenPick` IPC handler after zod validation. */
export function resolveScreenPick(requestId: string, sourceId: string): boolean {
  const entry = pending.get(requestId);
  if (entry === undefined) {
    return false;
  }
  clearTimeout(entry.timer);
  pending.delete(requestId);
  entry.resolve(sourceId.length > 0 ? sourceId : null);
  return true;
}

/** Drop all pending picks (window closed / navigation). */
export function cancelScreenPicks(): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.resolve(null);
  }
  pending.clear();
}

export function validateScreenPickResult(body: unknown): { requestId: string; sourceId: string } | null {
  const parsed = screenPickResultSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}
