import {
  serverStateSchema,
  type AuthResponse,
  type Category,
  type Channel,
  type CreateChannelBody,
  type CreateInviteBody,
  type Invite,
  type LoginBody,
  type RegisterBody,
  type Role,
  type RoleFlags,
  type ServerState,
  type User,
} from "@vitality/shared";
import { del, get, patch, post } from "./http.js";

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

export function patchMe(patchBody: {
  displayName?: string;
  avatarUrl?: string | null;
}): Promise<User> {
  return patch<User>("/users/me", patchBody);
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
