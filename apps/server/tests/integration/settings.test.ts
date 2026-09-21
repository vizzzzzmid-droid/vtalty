import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  authHeader,
  describeIf,
  registerUser,
  resetDatabase,
  setup,
  teardown,
  type TestContext,
} from "./helpers.js";

describeIf("voice settings", () => {
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

  it("returns defaults, merges patches, validates bounds", async () => {
    const user = await registerUser(ctx, "owner");

    const initial = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/users/me/voice-settings",
      headers: authHeader(user),
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      noiseMode: "standard",
      inputVolume: 1,
      pttKey: "Backquote",
    });

    const bad = await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/users/me/voice-settings",
      headers: authHeader(user),
      payload: { noiseMode: "turbo", inputVolume: 99 },
    });
    expect(bad.statusCode).toBe(400);

    const put = await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/users/me/voice-settings",
      headers: authHeader(user),
      payload: { noiseMode: "enhanced", gateEnabled: true, gateThresholdDb: -30 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({
      noiseMode: "enhanced",
      gateEnabled: true,
      gateThresholdDb: -30,
      inputVolume: 1,
    });

    const anon = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/users/me/voice-settings",
    });
    expect(anon.statusCode).toBe(401);
  });
});
