/**
 * Regression tests for runtime rebinding of the PTT hook and the global
 * mute shortcut.
 *
 * Bug: `setSetting` persisted new key settings, but the already-registered
 * global shortcut / PTT hook was never rebound — the old key stayed grabbed
 * and the new one was ignored until the app was restarted. Fixed by
 * unregistering the OLD accelerator before registering the new one and by
 * hot-swapping the keycode the running hook compares against.
 *
 * `electron` is mocked (the OS APIs are unavailable under vitest): the fake
 * globalShortcut records register/unregister calls in order, and the fake
 * uiohook module lets a test synthesize raw key events.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const holder = globalThis as unknown as { __vitalityUserData?: string };

const calls: string[] = [];
let registeredAccelerator: string | null = null;
let nextRegisterResult = true;
const keydownListeners: Array<(event: { keycode: number }) => void> = [];
const keyupListeners: Array<(event: { keycode: number }) => void> = [];

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
  globalShortcut: {
    register: (accelerator: string): boolean => {
      calls.push(`register:${accelerator}`);
      if (nextRegisterResult) {
        registeredAccelerator = accelerator;
      }
      return nextRegisterResult;
    },
    unregister: (accelerator: string): void => {
      calls.push(`unregister:${accelerator}`);
      if (registeredAccelerator === accelerator) {
        registeredAccelerator = null;
      }
    },
    unregisterAll: (): void => {
      calls.push("unregisterAll");
      registeredAccelerator = null;
    },
    isRegistered: (accelerator: string): boolean =>
      registeredAccelerator === accelerator,
  },
}));

vi.mock("uiohook-napi", () => ({
  uIOhook: {
    on: (event: string, listener: (event: { keycode: number }) => void): void => {
      if (event === "keydown") {
        keydownListeners.push(listener);
      } else if (event === "keyup") {
        keyupListeners.push(listener);
      }
    },
    start: (): void => {
      calls.push("hook:start");
    },
    stop: (): void => {
      calls.push("hook:stop");
    },
    removeAllListeners: (event: string): void => {
      calls.push(`hook:removeAllListeners:${event}`);
      if (event === "keydown") {
        keydownListeners.length = 0;
      } else if (event === "keyup") {
        keyupListeners.length = 0;
      }
    },
  },
}));

import {
  getBoundPttKeycode,
  getRegisteredMuteAccelerator,
  registerMuteShortcut,
  rebindGlobalKeys,
  resolveMuteAccelerator,
  stopGlobalPtt,
  unregisterMuteShortcut,
} from "../src/ptt.js";
import { loadSettings, saveSettings, type DesktopSettings } from "../src/store.js";

let root = "";
let pttState: boolean[] = [];

function emitKey(keycode: number, phase: "down" | "up"): void {
  const listeners = phase === "down" ? keydownListeners : keyupListeners;
  for (const listener of [...listeners]) {
    listener({ keycode });
  }
}

function settingsWith(patch: Partial<DesktopSettings>): DesktopSettings {
  return { ...loadSettings(), ...patch };
}

/**
 * A `BrowserWindow` stub exposing exactly the surface ptt.js touches. Cast
 * through `unknown` so the fake stays small without fighting the 180-member
 * Electron class; the assertions below pin the behaviour, not the type.
 */
type FakeWindow = {
  isDestroyed: () => boolean;
  webContents: { send: (channel: string, body: unknown) => void };
};

function fakeWindow(): FakeWindow {
  return {
    isDestroyed: () => false,
    webContents: {
      send: () => {
        calls.push("webContents:send");
      },
    },
  };
}

function asBrowserWindow(window: FakeWindow): BrowserWindow {
  return window as unknown as BrowserWindow;
}

/**
 * Mirror the main-side IPC flow exactly: persist first, then rebind — the
 * rebind functions read the store (a single source of truth, so a
 * hand-edited config and the runtime can never disagree).
 */
async function applyAndRebind(window: FakeWindow, patch: Partial<DesktopSettings>): Promise<void> {
  const before = loadSettings();
  const next = settingsWith(patch);
  saveSettings(next);
  await rebindGlobalKeys(
    asBrowserWindow(window),
    before,
    next,
    (active: boolean) => pttState.push(active),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vitality-rebind-test-"));
  holder.__vitalityUserData = root;
  // Stop any hook a previous test left running BEFORE clearing the call log,
  // so the stop does not pollute this test's expectations.
  stopGlobalPtt();
  calls.length = 0;
  registeredAccelerator = null;
  nextRegisterResult = true;
  keydownListeners.length = 0;
  keyupListeners.length = 0;
  pttState = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveMuteAccelerator", () => {
  it("returns the stored accelerator when it is valid", () => {
    expect(
      resolveMuteAccelerator({
        globalMuteShortcut: true,
        globalMuteAccelerator: "Ctrl+Shift+M",
      }),
    ).toBe("Ctrl+Shift+M");
  });

  it("falls back to the default for a corrupt stored value", () => {
    expect(
      resolveMuteAccelerator({
        globalMuteShortcut: true,
        globalMuteAccelerator: "Alt+F4",
      }),
    ).toMatch(/CommandOrControl\+Shift\+M/);
  });

  it("returns null when the feature is disabled", () => {
    expect(
      resolveMuteAccelerator({
        globalMuteShortcut: false,
        globalMuteAccelerator: "Ctrl+Shift+M",
      }),
    ).toBeNull();
  });
});

describe("registerMuteShortcut (rebind)", () => {
  it("registers the stored accelerator at boot", () => {
    saveSettings(settingsWith({ globalMuteShortcut: true, globalMuteAccelerator: "Ctrl+Alt+P" }));
    expect(registerMuteShortcut(asBrowserWindow(fakeWindow()))).toBe(true);
    expect(getRegisteredMuteAccelerator()).toBe("Ctrl+Alt+P");
    expect(calls).toContain("register:Ctrl+Alt+P");
  });

  it("unregisters the OLD accelerator before registering the new one", () => {
    saveSettings(settingsWith({ globalMuteShortcut: true, globalMuteAccelerator: "Ctrl+Alt+P" }));
    const window = asBrowserWindow(fakeWindow());
    registerMuteShortcut(window);
    calls.length = 0;

    saveSettings(settingsWith({ globalMuteShortcut: true, globalMuteAccelerator: "Ctrl+Alt+K" }));
    expect(registerMuteShortcut(window)).toBe(true);

    // The regression: without the unregister, the old accelerator stayed
    // grabbed and the new one was never registered.
    expect(calls).toEqual(["unregister:Ctrl+Alt+P", "register:Ctrl+Alt+K"]);
    expect(getRegisteredMuteAccelerator()).toBe("Ctrl+Alt+K");
    // The old key really is gone from the OS.
    expect(calls.filter((call) => call.startsWith("unregister"))).toHaveLength(1);
  });

  it("re-registers the same accelerator (idempotent rebind)", () => {
    saveSettings(settingsWith({ globalMuteShortcut: true, globalMuteAccelerator: "Ctrl+Alt+P" }));
    const window = asBrowserWindow(fakeWindow());
    registerMuteShortcut(window);
    calls.length = 0;

    // Re-saving the same value must not leave a stale registration behind.
    expect(registerMuteShortcut(window)).toBe(true);
    expect(calls).toEqual(["unregister:Ctrl+Alt+P", "register:Ctrl+Alt+P"]);
    expect(getRegisteredMuteAccelerator()).toBe("Ctrl+Alt+P");
  });

  it("survives several consecutive changes (C1 -> C2 -> C3 -> off -> on)", () => {
    saveSettings(settingsWith({ globalMuteShortcut: true, globalMuteAccelerator: "Ctrl+Alt+P" }));
    const window = asBrowserWindow(fakeWindow());
    registerMuteShortcut(window);

    for (const accelerator of ["Ctrl+Alt+K", "Ctrl+Alt+L", "Shift+F9", "Ctrl+Alt+P"]) {
      saveSettings(settingsWith({ globalMuteShortcut: true, globalMuteAccelerator: accelerator }));
      expect(registerMuteShortcut(window)).toBe(true);
      expect(getRegisteredMuteAccelerator()).toBe(accelerator);
    }

    // Disabling removes the last bound key.
    saveSettings(settingsWith({ globalMuteShortcut: false }));
    expect(registerMuteShortcut(window)).toBe(false);
    expect(getRegisteredMuteAccelerator()).toBe("");
    expect(calls[calls.length - 1]).toBe("unregister:Ctrl+Alt+P");

    // Re-enabling binds the current stored value again.
    saveSettings(settingsWith({ globalMuteShortcut: true }));
    expect(registerMuteShortcut(window)).toBe(true);
    expect(getRegisteredMuteAccelerator()).toBe("Ctrl+Alt+P");
  });

  it("unregisters on disable even when the stored accelerator is invalid", () => {
    // A hand-edited config: the boot registration fell back to the default.
    saveSettings(settingsWith({ globalMuteShortcut: true, globalMuteAccelerator: "Ctrl+Alt+P" }));
    const window = asBrowserWindow(fakeWindow());
    registerMuteShortcut(window);
    calls.length = 0;

    saveSettings(settingsWith({ globalMuteShortcut: false, globalMuteAccelerator: "Alt+F4" }));
    expect(registerMuteShortcut(window)).toBe(false);
    expect(getRegisteredMuteAccelerator()).toBe("");
    expect(calls).toContain("unregister:Ctrl+Alt+P");
  });

  it("keeps nothing registered when the feature is off at boot", () => {
    saveSettings(settingsWith({ globalMuteShortcut: false }));
    expect(registerMuteShortcut(asBrowserWindow(fakeWindow()))).toBe(false);
    expect(calls.filter((call) => call.startsWith("register"))).toHaveLength(0);
  });

  it("releases the old key even when the new registration fails", () => {
    saveSettings(settingsWith({ globalMuteShortcut: true, globalMuteAccelerator: "Ctrl+Alt+P" }));
    const window = asBrowserWindow(fakeWindow());
    expect(registerMuteShortcut(window)).toBe(true);
    calls.length = 0;

    // The OS rejects the new combo (e.g. another app owns it). The old key
    // must still be released — a failed rebind must never leave a stale key
    // grabbed, nor report a phantom accelerator as bound.
    nextRegisterResult = false;
    saveSettings(settingsWith({ globalMuteShortcut: true, globalMuteAccelerator: "Ctrl+Alt+K" }));
    expect(registerMuteShortcut(window)).toBe(false);
    expect(getRegisteredMuteAccelerator()).toBe("");
    expect(calls).toEqual(["unregister:Ctrl+Alt+P", "register:Ctrl+Alt+K"]);
  });

  it("unregisterMuteShortcut releases the bound key", () => {
    saveSettings(settingsWith({ globalMuteShortcut: true, globalMuteAccelerator: "Ctrl+Alt+P" }));
    registerMuteShortcut(asBrowserWindow(fakeWindow()));
    calls.length = 0;
    unregisterMuteShortcut();
    expect(getRegisteredMuteAccelerator()).toBe("");
    expect(calls).toEqual(["unregister:Ctrl+Alt+P"]);
    // Idempotent: a second call touches nothing.
    calls.length = 0;
    unregisterMuteShortcut();
    expect(calls).toHaveLength(0);
  });
});

describe("PTT hook rebind", () => {
  it("compares against the live keycode, not the boot-time one", async () => {
    const window = asBrowserWindow(fakeWindow());
    await applyAndRebind(window, { globalPttEnabled: true, globalPttKeycode: 41 });

    emitKey(41, "down");
    expect(pttState).toEqual([true]);
    pttState.length = 0;

    // Rebind to KeyV WITHOUT restarting the hook (only the compared keycode
    // changes; the OS hook keeps running).
    await applyAndRebind(window, { globalPttKeycode: 47 });
    expect(getBoundPttKeycode()).toBe(47);

    // The old key no longer triggers PTT.
    emitKey(41, "down");
    expect(pttState).toEqual([]);
    // The new key does.
    emitKey(47, "down");
    expect(pttState).toEqual([true]);
  });

  it("starts the hook when global PTT is enabled at runtime", async () => {
    const window = asBrowserWindow(fakeWindow());
    await applyAndRebind(window, { globalPttEnabled: false });

    await applyAndRebind(window, { globalPttEnabled: true, globalPttKeycode: 47 });
    expect(calls).toContain("hook:start");
    expect(getBoundPttKeycode()).toBe(47);

    // The newly bound key works immediately.
    pttState.length = 0;
    emitKey(47, "down");
    expect(pttState).toEqual([true]);
  });

  it("stops the hook when global PTT is disabled at runtime", async () => {
    const window = asBrowserWindow(fakeWindow());
    await applyAndRebind(window, { globalPttEnabled: true, globalPttKeycode: 41 });

    await applyAndRebind(window, { globalPttEnabled: false });
    expect(calls).toContain("hook:stop");
    // No listener leaks: a key event after disable triggers nothing.
    pttState.length = 0;
    emitKey(41, "down");
    expect(pttState).toEqual([]);
  });

  it("ignores key settings while PTT is disabled", async () => {
    const window = asBrowserWindow(fakeWindow());
    await applyAndRebind(window, { globalPttEnabled: false });

    await applyAndRebind(window, { globalPttKeycode: 47 });
    expect(getBoundPttKeycode()).toBe(47);
    expect(calls).not.toContain("hook:start");
  });
});

describe("rebindGlobalKeys (combined)", () => {
  it("rebinds the shortcut and the PTT key in one pass", async () => {
    const window = asBrowserWindow(fakeWindow());
    await applyAndRebind(window, {
      globalPttEnabled: true,
      globalPttKeycode: 41,
      globalMuteShortcut: true,
      globalMuteAccelerator: "Ctrl+Alt+P",
    });
    calls.length = 0;

    await applyAndRebind(window, {
      globalPttKeycode: 47,
      globalMuteAccelerator: "Ctrl+Alt+K",
    });

    expect(calls).toEqual(["unregister:Ctrl+Alt+P", "register:Ctrl+Alt+K"]);
    expect(getRegisteredMuteAccelerator()).toBe("Ctrl+Alt+K");
    expect(getBoundPttKeycode()).toBe(47);
    // The hook keeps running: no restart churn for a pure key swap.
    expect(calls).not.toContain("hook:stop");
  });

  it("leaves both bindings untouched when nothing changed", async () => {
    const window = asBrowserWindow(fakeWindow());
    await applyAndRebind(window, {
      globalPttEnabled: true,
      globalPttKeycode: 41,
      globalMuteShortcut: true,
      globalMuteAccelerator: "Ctrl+Alt+P",
    });
    calls.length = 0;

    await applyAndRebind(window, {});
    expect(calls).toHaveLength(0);
    expect(getRegisteredMuteAccelerator()).toBe("Ctrl+Alt+P");
  });

  it("conflict guard: the accelerator and the PTT key can share a key", async () => {
    // rebindGlobalKeys owns no conflict rule (both subsystems stay live);
    // the UI rejects the shared key, and this asserts the layers do not
    // double-fire: rebinding the accelerator must not touch the PTT key.
    const window = asBrowserWindow(fakeWindow());
    await applyAndRebind(window, {
      globalPttEnabled: true,
      globalPttKeycode: 50, // KeyM
      globalMuteShortcut: true,
      globalMuteAccelerator: "Ctrl+Shift+M",
    });
    calls.length = 0;

    await applyAndRebind(window, { globalMuteAccelerator: "Ctrl+Alt+M" });
    expect(getRegisteredMuteAccelerator()).toBe("Ctrl+Alt+M");
    expect(getBoundPttKeycode()).toBe(50);
    expect(calls).not.toContain("hook:stop");

    // PTT still works on the shared physical key.
    pttState.length = 0;
    emitKey(50, "down");
    expect(pttState).toEqual([true]);
  });
});
