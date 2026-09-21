import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { serverStateSchema } from "@vitality/shared";
import {
  authHeader,
  describeIf,
  registerUser,
  resetDatabase,
  setup,
  teardown,
  type TestContext,
  type TestUser,
} from "./helpers.js";

async function ownerServerId(ctx: TestContext, owner: TestUser): Promise<string> {
  const res = await ctx.app.inject({
    method: "GET",
    url: "/api/v1/servers",
    headers: authHeader(owner),
  });
  const servers = res.json() as { id: string }[];
  const id = servers[0]?.id;
  if (id === undefined) {
    throw new Error("owner has no server");
  }
  return id;
}

async function createInvite(ctx: TestContext, owner: TestUser, serverId: string): Promise<string> {
  const res = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/servers/${serverId}/invites`,
    headers: authHeader(owner),
    payload: {},
  });
  if (res.statusCode !== 200) {
    throw new Error(`invite failed: ${res.statusCode} ${res.body}`);
  }
  return (res.json() as { code: string }).code;
}

async function memberIdOf(
  ctx: TestContext,
  viewer: TestUser,
  serverId: string,
  userId: string,
): Promise<string> {
  const res = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/servers/${serverId}/state`,
    headers: authHeader(viewer),
  });
  const state = serverStateSchema.parse(await res.json());
  const member = state.members.find((entry) => entry.userId === userId);
  if (member === undefined) {
    throw new Error("member missing from snapshot");
  }
  return member.id;
}

describeIf("team management", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await setup();
  });
  beforeEach(async () => {
    await resetDatabase(ctx);
  });
  afterAll(async () => {
    await teardown(ctx);
  });

  it("members cannot manage invites, admins (after promotion) can", async () => {
    const owner = await registerUser(ctx, "owner");
    const serverId = await ownerServerId(ctx, owner);
    const code = await createInvite(ctx, owner, serverId);
    const friend = await registerUser(ctx, "friend", code);

    const denied = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/servers/${serverId}/invites`,
      headers: authHeader(friend),
      payload: {},
    });
    expect(denied.statusCode).toBe(403);

    const adminRoleRes = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/servers/${serverId}/state`,
      headers: authHeader(owner),
    });
    const state = serverStateSchema.parse(await adminRoleRes.json());
    const adminRoleId = state.roles.find((role) => role.name === "admin")?.id ?? "";
    const friendMemberId = await memberIdOf(ctx, owner, serverId, friend.id);

    const promote = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/members/${friendMemberId}`,
      headers: authHeader(owner),
      payload: { roleId: adminRoleId },
    });
    expect(promote.statusCode).toBe(200);

    const allowed = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/servers/${serverId}/invites`,
      headers: authHeader(friend),
      payload: { maxUses: 1 },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("protects the owner from role changes and kicks", async () => {
    const owner = await registerUser(ctx, "owner");
    const serverId = await ownerServerId(ctx, owner);
    const code = await createInvite(ctx, owner, serverId);
    const friend = await registerUser(ctx, "friend", code);
    const ownerMemberId = await memberIdOf(ctx, owner, serverId, owner.id);

    const state = serverStateSchema.parse(
      await (
        await ctx.app.inject({
          method: "GET",
          url: `/api/v1/servers/${serverId}/state`,
          headers: authHeader(owner),
        })
      ).json(),
    );
    const memberRoleId = state.roles.find((role) => role.name === "member")?.id ?? "";

    const demoteOwner = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/members/${ownerMemberId}`,
      headers: authHeader(owner),
      payload: { roleId: memberRoleId },
    });
    expect(demoteOwner.statusCode).toBe(403);

    const kickOwner = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/members/${ownerMemberId}`,
      headers: authHeader(friend),
    });
    expect([403, 404]).toContain(kickOwner.statusCode);

    const leaveOwner = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/servers/${serverId}/leave`,
      headers: authHeader(owner),
    });
    expect(leaveOwner.statusCode).toBe(409);
  });

  it("kicks and leaves remove membership", async () => {
    const owner = await registerUser(ctx, "owner");
    const serverId = await ownerServerId(ctx, owner);
    const code = await createInvite(ctx, owner, serverId);
    const friend = await registerUser(ctx, "friend", code);
    const leaver = await registerUser(ctx, "leaver", await createInvite(ctx, owner, serverId));

    const friendMemberId = await memberIdOf(ctx, owner, serverId, friend.id);
    const kick = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/members/${friendMemberId}`,
      headers: authHeader(owner),
    });
    expect(kick.statusCode).toBe(204);

    const leave = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/servers/${serverId}/leave`,
      headers: authHeader(leaver),
    });
    expect(leave.statusCode).toBe(204);

    const state = serverStateSchema.parse(
      await (
        await ctx.app.inject({
          method: "GET",
          url: `/api/v1/servers/${serverId}/state`,
          headers: authHeader(owner),
        })
      ).json(),
    );
    expect(state.members.map((entry) => entry.userId).sort()).toEqual([owner.id]);
  });

  it("manages servers and role flags", async () => {
    const owner = await registerUser(ctx, "owner");
    const rename = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/servers/${(await ownerServerId(ctx, owner)) ?? ""}`,
      headers: authHeader(owner),
      payload: { name: "friends" },
    });
    expect(rename.statusCode).toBe(200);
    expect(rename.json()).toMatchObject({ name: "friends" });

    const second = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/servers",
      headers: authHeader(owner),
      payload: { name: "second" },
    });
    expect(second.statusCode).toBe(200);
    const listRes = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/servers",
      headers: authHeader(owner),
    });
    const list = listRes.json() as { id: string }[];
    expect(list).toHaveLength(2);

    const firstId = await ownerServerId(ctx, owner);
    const state = serverStateSchema.parse(
      await (
        await ctx.app.inject({
          method: "GET",
          url: `/api/v1/servers/${firstId}/state`,
          headers: authHeader(owner),
        })
      ).json(),
    );
    const memberRole = state.roles.find((role) => role.name === "member");
    const editFlags = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/servers/${firstId}/roles/${memberRole?.id}`,
      headers: authHeader(owner),
      payload: { flags: { share_screen: false } },
    });
    expect(editFlags.statusCode).toBe(200);
    expect(editFlags.json()).toMatchObject({
      flags: { share_screen: false, connect: true },
    });
  });
});
