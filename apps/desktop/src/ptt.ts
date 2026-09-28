import { globalShortcut } from "electron";
import type { BrowserWindow } from "electron";
import { IPC_CHANNELS } from "./shared.js";
import { loadSettings, type DesktopSettings } from "./store.js";
import { DEFAULT_MUTE_ACCELERATOR, matchesPttKey, validateAccelerator } from "./keymap.js";

export interface PttCapabilities {
  available: boolean;
  reason: string | null;
}

let hookActive = false;
let stopHook: (() => void) | null = null;
/**
 * The keycode the running hook compares every keystroke against. Updated by
 * rebindGlobalKeys() without restarting the OS hook, so a settings change is
 * live for the very next key event.
 */
let boundPttKeycode = 41;
/** The accelerator currently registered with the OS ("" = none bound). */
let registeredAccelerator = "";
/** The window the current shortcut fires into (set on first registration). */
let shortcutWindow: BrowserWindow | null = null;

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
  boundPttKeycode = settings.globalPttKeycode;
  const hook = await loadHook();
  if (hook === null) {
    return {
      available: false,
      reason: "global key hook unavailable on this system (Wayland/macOS permissions?) — in-app PTT still works while the tab is focused",
    };
  }
  // Privacy: the hook sees EVERY keystroke system-wide; the handlers below
  // compare only the bound keycode and never log, store, or forward anything
  // else. No keylogging — by construction, and asserted in review.
  // `boundPttKeycode` is read per event (never captured in a closure) so a
  // runtime rebind takes effect without restarting the hook.
  const down = (event: { keycode?: unknown }): void => {
    if (matchesPttKey(event.keycode, boundPttKeycode)) {
      onState(true);
      window.webContents.send(IPC_CHANNELS.pttKey, { active: true });
    }
  };
  const up = (event: { keycode?: unknown }): void => {
    if (matchesPttKey(event.keycode, boundPttKeycode)) {
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
 * Resolve the accelerator a settings value should bind right now: null when
 * the feature is disabled, the stored value when it parses, the default
 * otherwise. Pure, unit-tested.
 *
 * A hand-edited config can hold anything (the store schema is permissive on
 * purpose); this is the last validation before touching the OS.
 */
export function resolveMuteAccelerator(settings: {
  globalMuteShortcut: boolean;
  globalMuteAccelerator: string;
}): string | null {
  if (!settings.globalMuteShortcut) {
    return null;
  }
  return validateAccelerator(settings.globalMuteAccelerator) === null
    ? settings.globalMuteAccelerator
    : DEFAULT_MUTE_ACCELERATOR;
}

/**
 * Global toggle-mute via Electron's own shortcut (press-only is fine here).
 *
 * Idempotent rebinding: the OLD accelerator is ALWAYS unregistered before the
 * new one is registered — even when the two are equal, because register() on
 * an accelerator this process already owns is a silent no-op that would keep
 * a stale callback bound. This unregister-then-register is what makes a
 * settings change apply without a restart (the previous code only ever
 * called register(), so the old key stayed grabbed while the new one was
 * ignored — changes only appeared after relaunch).
 */
export function registerMuteShortcut(window: BrowserWindow): boolean {
  shortcutWindow = window;
  const accelerator = resolveMuteAccelerator(loadSettings());
  unregisterMuteShortcut();
  if (accelerator === null) {
    return false;
  }
  try {
    const ok = globalShortcut.register(accelerator, () => {
      const target = shortcutWindow;
      if (target !== null && !target.isDestroyed()) {
        target.webContents.send(IPC_CHANNELS.toggleMute);
      }
    });
    if (ok) {
      registeredAccelerator = accelerator;
    }
    return ok;
  } catch {
    return false;
  }
}

export function unregisterMuteShortcut(): void {
  if (registeredAccelerator.length > 0) {
    globalShortcut.unregister(registeredAccelerator);
    registeredAccelerator = "";
  }
}

export function getRegisteredMuteAccelerator(): string {
  return registeredAccelerator;
}

export function unregisterShortcuts(): void {
  registeredAccelerator = "";
  globalShortcut.unregisterAll();
}

/**
 * Apply a settings change to the live global key bindings without a restart.
 * Pure decisions first (which subsystems are affected), then the OS calls.
 *
 *   globalMuteShortcut / globalMuteAccelerator -> rebind the accelerator
 *   globalPttEnabled                              -> start or stop the OS hook
 *   globalPttKeycode                             -> hot-swap the compared key
 *
 * Returns what the PTT hook now reports, so the caller can surface a
 * degradation (e.g. the hook went unavailable) to the user.
 */
export async function rebindGlobalKeys(
  window: BrowserWindow,
  before: DesktopSettings,
  after: DesktopSettings,
  onState: (active: boolean) => void,
): Promise<PttCapabilities> {
  if (
    before.globalMuteShortcut !== after.globalMuteShortcut ||
    before.globalMuteAccelerator !== after.globalMuteAccelerator
  ) {
    registerMuteShortcut(window);
  }
  if (before.globalPttKeycode !== after.globalPttKeycode) {
    boundPttKeycode = after.globalPttKeycode;
  }
  if (!after.globalPttEnabled) {
    stopGlobalPtt();
    return { available: false, reason: "disabled in settings" };
  }
  if (before.globalPttEnabled !== after.globalPttEnabled || !hookActive) {
    // Enable path needs a hook start; the keycode swap above is picked up by
    // the running listeners otherwise.
    return startGlobalPtt(window, onState);
  }
  return { available: true, reason: null };
}

export function getBoundPttKeycode(): number {
  return boundPttKeycode;
}
