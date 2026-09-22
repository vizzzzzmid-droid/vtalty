import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@vitality/shared";
import { parseNotificationClick } from "../src/lib/desktop.js";
import { shouldNotifyForMention } from "../src/ws/notify.js";

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "01J0000000000000000000000",
    channelId: "ch-1",
    authorId: "user-b",
    content: "hey @a, look",
    createdAt: new Date(0).toISOString(),
    editedAt: null,
    deletedAt: null,
    attachments: [],
    mentions: ["user-a"],
    ...overrides,
  };
}

describe("shouldNotifyForMention", () => {
  const mine = "user-a";

  it("notifies for someone else's mention while unfocused", () => {
    expect(
      shouldNotifyForMention({
        message: message(),
        channelId: "ch-1",
        myUserId: mine,
        selectedChannelId: "ch-9",
        focused: false,
      }),
    ).toBe(true);
  });

  it("notifies even when focused if reading another channel", () => {
    expect(
      shouldNotifyForMention({
        message: message(),
        channelId: "ch-1",
        myUserId: mine,
        selectedChannelId: "ch-9",
        focused: true,
      }),
    ).toBe(true);
  });

  it("stays silent when already reading that channel focused", () => {
    expect(
      shouldNotifyForMention({
        message: message(),
        channelId: "ch-1",
        myUserId: mine,
        selectedChannelId: "ch-1",
        focused: true,
      }),
    ).toBe(false);
  });

  it("stays silent for own messages, non-mentions, deletes, guests", () => {
    const base = {
      channelId: "ch-1",
      myUserId: mine,
      selectedChannelId: null,
      focused: false,
    };
    expect(
      shouldNotifyForMention({ ...base, message: message({ authorId: mine }) }),
    ).toBe(false);
    expect(
      shouldNotifyForMention({ ...base, message: message({ mentions: [] }) }),
    ).toBe(false);
    expect(
      shouldNotifyForMention({
        ...base,
        message: message({ deletedAt: new Date(0).toISOString() }),
      }),
    ).toBe(false);
    expect(
      shouldNotifyForMention({ ...base, myUserId: null, message: message() }),
    ).toBe(false);
  });
});

describe("parseNotificationClick", () => {
  it("accepts a channel id", () => {
    expect(parseNotificationClick({ channelId: "ch-1" })).toBe("ch-1");
  });

  it("rejects garbage", () => {
    for (const body of [null, {}, { channelId: "" }, { channelId: "x".repeat(129) }, "ch-1"]) {
      expect(parseNotificationClick(body)).toBeNull();
    }
  });
});
