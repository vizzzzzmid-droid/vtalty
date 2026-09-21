import type { ServerState } from "@vitality/shared";

export interface MyAccess {
  memberId: string;
  roleId: string;
  isOwner: boolean;
  canManageChannels: boolean;
  canManageMembers: boolean;
}

export function myAccess(state: ServerState, userId: string): MyAccess | null {
  const member = state.members.find((entry) => entry.userId === userId);
  if (member === undefined) {
    return null;
  }
  const role = state.roles.find((entry) => entry.id === member.roleId);
  const isOwner = role?.name === "owner";
  return {
    memberId: member.id,
    roleId: member.roleId,
    isOwner: isOwner ?? false,
    canManageChannels: (isOwner ?? false) || role?.flags.manage_channels === true,
    canManageMembers: (isOwner ?? false) || role?.flags.manage_members === true,
  };
}
