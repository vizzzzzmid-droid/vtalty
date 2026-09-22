import { describe, expect, it } from "vitest";
import {
  DOM_CODE_TO_KEYCODE,
  acceleratorConflictsPtt,
  keycodeLabel,
  matchesPttKey,
  validateAccelerator,
  validatePttDomCode,
} from "../src/keymap.js";

describe("DOM_CODE_TO_KEYCODE", () => {
  it("matches the uiohook-napi UiohookKey values", () => {
    // Spot checks against the installed package (not invented).
    expect(DOM_CODE_TO_KEYCODE["Backquote"]).toBe(41);
    expect(DOM_CODE_TO_KEYCODE["KeyQ"]).toBe(16);
    expect(DOM_CODE_TO_KEYCODE["Space"]).toBe(57);
    expect(DOM_CODE_TO_KEYCODE["F13"]).toBe(91);
    expect(DOM_CODE_TO_KEYCODE["CapsLock"]).toBe(58);
    expect(DOM_CODE_TO_KEYCODE["Escape"]).toBe(1);
    expect(DOM_CODE_TO_KEYCODE["ControlLeft"]).toBe(29);
    expect(DOM_CODE_TO_KEYCODE["MetaLeft"]).toBe(3675);
  });
});

describe("keycodeLabel", () => {
  it("names known keycodes, falls back to the number", () => {
    expect(keycodeLabel(41)).toBe("Backquote");
    expect(keycodeLabel(999999)).toBe("key 999999");
  });
});

describe("validatePttDomCode", () => {
  it("accepts ordinary keys", () => {
    expect(validatePttDomCode("Backquote")).toEqual({ keycode: 41 });
    expect(validatePttDomCode("CapsLock")).toEqual({ keycode: 58 });
    expect(validatePttDomCode("F9")).toEqual({ keycode: 67 });
  });

  it("rejects typing/reserved keys", () => {
    for (const code of [
      "Escape", "Tab", "Enter", "Space", "Backspace",
      "ShiftLeft", "ControlLeft", "AltLeft", "MetaLeft",
    ]) {
      const result = validatePttDomCode(code);
      expect("error" in result).toBe(true);
    }
  });

  it("rejects unknown codes", () => {
    const result = validatePttDomCode("ContextMenu");
    expect("error" in result).toBe(true);
  });
});

describe("matchesPttKey", () => {
  it("matches only the bound keycode", () => {
    expect(matchesPttKey(41, 41)).toBe(true);
    expect(matchesPttKey(42, 41)).toBe(false);
    expect(matchesPttKey("41", 41)).toBe(false);
    expect(matchesPttKey(undefined, 41)).toBe(false);
  });
});

describe("validateAccelerator", () => {
  it("accepts well-formed shortcuts", () => {
    for (const acc of [
      "CommandOrControl+Shift+M",
      "Ctrl+Alt+P",
      "Shift+F9",
      "Alt+Space",
    ]) {
      expect(validateAccelerator(acc)).toBeNull();
    }
  });

  it("requires a modifier", () => {
    expect(validateAccelerator("F9")).not.toBeNull();
    expect(validateAccelerator("M")).not.toBeNull();
  });

  it("rejects OS-reserved and malformed input", () => {
    expect(validateAccelerator("Alt+F4")).not.toBeNull();
    expect(validateAccelerator("Ctrl+Alt+Delete")).not.toBeNull();
    expect(validateAccelerator("Ctrl++M")).not.toBeNull();
    expect(validateAccelerator("Win+M")).not.toBeNull();
    expect(validateAccelerator("Ctrl+Foo")).not.toBeNull();
    expect(validateAccelerator("")).not.toBeNull();
    expect(validateAccelerator("x".repeat(65))).not.toBeNull();
  });
});

describe("acceleratorConflictsPtt", () => {
  it("detects a shared physical key", () => {
    expect(acceleratorConflictsPtt("Ctrl+Shift+M", 50)).toBe(true);
    expect(acceleratorConflictsPtt("Ctrl+Shift+M", 41)).toBe(false);
    expect(acceleratorConflictsPtt("Shift+F9", 67)).toBe(true);
  });

  it("is false for unmappable keys", () => {
    expect(acceleratorConflictsPtt("Alt+Plus", 57)).toBe(false);
    expect(acceleratorConflictsPtt("Alt+Space", 57)).toBe(true);
  });
});
