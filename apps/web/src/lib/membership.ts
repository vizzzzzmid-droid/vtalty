import type { ServerState } from "@vitality/shared";

export interface MyAccess {
  memberId: string;
  roleId: string;
  isOwner: boolean;
  canManageChannels: boolean;
  canManageMembers: boolean;
  canSpeak: boolean;
  canConnect: boolean;
  canShareScreen: boolean;
}

export function myAccess(state: ServerState, userId: string): MyAccess | null {
  const member = state.members.find((entry) => entry.userId === userId);
  if (member === undefined) {
    return null;
  }
  const role = state.roles.find((entry) => entry.id === member.roleId);
  const isOwner = role?.name === "owner";
  const owner = isOwner ?? false;
  return {
    memberId: member.id,
    roleId: member.roleId,
    isOwner: owner,
    canManageChannels: owner || role?.flags.manage_channels === true,
    canManageMembers: owner || role?.flags.manage_members === true,
    canSpeak: owner || role?.flags.speak === true,
    canConnect: owner || role?.flags.connect === true,
    canShareScreen: owner || role?.flags.share_screen === true,
  };
}
