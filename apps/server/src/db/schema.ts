import { randomUUID } from "node:crypto";
import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

// Infra-level flags (e.g. whether seed data was applied).
export const schemaMeta = pgTable("schema_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

function uuidId() {
  return randomUUID();
}

function createdAt() {
  return timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
}

export const users = pgTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => uuidId()),
  username: text("username").notNull().unique(),
  displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"),
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
});

export const refreshTokens = pgTable("refresh_tokens", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => uuidId()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  familyId: text("family_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const servers = pgTable("servers", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => uuidId()),
  name: text("name").notNull(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
});

export const roles = pgTable("roles", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => uuidId()),
  serverId: text("server_id")
    .notNull()
    .references(() => servers.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  manageChannels: boolean("manage_channels").notNull().default(false),
  manageMembers: boolean("manage_members").notNull().default(false),
  sendMessages: boolean("send_messages").notNull().default(true),
  connect: boolean("connect").notNull().default(true),
  speak: boolean("speak").notNull().default(true),
  shareScreen: boolean("share_screen").notNull().default(true),
  position: integer("position").notNull().default(0),
});

export const members = pgTable(
  "members",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidId()),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [unique("members_server_user_unique").on(table.serverId, table.userId)],
);

export const channelCategories = pgTable("channel_categories", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => uuidId()),
  serverId: text("server_id")
    .notNull()
    .references(() => servers.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  position: integer("position").notNull().default(0),
});

export const channelTypeEnum = pgEnum("channel_type", ["text", "voice"]);

export const channels = pgTable("channels", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => uuidId()),
  serverId: text("server_id")
    .notNull()
    .references(() => servers.id, { onDelete: "cascade" }),
  categoryId: text("category_id").references(() => channelCategories.id),
  name: text("name").notNull(),
  type: channelTypeEnum("type").notNull(),
  position: integer("position").notNull().default(0),
  createdAt: createdAt(),
});
export const invites = pgTable("invites", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => uuidId()),
  serverId: text("server_id")
    .notNull()
    .references(() => servers.id, { onDelete: "cascade" }),
  code: text("code").notNull().unique(),
  createdBy: text("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  maxUses: integer("max_uses"),
  uses: integer("uses").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: createdAt(),
});

// One-time WebSocket handshake tickets (Phase 2.5): short TTL, single use,
// bound to the user and their refresh-token family (logout kills them).
export const wsTickets = pgTable("ws_tickets", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => uuidId()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  familyId: text("family_id").notNull(),
  ticketHash: text("ticket_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export type UserRow = typeof users.$inferSelect;
export type ServerRow = typeof servers.$inferSelect;
export type RoleRow = typeof roles.$inferSelect;
export type MemberRow = typeof members.$inferSelect;
export type CategoryRow = typeof channelCategories.$inferSelect;
export type ChannelRow = typeof channels.$inferSelect;
export type InviteRow = typeof invites.$inferSelect;

// Text chat (Phase 3). Message ids are ULIDs generated in app code
// (time-ordered, cursor pagination without offset scans).
export const messages = pgTable("messages", {
  id: text("id").primaryKey(),
  channelId: text("channel_id")
    .notNull()
    .references(() => channels.id, { onDelete: "cascade" }),
  authorId: text("author_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  content: text("content").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  editedAt: timestamp("edited_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const attachments = pgTable("attachments", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => uuidId()),
  messageId: text("message_id").references(() => messages.id, {
    onDelete: "cascade",
  }),
  channelId: text("channel_id")
    .notNull()
    .references(() => channels.id, { onDelete: "cascade" }),
  uploaderId: text("uploader_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  mime: text("mime").notNull(),
  bytes: integer("bytes").notNull(),
  storageKey: text("storage_key").notNull().unique(),
  width: integer("width"),
  height: integer("height"),
  createdAt: createdAt(),
});

export const messageMentions = pgTable(
  "message_mentions",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.userId] }),
  ],
);

export const readStates = pgTable(
  "read_states",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    lastReadMessageId: text("last_read_message_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.channelId] })],
);

export type MessageRow = typeof messages.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;

// Per-user Voice & Audio settings (Phase 5). Local storage stays the
// immediate source; this copy follows the user across devices.
export const userVoiceSettings = pgTable("user_voice_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  settings: jsonb("settings").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
