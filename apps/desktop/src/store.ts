import { app } from "electron";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Persisted desktop settings (JSON in userData, zod-validated on load;
 * corrupt files fall back to defaults rather than crashing).
 */
const settingsSchema = z.object({
  recentServers: z.array(
    z.object({
      url: z.string().min(1).max(2048),
      lastUsed: z.number().int().nonnegative(),
    }),
  ).default([]),
  windowBounds: z
    .object({
      x: z.number().int().nullable(),
      y: z.number().int().nullable(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .nullable()
    .default(null),
  windowMaximized: z.boolean().default(false),
  startMinimized: z.boolean().default(false),
  minimizeToTray: z.boolean().default(true),
  globalPttEnabled: z.boolean().default(false),
  globalPttKeycode: z.number().int().min(0).max(65535).default(41),
  globalMuteShortcut: z.boolean().default(true),
});

export type DesktopSettings = z.infer<typeof settingsSchema>;

const DEFAULTS: DesktopSettings = {
  recentServers: [],
  windowBounds: null,
  windowMaximized: false,
  startMinimized: false,
  minimizeToTray: true,
  globalPttEnabled: false,
  globalPttKeycode: 41, // Backquote (`) in uiohook keycodes
  globalMuteShortcut: true,
};

function filePath(): string {
  return path.join(app.getPath("userData"), "vitality-desktop.json");
}

export function loadSettings(): DesktopSettings {
  try {
    const raw: unknown = JSON.parse(readFileSync(filePath(), "utf8"));
    const parsed = settingsSchema.safeParse(raw);
    if (parsed.success) {
      return { ...DEFAULTS, ...parsed.data };
    }
  } catch {
    // Missing or corrupt file: fall through to defaults.
  }
  return { ...DEFAULTS };
}

export function saveSettings(settings: DesktopSettings): void {
  const parsed = settingsSchema.parse(settings);
  mkdirSync(path.dirname(filePath()), { recursive: true });
  writeFileSync(filePath(), JSON.stringify(parsed, null, 2), "utf8");
}

export function rememberServer(url: string): DesktopSettings {
  const settings = loadSettings();
  const rest = settings.recentServers.filter((entry) => entry.url !== url);
  const next: DesktopSettings = {
    ...settings,
    recentServers: [{ url, lastUsed: Date.now() }, ...rest].slice(0, 8),
  };
  saveSettings(next);
  return next;
}
