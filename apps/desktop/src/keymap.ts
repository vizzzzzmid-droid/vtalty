/**
 * Key mapping + validation for global shortcuts (pure, unit-tested).
 *
 * The connect screen captures a DOM `KeyboardEvent.code`; the global hook
 * (uiohook-napi) reports numeric keycodes from its `UiohookKey` enum. This
 * module maps between them and validates user choices. Values below mirror
 * uiohook-napi 1.5.5's `UiohookKey` (verified against the installed
 * package, not invented).
 */

export const DOM_CODE_TO_KEYCODE: Record<string, number> = {
  Escape: 1,
  Digit1: 2,
  Digit2: 3,
  Digit3: 4,
  Digit4: 5,
  Digit5: 6,
  Digit6: 7,
  Digit7: 8,
  Digit8: 9,
  Digit9: 10,
  Digit0: 11,
  Minus: 12,
  Equal: 13,
  Backspace: 14,
  Tab: 15,
  KeyQ: 16,
  KeyW: 17,
  KeyE: 18,
  KeyR: 19,
  KeyT: 20,
  KeyY: 21,
  KeyU: 22,
  KeyI: 23,
  KeyO: 24,
  KeyP: 25,
  BracketLeft: 26,
  BracketRight: 27,
  Enter: 28,
  ControlLeft: 29,
  KeyA: 30,
  KeyS: 31,
  KeyD: 32,
  KeyF: 33,
  KeyG: 34,
  KeyH: 35,
  KeyJ: 36,
  KeyK: 37,
  KeyL: 38,
  Semicolon: 39,
  Quote: 40,
  Backquote: 41,
  ShiftLeft: 42,
  Backslash: 43,
  KeyZ: 44,
  KeyX: 45,
  KeyC: 46,
  KeyV: 47,
  KeyB: 48,
  KeyN: 49,
  KeyM: 50,
  Comma: 51,
  Period: 52,
  Slash: 53,
  ShiftRight: 54,
  NumpadMultiply: 55,
  AltLeft: 56,
  Space: 57,
  CapsLock: 58,
  F1: 59,
  F2: 60,
  F3: 61,
  F4: 62,
  F5: 63,
  F6: 64,
  F7: 65,
  F8: 66,
  F9: 67,
  F10: 68,
  NumLock: 69,
  ScrollLock: 70,
  Numpad7: 71,
  Numpad8: 72,
  Numpad9: 73,
  NumpadSubtract: 74,
  Numpad4: 75,
  Numpad5: 76,
  Numpad6: 77,
  NumpadAdd: 78,
  Numpad1: 79,
  Numpad2: 80,
  Numpad3: 81,
  Numpad0: 82,
  NumpadDecimal: 83,
  F11: 87,
  F12: 88,
  F13: 91,
  F14: 92,
  F15: 93,
  F16: 99,
  F17: 100,
  F18: 101,
  F19: 102,
  F20: 103,
  F21: 104,
  F22: 105,
  F23: 106,
  F24: 107,
  ControlRight: 3613,
  PrintScreen: 3639,
  AltRight: 3640,
  Home: 3655,
  ArrowUp: 57416,
  ArrowLeft: 57419,
  ArrowRight: 57421,
  ArrowDown: 57424,
  End: 3663,
  PageUp: 3657,
  PageDown: 3665,
  Insert: 3666,
  Delete: 3667,
  MetaLeft: 3675,
  MetaRight: 3676,
  NumpadDivide: 3637,
  NumpadEnter: 3612,
};

const KEYCODE_TO_LABEL: Record<number, string> = {};
for (const [code, keycode] of Object.entries(DOM_CODE_TO_KEYCODE)) {
  if (KEYCODE_TO_LABEL[keycode] === undefined) {
    KEYCODE_TO_LABEL[keycode] = code;
  }
}

/** Human label for a PTT keycode (fallback: raw number). */
export function keycodeLabel(keycode: number): string {
  return KEYCODE_TO_LABEL[keycode] ?? `key ${keycode}`;
}

/** DOM codes that must never become the global PTT key. */
const RESERVED_PTT_CODES = new Set([
  "Escape", // closes dialogs; stealing it globally breaks UX everywhere
  "Tab", // focus navigation
  "Enter", // activates buttons
  "Space", // buttons, scroll, games
  "Backspace", // destructive in text fields
  "ShiftLeft",
  "ShiftRight", // bare modifiers: unusable as hold-to-talk, break typing
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

/**
 * Validate a captured DOM code as the PTT key. Returns an error message or
 * null when the mapped keycode is acceptable.
 */
export function validatePttDomCode(domCode: string): { keycode: number } | { error: string } {
  const keycode = DOM_CODE_TO_KEYCODE[domCode];
  if (keycode === undefined) {
    return { error: `This key (${domCode}) cannot be used for push-to-talk.` };
  }
  if (RESERVED_PTT_CODES.has(domCode)) {
    return { error: "Pick a non-typing key (letters, digits, F-keys, Caps Lock work well)." };
  }
  return { keycode };
}

/** PTT hook predicate: only the bound key ever counts (pure, unit-tested). */
export function matchesPttKey(eventKeycode: unknown, wanted: number): boolean {
  return typeof eventKeycode === "number" && eventKeycode === wanted;
}

export const DEFAULT_MUTE_ACCELERATOR = "CommandOrControl+Shift+M";

const ACCELERATOR_MODIFIERS = new Set([
  "CommandOrControl",
  "Command",
  "Control",
  "Ctrl",
  "Alt",
  "Option",
  "AltGr",
  "Shift",
  "Super",
  "Meta",
]);

const ACCELERATOR_NAMED_KEYS = new Set([
  "Space", "Tab", "Enter", "Escape", "Backspace", "Delete", "Insert",
  "Home", "End", "PageUp", "PageDown", "Plus", "Up", "Down", "Left", "Right",
  ...Array.from({ length: 24 }, (_, index) => `F${index + 1}`),
]);

/** OS-reserved combos globalShortcut can never own (exact match, case-insensitive). */
const OS_RESERVED_ACCELERATORS = new Set([
  "alt+f4", // Windows: close window
  "commandorcontrol+alt+delete", // Windows: secure attention
  "ctrl+alt+delete",
]);

/**
 * Validate an Electron accelerator for the global toggle-mute shortcut.
 * Requires at least one modifier (a bare global key would swallow typing),
 * rejects OS-reserved combos. Returns an error message or null when valid.
 */
export function validateAccelerator(accelerator: string): string | null {
  const trimmed = accelerator.trim();
  if (trimmed.length === 0 || trimmed.length > 64) {
    return "Shortcut must be 1–64 characters.";
  }
  const parts = trimmed.split("+").map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) {
    return "Use the form Modifier+Key, e.g. Ctrl+Shift+M.";
  }
  const key = parts[parts.length - 1] as string;
  const modifiers = parts.slice(0, -1);
  if (modifiers.length === 0) {
    return "A modifier is required (Ctrl/Alt/Shift) so typing still works.";
  }
  for (const modifier of modifiers) {
    if (!ACCELERATOR_MODIFIERS.has(modifier)) {
      return `Unknown modifier "${modifier}".`;
    }
  }
  const singleChar = /^[A-Z0-9]$/i.test(key);
  if (!singleChar && !ACCELERATOR_NAMED_KEYS.has(key)) {
    return `Unknown key "${key}".`;
  }
  if (OS_RESERVED_ACCELERATORS.has(trimmed.toLowerCase())) {
    return "That combo is reserved by the OS and cannot be grabbed.";
  }
  return null;
}

/**
 * Best-effort conflict check: does the mute accelerator's main key resolve
 * to the same uiohook keycode as the bound PTT key? (They live in different
 * subsystems, but sharing one physical key is always a user mistake.)
 */
export function acceleratorConflictsPtt(accelerator: string, pttKeycode: number): boolean {
  const parts = accelerator.split("+").map((part) => part.trim());
  const key = parts[parts.length - 1] ?? "";
  const upper = key.toUpperCase();
  // Single letters/digits map to DOM codes KeyX/DigitN.
  let domCode: string | null = null;
  if (/^[A-Z]$/.test(upper)) {
    domCode = `Key${upper}`;
  } else if (/^[0-9]$/.test(upper)) {
    domCode = `Digit${upper}`;
  } else if (/^F\d{1,2}$/.test(upper)) {
    domCode = upper;
  } else {
    domCode = key;
  }
  const mapped = domCode !== null ? DOM_CODE_TO_KEYCODE[domCode] : undefined;
  return mapped !== undefined && mapped === pttKeycode;
}
