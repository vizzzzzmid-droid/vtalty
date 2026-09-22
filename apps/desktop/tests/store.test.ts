import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const holder = globalThis as unknown as { __vitalityUserData?: string };

vi.mock("electron", () => ({
  app: {
    getPath: (): string => {
      const dir = holder.__vitalityUserData;
      if (dir === undefined) {
        throw new Error("userData dir not set for test");
      }
      return dir;
    },
  },
}));

import { loadSettings, rememberServer, saveSettings } from "../src/store.js";

let root = "";

function settingsFile(): string {
  return join(root, "vitality-desktop.json");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vitality-desktop-test-"));
  holder.__vitalityUserData = root;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loadSettings", () => {
  it("returns defaults when the file is missing", () => {
    const settings = loadSettings();
    expect(settings.minimizeToTray).toBe(true);
    expect(settings.notificationsEnabled).toBe(true);
    expect(settings.startMinimized).toBe(false);
    expect(settings.recentServers).toEqual([]);
    expect(settings.windowBounds).toBeNull();
  });

  it("falls back to defaults on corrupt files", () => {
    for (const bad of ["{not json", "[1,2,3]", "null", "42", ""]) {
      writeFileSync(settingsFile(), bad, "utf8");
      const settings = loadSettings();
      expect(settings.minimizeToTray).toBe(true);
      expect(settings.notificationsEnabled).toBe(true);
    }
  });

  it("falls back to defaults when field types are wrong", () => {
    writeFileSync(
      settingsFile(),
      JSON.stringify({ minimizeToTray: "yes", globalPttKeycode: -5 }),
      "utf8",
    );
    const settings = loadSettings();
    expect(settings.minimizeToTray).toBe(true);
    expect(settings.globalPttKeycode).toBe(41);
  });

  it("migrates step-1 files (missing new keys get defaults, old kept)", () => {
    writeFileSync(
      settingsFile(),
      JSON.stringify({
        recentServers: [{ url: "https://voice.example.com", lastUsed: 123 }],
        minimizeToTray: false,
        globalPttKeycode: 30,
      }),
      "utf8",
    );
    const settings = loadSettings();
    expect(settings.minimizeToTray).toBe(false);
    expect(settings.globalPttKeycode).toBe(30);
    expect(settings.notificationsEnabled).toBe(true);
    expect(settings.recentServers).toEqual([
      { url: "https://voice.example.com", lastUsed: 123 },
    ]);
  });

  it("round-trips through save", () => {
    const loaded = loadSettings();
    saveSettings({ ...loaded, startMinimized: true, notificationsEnabled: false });
    const again = loadSettings();
    expect(again.startMinimized).toBe(true);
    expect(again.notificationsEnabled).toBe(false);
  });

  it("creates missing parent directories on save", () => {
    const nested = join(root, "deep", "nested");
    mkdirSync(nested, { recursive: true });
    holder.__vitalityUserData = nested;
    const loaded = loadSettings();
    saveSettings({ ...loaded, startMinimized: true });
    expect(loadSettings().startMinimized).toBe(true);
  });
});

describe("rememberServer", () => {
  it("prepends, dedupes, and caps recent servers at 8", () => {
    for (let index = 0; index < 10; index += 1) {
      rememberServer(`https://srv${index}.example.com`);
    }
    let settings = loadSettings();
    expect(settings.recentServers).toHaveLength(8);
    expect(settings.recentServers[0]?.url).toBe("https://srv9.example.com");

    rememberServer("https://srv5.example.com");
    settings = loadSettings();
    expect(settings.recentServers).toHaveLength(8);
    expect(settings.recentServers[0]?.url).toBe("https://srv5.example.com");
    expect(
      settings.recentServers.filter((entry) => entry.url === "https://srv5.example.com"),
    ).toHaveLength(1);
  });
});
