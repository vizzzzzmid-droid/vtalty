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

test("runtime identity matches the packaged metadata", async () => {
  // package.json `productName` (not the scoped @vitality/desktop package name)
  // must drive app.getName() — it names the userData dir and, on Windows, the
  // default app identity. Runs on Linux CI too; the AUMID itself is Windows-only
  // and is covered by the packaged-app checks in docs/MANUAL_TESTS.md.
  const identity = await app.evaluate(({ app: electronApp }) => ({
    name: electronApp.getName(),
    userData: electronApp.getPath("userData"),
  }));
  expect(identity.name).toBe("vitality");
  expect(identity.userData.replace(/[\\/]+$/, "").endsWith("vitality")).toBe(true);
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

test("key settings rebind at runtime without a restart", async () => {
  // Regression: setSetting persisted the new keys but the already-registered
  // global shortcut / PTT hook kept the OLD binding until relaunch. This
  // drives the real IPC handler in the real main process and inspects
  // Electron's own globalShortcut registry, so it observes the OS-level
  // binding rather than the persisted store.
  const registered = (accelerator: string) =>
    app.evaluate(({ globalShortcut }, acc) => globalShortcut.isRegistered(acc), accelerator);

  // Pin a known starting binding (the boot default is
  // CommandOrControl+Shift+M, so set our own first).
  expect(await page.evaluate(() => window.desktop.setSetting("globalMuteAccelerator", "Ctrl+Alt+P"))).toBe(true);
  expect(await registered("Ctrl+Alt+P")).toBe(true);

  // Rebind to a new combo: the old one must be released and the new one
  // grabbed — in the same process, no restart.
  expect(await page.evaluate(() => window.desktop.setSetting("globalMuteAccelerator", "Ctrl+Alt+K"))).toBe(true);
  expect(await registered("Ctrl+Alt+P")).toBe(false);
  expect(await registered("Ctrl+Alt+K")).toBe(true);

  // The PTT keycode swaps live too (the hook compares against this value).
  expect(await page.evaluate(() => window.desktop.setSetting("globalPttKeycode", 47))).toBe(true);
  expect(await page.evaluate(() => window.desktop.getSetting("globalPttKeycode"))).toBe(47);

  // Restore the defaults so the suite stays order-independent.
  await page.evaluate(() => window.desktop.setSetting("globalMuteAccelerator", "Ctrl+Alt+P"));
  await page.evaluate(() => window.desktop.setSetting("globalPttKeycode", 41));
  expect(await registered("Ctrl+Alt+P")).toBe(true);
  expect(await registered("Ctrl+Alt+K")).toBe(false);
});
