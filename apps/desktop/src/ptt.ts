import { globalShortcut } from "electron";
import type { BrowserWindow } from "electron";
import { IPC_CHANNELS } from "./shared.js";
import { loadSettings } from "./store.js";
import { DEFAULT_MUTE_ACCELERATOR, matchesPttKey, validateAccelerator } from "./keymap.js";

export interface PttCapabilities {
  available: boolean;
  reason: string | null;
}

let hookActive = false;
let stopHook: (() => void) | null = null;

type UiohookModule = typeof import("uiohook-napi");

async function loadHook(): Promise<UiohookModule | null> {
  try {
    // uiohook-napi ships prebuilds (win32/linux/darwin); a missing or
    // unloadable binary (Wayland quirks, exotic arch) degrades gracefully.
    // Dynamic import keeps the module out of the startup path entirely.
    return await import("uiohook-napi");
  } catch {
    return null;
  }
}

/**
 * Global hold-to-talk via key-up/key-down hook. Electron's globalShortcut
 * only fires on press, so a real PTT needs the OS hook; where it is
 * unavailable (Wayland without permission, macOS without Input Monitoring
 * approval, missing prebuild) we report gracefully and the in-app
 * (tab-focused) PTT remains the fallback.
 */
export async function startGlobalPtt(
  window: BrowserWindow,
  onState: (active: boolean) => void,
): Promise<PttCapabilities> {
  stopGlobalPtt();
  const settings = loadSettings();
  if (!settings.globalPttEnabled) {
    return { available: false, reason: "disabled in settings" };
  }
  const hook = await loadHook();
  if (hook === null) {
    return {
      available: false,
      reason: "global key hook unavailable on this system (Wayland/macOS permissions?) — in-app PTT still works while the tab is focused",
    };
  }
  const wanted = settings.globalPttKeycode;
  // Privacy: the hook sees EVERY keystroke system-wide; the handlers below
  // compare only the bound keycode and never log, store, or forward anything
  // else. No keylogging — by construction, and asserted in review.
  const down = (event: { keycode?: unknown }): void => {
    if (matchesPttKey(event.keycode, wanted)) {
      onState(true);
      window.webContents.send(IPC_CHANNELS.pttKey, { active: true });
    }
  };
  const up = (event: { keycode?: unknown }): void => {
    if (matchesPttKey(event.keycode, wanted)) {
      onState(false);
      window.webContents.send(IPC_CHANNELS.pttKey, { active: false });
    }
  };
  try {
    hook.uIOhook.on("keydown", down);
    hook.uIOhook.on("keyup", up);
    hook.uIOhook.start();
  } catch {
    return { available: false, reason: "could not start the global key hook" };
  }
  hookActive = true;
  stopHook = () => {
    try {
      hook.uIOhook.stop();
    } catch {
      // Already stopped.
    }
    hook.uIOhook.removeAllListeners("keydown");
    hook.uIOhook.removeAllListeners("keyup");
  };
  return { available: true, reason: null };
}

export function stopGlobalPtt(): void {
  if (stopHook !== null) {
    stopHook();
    stopHook = null;
  }
  hookActive = false;
}

export function isGlobalPttActive(): boolean {
  return hookActive;
}

/**
 * Global toggle-mute via Electron's own shortcut (press-only is fine here).
 * The accelerator comes from settings; an invalid stored value falls back
 * to the default (validated again here so a hand-edited config cannot
 * register a bare typing key globally).
 */
export function registerMuteShortcut(window: BrowserWindow): boolean {
  const settings = loadSettings();
  if (!settings.globalMuteShortcut) {
    return false;
  }
  const accelerator =
    validateAccelerator(settings.globalMuteAccelerator) === null
      ? settings.globalMuteAccelerator
      : DEFAULT_MUTE_ACCELERATOR;
  try {
    const ok = globalShortcut.register(accelerator, () => {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.toggleMute);
      }
    });
    return ok;
  } catch {
    return false;
  }
}

export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll();
}
