// Versioned WebSocket protocol (v1).
// Transport envelope + typed server->client event map + client->server intents.
// Wire rules (see docs/ARCHITECTURE.md section 6):
// - every frame validates against wsEnvelopeSchema first (v/seq/type/at);
// - then against the discriminated union for its direction;
// - unknown `type` values are rejected by safeParse (caller logs + ignores).
import { z } from "zod";
import { WS_PROTOCOL_VERSION } from "./constants.js";
import {
  categorySchema,
  channelIdSchema,
  channelSchema,
  messageSchema,
  presenceSchema,
  serverIdSchema,
  userIdSchema,
  voiceParticipantSchema,
} from "./schemas.js";

export const wsEnvelopeSchema = z.object({
  v: z.literal(WS_PROTOCOL_VERSION),
  seq: z.number().int().nonnegative(),
  type: z.string().min(1).max(64),
  data: z.unknown(),
  at: z.string().datetime(),
});
export type WsEnvelope = z.infer<typeof wsEnvelopeSchema>;

function serverEvent<T extends string, S extends z.ZodTypeAny>(
  type: T,
  data: S,
) {
  return z.object({
    v: z.literal(WS_PROTOCOL_VERSION),
    seq: z.number().int().nonnegative(),
    type: z.literal(type),
    data,
    at: z.string().datetime(),
  });
}

const messagePayload = z.object({
  channelId: channelIdSchema,
  message: messageSchema,
});

export const wsServerEventSchema = z.discriminatedUnion("type", [
  serverEvent("server.ready", z.object({ userId: userIdSchema })),
  serverEvent("message.create", messagePayload),
  serverEvent("message.update", messagePayload),
  serverEvent(
    "message.delete",
    z.object({ channelId: channelIdSchema, messageId: messageSchema.shape.id }),
  ),
  serverEvent(
    "typing.start",
    z.object({ channelId: channelIdSchema, userId: userIdSchema }),
  ),
  serverEvent("presence.update", presenceSchema),
  serverEvent("channel.create", z.object({ channel: channelSchema })),
  serverEvent("channel.update", z.object({ channel: channelSchema })),
  serverEvent(
    "channel.delete",
    z.object({ serverId: serverIdSchema, channelId: channelIdSchema }),
  ),
  serverEvent("category.create", z.object({ category: categorySchema })),
  serverEvent("category.update", z.object({ category: categorySchema })),
  serverEvent(
    "category.delete",
    z.object({ serverId: serverIdSchema, categoryId: categorySchema.shape.id }),
  ),
  serverEvent(
    "member.join",
    z.object({ serverId: serverIdSchema, userId: userIdSchema }),
  ),
  serverEvent(
    "member.leave",
    z.object({ serverId: serverIdSchema, userId: userIdSchema }),
  ),
  serverEvent(
    "member.role_update",
    z.object({
      serverId: serverIdSchema,
      userId: userIdSchema,
      roleId: z.string().uuid(),
    }),
  ),
  serverEvent(
    "voice.state",
    z.object({
      channelId: channelIdSchema,
      participants: z.array(voiceParticipantSchema),
    }),
  ),
]);
export type WsServerEvent = z.infer<typeof wsServerEventSchema>;
export type WsServerEventName = WsServerEvent["type"];

export const wsClientIntentSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("client.hello"),
    lastSeq: z.number().int().nonnegative().nullable(),
  }),
  z.object({
    type: z.literal("typing.start"),
    channelId: channelIdSchema,
  }),
  z.object({
    type: z.literal("presence.update"),
    status: z.enum(["online", "idle"] as const),
  }),
  z.object({
    type: z.literal("voice.state.update"),
    channelId: channelIdSchema,
    muted: z.boolean(),
    deafened: z.boolean(),
  }),
]);
export type WsClientIntent = z.infer<typeof wsClientIntentSchema>;
