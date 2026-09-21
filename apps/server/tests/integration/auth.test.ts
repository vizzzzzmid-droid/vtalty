import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { serverStateSchema } from "@vitality/shared";
import {
  authHeader,
  describeIf,
  extractRefreshCookie,
  registerUser,
  resetDatabase,
  setup,
  teardown,
  type TestContext,
} from "./helpers.js";

describeIf("auth flow", () => {
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

  it("first user becomes owner of a seeded server", async () => {
    const owner = await registerUser(ctx, "owner");
    const serversRes = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/servers",
      headers: authHeader(owner),
    });
    expect(serversRes.statusCode).toBe(200);
    const servers = serversRes.json() as { id: string; name: string }[];
    expect(servers).toHaveLength(1);

    const stateRes = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/servers/${servers[0]?.id}/state`,
      headers: authHeader(owner),
    });
    expect(stateRes.statusCode).toBe(200);
    const state = serverStateSchema.parse(await stateRes.json());
    expect(state.roles.map((role) => role.name).sort()).toEqual([
      "admin",
      "member",
      "owner",
    ]);
    const channelNames = state.channels.map((channel) => channel.name).sort();
    expect(channelNames).toEqual(["General", "general"]);
    const ownerMember = state.members.find(
      (member) => member.userId === owner.id,
    );
    expect(ownerMember?.roleId).toBe(
      state.roles.find((role) => role.name === "owner")?.id,
    );
  });

  it("rejects second registration without an invite", async () => {
    await registerUser(ctx, "owner");
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { username: "nobody", password: "password-123" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "INVITE_REQUIRED" } });
  });

  it("registers with an invite, logs in, reads me", async () => {
    const owner = await registerUser(ctx, "owner");
    const stateRes = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/servers",
      headers: authHeader(owner),
    });
    const serverId = (stateRes.json() as { id: string }[])[0]?.id ?? "";
    const inviteRes = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/servers/${serverId}/invites`,
      headers: authHeader(owner),
      payload: {},
    });
    expect(inviteRes.statusCode).toBe(200);
    const code = (inviteRes.json() as { code: string }).code;

    const friend = await registerUser(ctx, "friend", code);
    expect(friend.id).toBeDefined();

    const loginRes = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "friend", password: "password-123" },
    });
    expect(loginRes.statusCode).toBe(200);

    const badRes = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "friend", password: "wrong-password" },
    });
    expect(badRes.statusCode).toBe(401);

    const meRes = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: authHeader(friend),
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json()).toMatchObject({ username: "friend" });

    const anonRes = await ctx.app.inject({ method: "GET", url: "/api/v1/auth/me" });
    expect(anonRes.statusCode).toBe(401);
  });

  it("redeems single-use invites atomically under concurrency", async () => {
    const owner = await registerUser(ctx, "owner");
    const serversRes = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/servers",
      headers: authHeader(owner),
    });
    const serverId = (serversRes.json() as { id: string }[])[0]?.id ?? "";
    const inviteRes = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/servers/${serverId}/invites`,
      headers: authHeader(owner),
      payload: { maxUses: 1 },
    });
    const code = (inviteRes.json() as { code: string }).code;

    const attempts = await Promise.allSettled(
      ["racer0", "racer1", "racer2", "racer3", "racer4"].map((username) =>
        registerUser(ctx, username, code),
      ),
    );
    const succeeded = attempts.filter(
      (result) => result.status === "fulfilled",
    );
    expect(succeeded).toHaveLength(1);
  });

  it("rotates refresh tokens and detects reuse", async () => {
    const user = await registerUser(ctx, "rotator");
    const first = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie: user.refreshCookie },
    });
    expect(first.statusCode).toBe(200);
    const secondCookie = extractRefreshCookie(first.headers);

    // Old (rotated) cookie is now revoked.
    const reuse = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie: user.refreshCookie },
    });
    expect(reuse.statusCode).toBe(401);

    // Reuse revokes the whole family, so the rotated cookie dies too.
    const afterTheft = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie: secondCookie },
    });
    expect(afterTheft.statusCode).toBe(401);
  });

  it("logs out and kills the session family", async () => {
    const user = await registerUser(ctx, "quitter");
    const logoutRes = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie: user.refreshCookie },
    });
    expect(logoutRes.statusCode).toBe(204);
    const after = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie: user.refreshCookie },
    });
    expect(after.statusCode).toBe(401);
  });
});
