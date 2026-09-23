/**
 * Packaging-metadata consistency guards (Windows app identity).
 *
 * Windows groups an app's windows, processes and shortcuts by the
 * AppUserModelID: electron-builder's NSIS installer stamps `${APP_ID}` on the
 * shortcuts it creates (installer.nsh → WinShell::SetLnkAUMI) and the running
 * app must declare the same ID — otherwise Task Manager lists the Electron
 * helper processes as separate flat entries instead of one app group.
 * The exe version resource is written by
 * app-builder-lib/out/winPackager.js from: FileDescription + ProductName =
 * `productName`, InternalName = executable basename, CompanyName =
 * package.json `author.name`, LegalCopyright = `copyright`, FileVersion /
 * ProductVersion = package `version`.
 *
 * These tests read the real config files, so config and code cannot drift.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_ID, PRODUCT_NAME } from "../src/identity.js";

/** Vitest runs from the package dir (`pnpm --filter`); accept the repo root too. */
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

const builderYml = readFileSync(packageFile("electron-builder.yml"), "utf8");
const packageJson = JSON.parse(readFileSync(packageFile("package.json"), "utf8")) as {
  name?: string;
  version?: string;
  productName?: string;
  description?: string;
  author?: { name?: string };
};
const mainSource = readFileSync(path.join(path.dirname(packageFile("package.json")), "src", "main.ts"), "utf8");

/** Reads the first `key: value` occurrence in electron-builder.yml (any depth). */
function ymlValue(key: string): string | null {
  const match = new RegExp(`^[ \\t]*${key}:[ \\t]*(.+)$`, "m").exec(builderYml);
  const value = match?.[1]?.trim();
  return value === undefined || value.length === 0 ? null : value;
}

describe("Windows app identity", () => {
  it("runtime AppUserModelID equals the installer's appId", () => {
    expect(ymlValue("appId")).toBe(APP_ID);
  });

  it("wires the AUMID into main before any window exists", () => {
    // Source-level guard: the config value alone does nothing without the call.
    expect(mainSource).toMatch(/process\.platform === "win32"/);
    expect(mainSource).toMatch(/app\.setAppUserModelId\(APP_ID\)/);
  });

  it("keeps productName identical in package.json and electron-builder.yml", () => {
    expect(packageJson.productName).toBe(PRODUCT_NAME);
    expect(ymlValue("productName")).toBe(PRODUCT_NAME);
  });

  it("does not leak the workspace package name into the app identity", () => {
    // Electron prefers `productName` for app.getName() (userData dir, default
    // identity); without it the name would be the scoped "@vitality/desktop".
    expect(packageJson.name).toBe("@vitality/desktop");
    expect(packageJson.productName).not.toBe(packageJson.name);
    expect(PRODUCT_NAME).not.toContain("@");
  });

  it("names the executable exactly like the product (InternalName == ProductName)", () => {
    expect(ymlValue("executableName")).toBe(PRODUCT_NAME);
    expect(PRODUCT_NAME).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("names the Start Menu shortcut like the product", () => {
    expect(ymlValue("shortcutName")).toBe(PRODUCT_NAME);
  });

  it("provides every source field the exe version resource needs", () => {
    expect(packageJson.author?.name).toBeTruthy(); // CompanyName
    expect(packageJson.description).toBeTruthy(); // NSIS shortcut description
    expect(ymlValue("copyright")).toBeTruthy(); // LegalCopyright
    // FileVersion/ProductVersion must be numeric-dotted for Windows.
    expect(packageJson.version).toMatch(/^\d+(\.\d+){1,3}$/);
  });
});
