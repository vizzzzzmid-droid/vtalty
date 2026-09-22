import { describe, expect, it } from "vitest";
import {
  applySettingsPatch,
  isWritableSettingKey,
  parseNotificationClick,
  parseNotifyRequest,
  readAllowedSetting,
} from "../src/ipc.js";
import { loadSettings } from "../src/store.js";
import { notificationClickSchema, notifySchema } from "../src/shared.js";

// NOTE: store functions here run against the real electron stub (no userData
// override), so only pure helpers are exercised — loadSettings falls back to
// defaults when the store file is absent.

const base = loadSettings();

describe("isWritableSettingKey", () => {
  it("accepts the renderer-writable keys", () => {
    for (const key of [
      "minimizeToTray",
      "startMinimized",
      "notificationsEnabled",
      "globalPttEnabled",
      "globalPttKeycode",
      "globalMuteAccelerator",
    ]) {
      expect(isWritableSettingKey(key)).toBe(true);
    }
  });

  it("rejects main-only and garbage keys", () => {
    for (const key of ["recentServers", "windowBounds", "windowMaximized", "", 42, null, undefined]) {
      expect(isWritableSettingKey(key)).toBe(false);
    }
  });
});

describe("readAllowedSetting", () => {
  it("reads allowed keys", () => {
    expect(readAllowedSetting({ ...base, minimizeToTray: false }, "minimizeToTray")).toBe(false);
    expect(readAllowedSetting(base, "notificationsEnabled")).toBe(true);
  });

  it("returns null for main-only keys", () => {
    expect(readAllowedSetting(base, "recentServers")).toBeNull();
    expect(readAllowedSetting(base, "windowBounds")).toBeNull();
  });
});

describe("applySettingsPatch", () => {
  it("applies boolean fields", () => {
    const { next, changed } = applySettingsPatch(base, {
      minimizeToTray: false,
      notificationsEnabled: false,
    });
    expect(changed).toBe(true);
    expect(next.minimizeToTray).toBe(false);
    expect(next.notificationsEnabled).toBe(false);
  });

  it("range-checks the PTT keycode", () => {
    expect(applySettingsPatch(base, { globalPttKeycode: 30 }).next.globalPttKeycode).toBe(30);
    expect(applySettingsPatch(base, { globalPttKeycode: -1 }).changed).toBe(false);
    expect(applySettingsPatch(base, { globalPttKeycode: 65536 }).changed).toBe(false);
    expect(applySettingsPatch(base, { globalPttKeycode: 1.5 }).changed).toBe(false);
    expect(applySettingsPatch(base, { globalPttKeycode: "30" }).changed).toBe(false);
  });

  it("validates the mute accelerator", () => {
    const { next, changed } = applySettingsPatch(base, {
      globalMuteAccelerator: "Ctrl+Alt+P",
    });
    expect(changed).toBe(true);
    expect(next.globalMuteAccelerator).toBe("Ctrl+Alt+P");
    expect(applySettingsPatch(base, { globalMuteAccelerator: "F9" }).changed).toBe(false);
    expect(applySettingsPatch(base, { globalMuteAccelerator: "Alt+F4" }).changed).toBe(false);
  });

  it("ignores wrong types and unknown fields", () => {
    const { next, changed } = applySettingsPatch(base, {
      minimizeToTray: "yes",
      recentServers: [],
      windowBounds: { x: 1, y: 2, width: 3, height: 4 },
    });
    expect(changed).toBe(false);
    expect(next).toEqual(base);
  });

  it("rejects non-object bodies", () => {
    for (const body of [null, undefined, 42, "x", []]) {
      expect(applySettingsPatch(base, body).changed).toBe(false);
    }
  });
});

describe("parseNotifyRequest", () => {
  it("accepts title/body with optional channelId", () => {
    expect(
      parseNotifyRequest({ title: "Hi", body: "hello", channelId: "ch-1" }),
    ).toEqual({ title: "Hi", body: "hello", channelId: "ch-1" });
    expect(parseNotifyRequest({ title: "Hi", body: "hello" })).toEqual({
      title: "Hi",
      body: "hello",
    });
  });

  it("rejects overlong or missing fields", () => {
    expect(parseNotifyRequest({ title: "", body: "x" })).toBeNull();
    expect(parseNotifyRequest({ title: "x".repeat(129), body: "y" })).toBeNull();
    expect(parseNotifyRequest({ title: "x", body: "y".repeat(513) })).toBeNull();
    expect(parseNotifyRequest({ title: "x", body: "y", channelId: "" })).toBeNull();
    expect(parseNotifyRequest(null)).toBeNull();
  });

  it("matches the shared schema", () => {
    // The helper must not drift from the contract: same verdicts.
    const bodies: unknown[] = [
      { title: "t", body: "b", channelId: "c" },
      { title: "t", body: "b" },
      { title: "", body: "b" },
      "nope",
    ];
    for (const body of bodies) {
      const expected = notifySchema.safeParse(body).success
        ? notifySchema.parse(body)
        : null;
      expect(parseNotifyRequest(body)).toEqual(expected);
    }
  });
});

describe("parseNotificationClick", () => {
  it("accepts a channel id", () => {
    expect(parseNotificationClick({ channelId: "ch-1" })).toEqual({ channelId: "ch-1" });
  });

  it("rejects garbage", () => {
    for (const body of [
      null,
      {},
      { channelId: "" },
      { channelId: "x".repeat(129) },
      { channelId: 42 },
    ]) {
      expect(parseNotificationClick(body)).toBeNull();
      expect(notificationClickSchema.safeParse(body).success).toBe(false);
    }
  });
});
