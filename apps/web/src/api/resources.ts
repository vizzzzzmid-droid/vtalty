import {
  serverStateSchema,
  wsTicketResponseSchema,
  voiceTokenResponseSchema,
  type AuthResponse,
  type Category,
  type Channel,
  type ChatMessage,
  type CreateChannelBody,
  type CreateInviteBody,
  type CreateMessageBody,
  type HistoryQuery,
  type Invite,
  type LoginBody,
  type MessageAttachment,
  type RegisterBody,
  type Role,
  type RoleFlags,
  type ServerState,
  type UnreadEntry,
  type User,
  type VoiceSettings,
  type VoiceTokenResponse,
} from "@vitality/shared";
import { del, ensureFreshSession, get, getAccessToken, patch, post, request } from "./http.js";
import { ApiError } from "./http.js";

export interface ServerSummary {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
}

export function register(input: RegisterBody): Promise<AuthResponse> {
  return post<AuthResponse>("/auth/register", input);
}

export function login(input: LoginBody): Promise<AuthResponse> {
  return post<AuthResponse>("/auth/login", input);
}

export function logoutServer(): Promise<void> {
  return post<void>("/auth/logout");
}

export function fetchMe(): Promise<User> {
  return get<User>("/auth/me");
}

/** Mint a single-use WS ticket for the current session. */
export async function requestWsTicket(): Promise<string> {
  const data: unknown = await post<unknown>("/ws-ticket");
  return wsTicketResponseSchema.parse(data).ticket;
}

/** Mint a short-lived LiveKit join token for a voice channel. */
export async function requestVoiceToken(channelId: string): Promise<VoiceTokenResponse> {
  const data: unknown = await post<unknown>(`/channels/${channelId}/voice-token`);
  return voiceTokenResponseSchema.parse(data);
}

/** Server-mute/unmute a participant (admins). */
export function moderateVoiceMute(
  channelId: string,
  userId: string,
  muted: boolean,
): Promise<void> {
  return post<void>(`/channels/${channelId}/voice/mute`, { userId, muted });
}

/** Force-disconnect a participant (admins). */
export function moderateVoiceDisconnect(channelId: string, userId: string): Promise<void> {
  return del(`/channels/${channelId}/voice/participants/${userId}`);
}

export function patchMe(patchBody: {
  displayName?: string;
  avatarUrl?: string | null;
}): Promise<User> {
  return patch<User>("/users/me", patchBody);
}

/** Server-side Voice & Audio settings (follow the user across devices). */
export function fetchVoiceSettings(): Promise<VoiceSettings> {
  return get<VoiceSettings>("/users/me/voice-settings");
}

export function putVoiceSettings(
  patch: Partial<VoiceSettings>,
): Promise<VoiceSettings> {
  return request<VoiceSettings>("/users/me/voice-settings", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export function fetchServers(): Promise<ServerSummary[]> {
  return get<ServerSummary[]>("/servers");
}

export function createServer(name: string): Promise<ServerSummary> {
  return post<ServerSummary>("/servers", { name });
}

export function patchServer(id: string, name: string): Promise<ServerSummary> {
  return patch<ServerSummary>(`/servers/${id}`, { name });
}

export function deleteServer(id: string): Promise<void> {
  return del(`/servers/${id}`);
}

export async function fetchState(serverId: string): Promise<ServerState> {
  const data: unknown = await get<unknown>(`/servers/${serverId}/state`);
  return serverStateSchema.parse(data);
}

export function createCategory(serverId: string, name: string): Promise<Category> {
  return post<Category>(`/servers/${serverId}/categories`, { name });
}

export function patchCategory(
  id: string,
  body: { name?: string; position?: number },
): Promise<Category> {
  return patch<Category>(`/categories/${id}`, body);
}

export function deleteCategory(id: string): Promise<void> {
  return del(`/categories/${id}`);
}

export function createChannel(
  serverId: string,
  body: CreateChannelBody,
): Promise<Channel> {
  return post<Channel>(`/servers/${serverId}/channels`, body);
}

export function patchChannel(
  id: string,
  body: { name?: string; position?: number; categoryId?: string | null },
): Promise<Channel> {
  return patch<Channel>(`/channels/${id}`, body);
}

export function deleteChannel(id: string): Promise<void> {
  return del(`/channels/${id}`);
}

export function createInvite(
  serverId: string,
  body: CreateInviteBody,
): Promise<Invite> {
  return post<Invite>(`/servers/${serverId}/invites`, body);
}

export function listInvites(serverId: string): Promise<Invite[]> {
  return get<Invite[]>(`/servers/${serverId}/invites`);
}

export function deleteInvite(id: string): Promise<void> {
  return del(`/invites/${id}`);
}

export function patchMember(
  memberId: string,
  roleId: string,
): Promise<{ serverId: string; userId: string; roleId: string }> {
  return patch(`/members/${memberId}`, { roleId });
}

export function kickMember(memberId: string): Promise<void> {
  return del(`/members/${memberId}`);
}

export function leaveServer(serverId: string): Promise<void> {
  return del(`/servers/${serverId}/leave`);
}

export function patchRole(
  serverId: string,
  roleId: string,
  flags: Partial<RoleFlags>,
): Promise<Role> {
  return patch<Role>(`/servers/${serverId}/roles/${roleId}`, { flags });
}

export interface HistoryPage {
  messages: ChatMessage[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

export function sendMessage(
  channelId: string,
  body: CreateMessageBody,
): Promise<ChatMessage> {
  return post<ChatMessage>(`/channels/${channelId}/messages`, body);
}

export function fetchHistory(
  channelId: string,
  query: HistoryQuery,
): Promise<HistoryPage> {
  const params = new URLSearchParams();
  if (query.before !== undefined) {
    params.set("before", query.before);
  }
  if (query.after !== undefined) {
    params.set("after", query.after);
  }
  if (query.around !== undefined) {
    params.set("around", query.around);
  }
  if (query.limit !== undefined) {
    params.set("limit", String(query.limit));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return get<HistoryPage>(`/channels/${channelId}/messages${suffix}`);
}

export function editMessage(id: string, content: string): Promise<ChatMessage> {
  return patch<ChatMessage>(`/messages/${id}`, { content });
}

export function deleteMessage(id: string): Promise<void> {
  return del(`/messages/${id}`);
}

export function markChannelRead(
  channelId: string,
  lastReadMessageId: string,
): Promise<void> {
  return post<void>(`/channels/${channelId}/read`, { lastReadMessageId });
}

export function fetchUnread(serverId: string): Promise<UnreadEntry[]> {
  return get<UnreadEntry[]>(`/servers/${serverId}/unread`);
}

async function authedFetch(input: string, init: RequestInit): Promise<Response> {
  const send = (token: string | null): Promise<Response> =>
    fetch(input, {
      ...init,
      headers: {
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        ...init.headers,
      },
    });
  let res = await send(getAccessToken());
  if (res.status === 401 && (await ensureFreshSession())) {
    res = await send(getAccessToken());
  }
  return res;
}

/** Upload files via multipart (JSON http client cannot do FormData). */
export async function uploadAttachments(
  channelId: string,
  files: File[],
): Promise<MessageAttachment[]> {
  const form = new FormData();
  for (const file of files) {
    form.append("file", file, file.name);
  }
  const res = await authedFetch(`/api/v1/channels/${channelId}/attachments`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    let code = "REQUEST_FAILED";
    let message = `Upload failed with status ${res.status}`;
    try {
      const data = (await res.json()) as {
        error?: { code?: unknown; message?: unknown };
      };
      if (typeof data.error?.code === "string") {
        code = data.error.code;
      }
      if (typeof data.error?.message === "string") {
        message = data.error.message;
      }
    } catch {
      // Non-JSON error body; keep the fallback.
    }
    throw new ApiError(res.status, code, message);
  }
  return (await res.json()) as MessageAttachment[];
}
