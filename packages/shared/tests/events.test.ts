import { describe, expect, it } from "vitest";
import {
  WS_PROTOCOL_VERSION,
  serverStateSchema,
  wsClientIntentSchema,
  wsEnvelopeSchema,
  wsServerEventSchema,
} from "../src/index.js";

const AT = "2026-09-21T10:00:00.000Z";
const CHANNEL_ID = "123e4567-e89b-12d3-a456-426614174000";
const USER_ID = "123e4567-e89b-12d3-a456-426614174001";
const MESSAGE_ID = "01J8Y7RZ6N9Q2K4M5P6R7S8T9V";

function baseMessage() {
  return {
    id: MESSAGE_ID,
    channelId: CHANNEL_ID,
    authorId: USER_ID,
    content: "hello",
    createdAt: AT,
    editedAt: null,
    deletedAt: null,
  };
}

describe("wsEnvelopeSchema", () => {
  it("accepts a well-formed envelope", () => {
    const parsed = wsEnvelopeSchema.safeParse({
      v: WS_PROTOCOL_VERSION,
      seq: 7,
      type: "message.create",
      data: {},
      at: AT,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a wrong protocol version", () => {
    const parsed = wsEnvelopeSchema.safeParse({
      v: WS_PROTOCOL_VERSION + 1,
      seq: 0,
      type: "message.create",
      data: {},
      at: AT,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("wsServerEventSchema", () => {
  it("parses message.create with a valid payload", () => {
    const parsed = wsServerEventSchema.safeParse({
      v: 1,
      seq: 1,
      type: "message.create",
      data: { channelId: CHANNEL_ID, message: baseMessage() },
      at: AT,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown event types", () => {
    const parsed = wsServerEventSchema.safeParse({
      v: 1,
      seq: 2,
      type: "message.frobnicated",
      data: {},
      at: AT,
    });
    expect(parsed.success).toBe(false);
  });

  it("parses voice.state with participants", () => {
    const parsed = wsServerEventSchema.safeParse({
      v: 1,
      seq: 3,
      type: "voice.state",
      data: {
        channelId: CHANNEL_ID,
        participants: [
          {
            userId: USER_ID,
            muted: false,
            deafened: false,
            sharingScreen: true,
            serverMuted: false,
          },
        ],
      },
      at: AT,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects overlong message content", () => {
    const parsed = wsServerEventSchema.safeParse({
      v: 1,
      seq: 4,
      type: "message.create",
      data: {
        channelId: CHANNEL_ID,
        message: { ...baseMessage(), content: "x".repeat(4001) },
      },
      at: AT,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("wsClientIntentSchema", () => {
  it("parses client.hello with a resume cursor", () => {
    const parsed = wsClientIntentSchema.safeParse({
      type: "client.hello",
      lastSeq: 42,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("server.ready + serverStateSchema", () => {
  it("parses server.ready", () => {
    const parsed = wsServerEventSchema.safeParse({
      v: 1,
      seq: 0,
      type: "server.ready",
      data: { userId: USER_ID },
      at: AT,
    });
    expect(parsed.success).toBe(true);
  });

  it("parses a minimal server snapshot", () => {
    const parsed = serverStateSchema.safeParse({
      server: {
        id: "123e4567-e89b-12d3-a456-426614174010",
        name: "vitality",
        ownerId: USER_ID,
        createdAt: AT,
      },
      roles: [],
      members: [],
      categories: [],
      channels: [],
      voice: [],
      readStates: [],
    });
    expect(parsed.success).toBe(true);
  });
});
