/**
 * Headless Electron smoke test (runs in CI under xvfb on ubuntu-latest,
 * and locally wherever a display exists). Boots the built app
 * (`tsc` dist, no packaging) and drives the connect screen through the
 * real preload bridge — no mocks.
 *
 * Deliberately NOT covered here (no display/input in CI): desktopCapturer
 * thumbnails, the uiohook global hook, real notification clicks, packaged
 * installer contents (verified via `gh run download` inspection instead).
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const electronBinary = createRequire(`${ROOT}/package.json`)("electron") as string;

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  app = await electron.launch({
    executablePath: electronBinary,
    args: [".", "--hidden"],
    cwd: ROOT,
    env: { ...process.env, VITALITY_SERVER_URL: "" },
  });
  page = await app.firstWindow();
});

test.afterAll(async () => {
  await app.close();
});

test("connect screen loads over the preload bridge", async () => {
  await expect(page).toHaveTitle(/vitality/);
  expect(page.url()).toContain("connect.html");
  const version = await page.evaluate(() => window.desktop.getVersion());
  expect(typeof version).toBe("string");
  expect(version.length).toBeGreaterThan(0);
});

test("server URL validation rejects junk without navigating", async () => {
  await page.fill("#url", "http://voice.example.com");
  await page.click("#connect-btn");
  await expect(page.locator("#error")).not.toBeEmpty();
  expect(page.url()).toContain("connect.html");
});

test("capabilities report the screen picker", async () => {
  const caps = await page.evaluate(() => window.desktop.getCapabilities());
  expect(caps.screenPicker).toBe(true);
  expect(["windows-loopback", "unsupported"]).toContain(caps.systemAudio);
});

test("screenPick with no pending request resolves false", async () => {
  const result = await page.evaluate(() =>
    window.desktop.pickScreenSource("no-such-request", "screen:0:0"),
  );
  expect(result).toBe(false);
});

test("bridge event subscriptions subscribe and release", async () => {
  const counts = await page.evaluate(() => {
    const offPicker = window.desktop.onShowPicker(() => undefined);
    const offPtt = window.desktop.onPttKey(() => undefined);
    const offMute = window.desktop.onToggleMute(() => undefined);
    const offClick = window.desktop.onNotificationClick(() => undefined);
    for (const off of [offPicker, offPtt, offMute, offClick]) {
      if (typeof off !== "function") {
        return "not-a-function";
      }
      off();
    }
    return "ok";
  });
  expect(counts).toBe("ok");
});
