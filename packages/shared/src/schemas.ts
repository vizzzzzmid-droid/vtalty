// Shared entity schemas (zod). REST and WS payloads build on these.
import { z } from "zod";
import {
  CHANNEL_TYPES,
  MAX_CHANNEL_NAME_LENGTH,
  MAX_MESSAGE_LENGTH,
  PERMISSIONS,
  PRESENCE_STATUSES,
  ROLE_NAMES,
} from "./constants.js";

export const userIdSchema = z.string().uuid();
export const serverIdSchema = z.string().uuid();
export const channelIdSchema = z.string().uuid();
export const categoryIdSchema = z.string().uuid();
export const messageIdSchema = z.string().ulid();

export const usernameSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[A-Za-z0-9_.-]+$/);
export const passwordSchema = z.string().min(8).max(128);
export const displayNameSchema = z.string().min(1).max(64);
export const serverNameSchema = z.string().min(1).max(100);
export const channelNameSchema = z
  .string()
  .min(1)
  .max(MAX_CHANNEL_NAME_LENGTH);

export const userSchema = z.object({
  id: userIdSchema,
  username: z.string().min(2).max(32),
  displayName: z.string().min(1).max(64),
  avatarUrl: z.string().url().nullable(),
});

export const permissionSchema = z.enum(PERMISSIONS);
export const roleFlagsSchema = z.object({
  manage_channels: z.boolean(),
  manage_members: z.boolean(),
  send_messages: z.boolean(),
  connect: z.boolean(),
  speak: z.boolean(),
  share_screen: z.boolean(),
});

export const roleSchema = z.object({
  id: z.string().uuid(),
  serverId: serverIdSchema,
  name: z.enum(ROLE_NAMES),
  flags: roleFlagsSchema,
});

export const channelSchema = z.object({
  id: channelIdSchema,
  serverId: serverIdSchema,
  categoryId: categoryIdSchema.nullable(),
  name: z.string().min(1).max(MAX_CHANNEL_NAME_LENGTH),
  type: z.enum(CHANNEL_TYPES),
  position: z.number().int().nonnegative(),
});

export const categorySchema = z.object({
  id: categoryIdSchema,
  serverId: serverIdSchema,
  name: z.string().min(1).max(MAX_CHANNEL_NAME_LENGTH),
  position: z.number().int().nonnegative(),
});

export const messageSchema = z.object({
  id: messageIdSchema,
  channelId: channelIdSchema,
  authorId: userIdSchema,
  content: z.string().min(1).max(MAX_MESSAGE_LENGTH),
  createdAt: z.string().datetime(),
  editedAt: z.string().datetime().nullable(),
  deletedAt: z.string().datetime().nullable(),
});

export const presenceSchema = z.object({
  userId: userIdSchema,
  status: z.enum(PRESENCE_STATUSES),
});

export const voiceParticipantSchema = z.object({
  userId: userIdSchema,
  muted: z.boolean(),
  deafened: z.boolean(),
  sharingScreen: z.boolean(),
  serverMuted: z.boolean(),
});

export type User = z.infer<typeof userSchema>;
export type Role = z.infer<typeof roleSchema>;
export type RoleFlags = z.infer<typeof roleFlagsSchema>;
export type Channel = z.infer<typeof channelSchema>;
export type Category = z.infer<typeof categorySchema>;
export type ChatMessage = z.infer<typeof messageSchema>;
export type Presence = z.infer<typeof presenceSchema>;
export type VoiceParticipant = z.infer<typeof voiceParticipantSchema>;

// REST request/response DTOs (validated on the server, reused by web forms).

export const registerBodySchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  displayName: displayNameSchema.optional(),
  inviteCode: z.string().min(1).max(64).optional(),
});

export const loginBodySchema = z.object({
  username: z.string().min(1).max(32),
  password: z.string().min(1).max(128),
});

export const authResponseSchema = z.object({
  user: userSchema,
  accessToken: z.string().min(1),
});

export const patchMeBodySchema = z.object({
  displayName: displayNameSchema.optional(),
  avatarUrl: z.string().url().max(2048).nullable().optional(),
});

export const createServerBodySchema = z.object({
  name: serverNameSchema,
});

export const patchServerBodySchema = z.object({
  name: serverNameSchema,
});

export const createCategoryBodySchema = z.object({
  name: channelNameSchema,
});

export const patchCategoryBodySchema = z.object({
  name: channelNameSchema.optional(),
  position: z.number().int().nonnegative().optional(),
});

export const createChannelBodySchema = z.object({
  name: channelNameSchema,
  type: z.enum(CHANNEL_TYPES),
  categoryId: categoryIdSchema.nullable().optional(),
});

export const patchChannelBodySchema = z.object({
  name: channelNameSchema.optional(),
  position: z.number().int().nonnegative().optional(),
  categoryId: categoryIdSchema.nullable().optional(),
});

export const createInviteBodySchema = z.object({
  maxUses: z.number().int().positive().nullable().optional(),
  expiresInHours: z.number().positive().nullable().optional(),
});

export const patchMemberBodySchema = z.object({
  roleId: z.string().uuid(),
});

export const patchRoleBodySchema = z.object({
  flags: roleFlagsSchema.partial(),
});

export const inviteSchema = z.object({
  id: z.string().uuid(),
  serverId: serverIdSchema,
  code: z.string().min(1).max(64),
  maxUses: z.number().int().positive().nullable(),
  uses: z.number().int().nonnegative(),
  expiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export const wsTicketResponseSchema = z.object({
  ticket: z.string().min(1).max(256),
});
export type WsTicketResponse = z.infer<typeof wsTicketResponseSchema>;

export type RegisterBody = z.infer<typeof registerBodySchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;
export type CreateServerBody = z.infer<typeof createServerBodySchema>;
export type CreateChannelBody = z.infer<typeof createChannelBodySchema>;
export type CreateInviteBody = z.infer<typeof createInviteBodySchema>;
export type Invite = z.infer<typeof inviteSchema>;

// Server snapshot for client bootstrap + reconnect refetch.
// `voice` and `readStates` are empty in Phase 2; filled in Phases 3-4.
// Keys are stable so clients can rely on them across phases.
export const memberWithUserSchema = z.object({
  id: z.string().uuid(),
  serverId: serverIdSchema,
  userId: userIdSchema,
  roleId: z.string().uuid(),
  joinedAt: z.string().datetime(),
  user: userSchema,
  presence: presenceSchema,
});

export const serverStateSchema = z.object({
  server: z.object({
    id: serverIdSchema,
    name: z.string().min(1).max(100),
    ownerId: userIdSchema,
    createdAt: z.string().datetime(),
  }),
  roles: z.array(roleSchema),
  members: z.array(memberWithUserSchema),
  categories: z.array(categorySchema),
  channels: z.array(channelSchema),
  voice: z.array(z.unknown()),
  readStates: z.array(z.unknown()),
});

export type MemberWithUser = z.infer<typeof memberWithUserSchema>;
export type ServerState = z.infer<typeof serverStateSchema>;
