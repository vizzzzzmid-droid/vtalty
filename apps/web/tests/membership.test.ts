import { describe, expect, it } from "vitest";
import type { ServerState } from "@vitality/shared";
import { myAccess } from "../src/lib/membership.js";

const AT = "2026-09-21T10:00:00.000Z";
const SERVER = "123e4567-e89b-12d3-a456-426614174010";
const OWNER_ID = "123e4567-e89b-12d3-a456-426614174001";
const MEMBER_ID = "123e4567-e89b-12d3-a456-426614174002";
const OWNER_ROLE = "123e4567-e89b-12d3-a456-426614174011";
const MEMBER_ROLE = "123e4567-e89b-12d3-a456-426614174012";

function fixture(): ServerState {
  return {
    server: { id: SERVER, name: "vitality", ownerId: OWNER_ID, createdAt: AT },
    roles: [
      {
        id: OWNER_ROLE,
        serverId: SERVER,
        name: "owner",
        flags: {
          manage_channels: true,
          manage_members: true,
          send_messages: true,
          connect: true,
          speak: true,
          share_screen: true,
        },
      },
      {
        id: MEMBER_ROLE,
        serverId: SERVER,
        name: "member",
        flags: {
          manage_channels: false,
          manage_members: false,
          send_messages: true,
          connect: true,
          speak: true,
          share_screen: true,
        },
      },
    ],
    members: [
      {
        id: "m1",
        serverId: SERVER,
        userId: OWNER_ID,
        roleId: OWNER_ROLE,
        joinedAt: AT,
        user: { id: OWNER_ID, username: "owner", displayName: "Owner", avatarUrl: null },
        presence: { userId: OWNER_ID, status: "online" },
      },
      {
        id: "m2",
        serverId: SERVER,
        userId: MEMBER_ID,
        roleId: MEMBER_ROLE,
        joinedAt: AT,
        user: { id: MEMBER_ID, username: "friend", displayName: "Friend", avatarUrl: null },
        presence: { userId: MEMBER_ID, status: "offline" },
      },
    ],
    categories: [],
    channels: [],
    voice: [],
    readStates: [],
  };
}

describe("myAccess", () => {
  it("grants the owner everything", () => {
    expect(myAccess(fixture(), OWNER_ID)).toMatchObject({
      isOwner: true,
      canManageChannels: true,
      canManageMembers: true,
    });
  });

  it("restricts plain members", () => {
    expect(myAccess(fixture(), MEMBER_ID)).toMatchObject({
      isOwner: false,
      canManageChannels: false,
      canManageMembers: false,
    });
  });

  it("returns null for non-members", () => {
    expect(myAccess(fixture(), "123e4567-e89b-12d3-a456-426614174099")).toBeNull();
  });
});
