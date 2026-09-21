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
} from "./helpers.js";

describeIf("channels", () => {
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

  it("enforces manage_channels and guards non-empty categories", async () => {
    const owner = await registerUser(ctx, "owner");
    const serversRes = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/servers",
      headers: authHeader(owner),
    });
    const servers = serversRes.json() as { id: string }[];
    const serverId = servers[0]?.id ?? "";

    const inviteRes = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/servers/${serverId}/invites`,
      headers: authHeader(owner),
      payload: {},
    });
    const invite = inviteRes.json() as { code: string };
    const friend = await registerUser(ctx, "friend", invite.code);

    const denied = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/servers/${serverId}/channels`,
      headers: authHeader(friend),
      payload: { name: "hacks", type: "text" },
    });
    expect(denied.statusCode).toBe(403);

    const categoryRes = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/servers/${serverId}/categories`,
      headers: authHeader(owner),
      payload: { name: "Games" },
    });
    const category = categoryRes.json() as { id: string };

    const voiceRes = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/servers/${serverId}/channels`,
      headers: authHeader(owner),
      payload: { name: "Lobby", type: "voice", categoryId: category.id },
    });
    const voice = voiceRes.json() as { id: string; position: number };
    expect(voice.position).toBeGreaterThanOrEqual(2);

    const rename = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/channels/${voice.id}`,
      headers: authHeader(owner),
      payload: { name: "lobby" },
    });
    expect(rename.statusCode).toBe(200);
    expect(rename.json()).toMatchObject({ name: "lobby", type: "voice" });

    const blocked = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/categories/${category.id}`,
      headers: authHeader(owner),
    });
    expect(blocked.statusCode).toBe(409);

    const delChannel = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/channels/${voice.id}`,
      headers: authHeader(owner),
    });
    expect(delChannel.statusCode).toBe(204);

    const delCategory = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/categories/${category.id}`,
      headers: authHeader(owner),
    });
    expect(delCategory.statusCode).toBe(204);

    const state = serverStateSchema.parse(
      await (
        await ctx.app.inject({
          method: "GET",
          url: `/api/v1/servers/${serverId}/state`,
          headers: authHeader(owner),
        })
      ).json(),
    );
    expect(state.channels.map((entry) => entry.name).sort()).toEqual([
      "General",
      "general",
    ]);
  });
});
