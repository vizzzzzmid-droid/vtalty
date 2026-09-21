// Shared constants for vitality (server, web, desktop).
// All values here are part of the v1 protocol contract: do not change the
// meaning of existing constants without bumping WS_PROTOCOL_VERSION.

export const APP_NAME = "vitality" as const;
export const APP_VERSION = "0.1.0" as const;

/** Version of the WebSocket envelope + event map. Bumped on breaking changes. */
export const WS_PROTOCOL_VERSION = 1 as const;

export const REST_API_BASE = "/api/v1" as const;
export const WS_PATH = "/ws" as const;

export const MAX_MESSAGE_LENGTH = 4000 as const;
export const MESSAGE_PAGE_LIMIT = 30 as const;
export const MAX_CHANNEL_NAME_LENGTH = 100 as const;
export const DEFAULT_UPLOAD_MAX_BYTES = 10485760 as const;

export const RECONNECT_BASE_DELAY_MS = 1000 as const;
export const RECONNECT_MAX_DELAY_MS = 30000 as const;
export const TYPING_TTL_MS = 5000 as const;

export const ROLE_NAMES = ["owner", "admin", "member"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export const PERMISSIONS = [
  "manage_channels",
  "manage_members",
  "send_messages",
  "connect",
  "speak",
  "share_screen",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const CHANNEL_TYPES = ["text", "voice"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const PRESENCE_STATUSES = ["online", "idle", "offline"] as const;
export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];
