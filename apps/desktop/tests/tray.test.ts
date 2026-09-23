import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FALLBACK_TRAY_PNG_BASE64,
  pickTrayIconPath,
  shouldHideToTray,
  trayIconCandidates,
} from "../src/tray.js";

function packageFile(name: string): string {
  const candidates = [process.cwd(), path.resolve(process.cwd(), "apps/desktop")];
  for (const dir of candidates) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`${name} not found (searched from ${process.cwd()})`);
}

describe("trayIconCandidates", () => {
  it("prefers the packaged resources dir, then the app root", () => {
    const candidates = trayIconCandidates("C:\\app\\resources", "C:\\app\\resources\\app.asar");
    expect(candidates).toEqual([
      path.join("C:\\app\\resources", "assets", "icon.png"),
      path.join("C:\\app\\resources\\app.asar", "assets", "icon.png"),
    ]);
  });

  it("works without resourcesPath (defensive)", () => {
    const candidates = trayIconCandidates(undefined, "/app");
    expect(candidates).toEqual([path.join("/app", "assets", "icon.png")]);
  });
});

describe("pickTrayIconPath", () => {
  it("returns the first path that exists", () => {
    const picked = pickTrayIconPath(
      ["/packaged/icon.png", "/dev/icon.png"],
      (candidate) => candidate === "/dev/icon.png",
    );
    expect(picked).toBe("/dev/icon.png");
  });

  it("returns null when no icon exists (caller must not hide the window)", () => {
    expect(pickTrayIconPath(["/a", "/b"], () => false)).toBeNull();
  });

  it("the dev project icon really exists in this repo", () => {
    const picked = pickTrayIconPath(trayIconCandidates(undefined, process.cwd()), existsSync);
    expect(picked).not.toBeNull();
  });
});

describe("shouldHideToTray", () => {
  it("hides only when the setting is on and a tray exists", () => {
    expect(shouldHideToTray(true, true)).toBe(true);
  });

  it("setting off → normal minimize/close (regression guard)", () => {
    expect(shouldHideToTray(false, true)).toBe(false);
    expect(shouldHideToTray(false, false)).toBe(false);
  });

  it("no tray → never hide, otherwise the window becomes unreachable", () => {
    expect(shouldHideToTray(true, false)).toBe(false);
  });
});

describe("fallback tray icon", () => {
  it("is a valid 16x16 PNG", () => {
    const png = Buffer.from(FALLBACK_TRAY_PNG_BASE64, "base64");
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(16);
    expect(png.readUInt32BE(20)).toBe(16);
  });
});

describe("electron-builder.yml ships the tray icon", () => {
  const yml = readFileSync(packageFile("electron-builder.yml"), "utf8");

  it("copies assets/ via extraResources (real file outside the asar)", () => {
    // Regression root cause: the `files:` allowlist omitted assets/ entirely,
    // so the packaged app created no tray icon while still hiding the window.
    const extraResources = /^extraResources:\n((?:[ \t]+.*\n?)*)/m.exec(yml);
    expect(extraResources?.[1] ?? "").toMatch(/from:\s*assets/);
    expect(extraResources?.[1] ?? "").toMatch(/to:\s*assets/);
  });

  it("keeps the icon file itself in the repo for the copy step", () => {
    expect(existsSync(packageFile("assets/icon.png"))).toBe(true);
  });
});
