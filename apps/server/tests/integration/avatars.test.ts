import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
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
import { resetRateLimits } from "../../src/lib/rate-limit.js";

const BOUNDARY = "----vitality-avatar-boundary";

function multipart(data: Buffer, filename = "avatar.png"): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      "utf8",
    ),
    data,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`, "utf8"),
  ]);
}

async function pngOf(width: number, height: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({ create: { width, height, channels: 3, background: "#3366ff" } })
    .png()
    .toBuffer();
}

async function uploadAvatar(
  ctx: TestContext,
  user: TestUser,
  data: Buffer,
): Promise<{ status: number; json: unknown }> {
  const res = await ctx.app.inject({
    method: "PUT",
    url: "/api/v1/users/me/avatar",
    headers: {
      ...authHeader(user),
      "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
    },
    payload: multipart(data),
  });
  return { status: res.statusCode, json: res.json() };
}

describeIf("avatars", () => {
  let ctx: TestContext;
  let uploadDir = "";
  beforeAll(async () => {
    uploadDir = await mkdtemp(path.join(tmpdir(), "vitality-avatars-"));
    ctx = await setup({ uploadDir });
  });
  beforeEach(async () => {
    await resetDatabase(ctx);
    resetRateLimits();
  });
  afterAll(async () => {
    await teardown(ctx);
    await rm(uploadDir, { recursive: true, force: true });
  });

  it("stores an avatar and serves it back over the signed URL without a token", async () => {
    const user = await registerUser(ctx, "avataruser");
    const uploaded = await uploadAvatar(ctx, user, await pngOf(600, 300));
    expect(uploaded.status).toBe(200);
    const avatarUrl = (uploaded.json as { avatarUrl: string }).avatarUrl;
    expect(avatarUrl).toMatch(new RegExp(`^/api/v1/users/${user.id}/avatar\\?e=\\d+&s=`));

    // No Authorization header: the signed URL is the capability.
    const res = await ctx.app.inject({ method: "GET", url: avatarUrl });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    const sharp = (await import("sharp")).default;
    const meta = await sharp(res.rawPayload).metadata();
    expect(meta.width).toBe(256);
    expect(meta.height).toBe(256);
  });

  it("rejects a forged or expired signature", async () => {
    const user = await registerUser(ctx, "forger");
    const uploaded = await uploadAvatar(ctx, user, await pngOf(64, 64));
    const avatarUrl = (uploaded.json as { avatarUrl: string }).avatarUrl;
    const forged = avatarUrl.replace(/s=.*/, "s=deadbeef");
    expect((await ctx.app.inject({ method: "GET", url: forged })).statusCode).toBe(401);
    const expired = avatarUrl.replace(/e=\d+/, "e=1");
    expect((await ctx.app.inject({ method: "GET", url: expired })).statusCode).toBe(401);
  });

  it("rejects non-images and oversized files", async () => {
    const user = await registerUser(ctx, "badimage");
    const gif = await uploadAvatar(
      ctx,
      user,
      Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64"),
    );
    expect(gif.status).toBe(415);
    const huge = await uploadAvatar(ctx, user, Buffer.alloc(3 * 1024 * 1024, 0x41));
    expect(huge.status).toBe(413);
  });

  it("only lets a user change their own avatar", async () => {
    const alice = await registerUser(ctx, "aliceavatar");
    const bob = await registerUser(ctx, "bobalavatar");
    await uploadAvatar(ctx, alice, await pngOf(64, 64));
    // There is no id-addressed mutation route: /me/avatar always targets the
    // caller, so Bob's upload can never touch Alice's row.
    const bobUpload = await uploadAvatar(ctx, bob, await pngOf(64, 64));
    expect(bobUpload.status).toBe(200);
    const bobAvatar = (bobUpload.json as { avatarUrl: string }).avatarUrl;
    expect(bobAvatar).toContain(bob.id);
    expect(bobAvatar).not.toContain(alice.id);
    // Unauthenticated mutation is rejected outright.
    const anon = await ctx.app.inject({
      method: "PUT",
      url: "/api/v1/users/me/avatar",
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipart(await pngOf(8, 8)),
    });
    expect(anon.statusCode).toBe(401);
  });

  it("rate-limits repeated avatar uploads", async () => {
    const user = await registerUser(ctx, "spammer");
    const png = await pngOf(32, 32);
    let limited = false;
    for (let i = 0; i < 12; i += 1) {
      const res = await uploadAvatar(ctx, user, png);
      if (res.status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });

  it("removes a custom avatar and reverts to the generated default", async () => {
    const user = await registerUser(ctx, "remover");
    const uploaded = await uploadAvatar(ctx, user, await pngOf(64, 64));
    const avatarUrl = (uploaded.json as { avatarUrl: string }).avatarUrl;
    const removed = await ctx.app.inject({
      method: "DELETE",
      url: "/api/v1/users/me/avatar",
      headers: authHeader(user),
    });
    expect(removed.statusCode).toBe(200);
    expect((removed.json() as { avatarUrl: string | null }).avatarUrl).toBeNull();
    // The old signed URL now resolves to 404 (no avatar behind it).
    expect((await ctx.app.inject({ method: "GET", url: avatarUrl })).statusCode).toBe(404);
  });

  it("exposes avatarUrl in the member list payload", async () => {
    const owner = await registerUser(ctx, "ownermember");
    const server = (
      await ctx.app.inject({
        method: "POST",
        url: "/api/v1/servers",
        headers: authHeader(owner),
        payload: { name: "Avatar Server" },
      })
    ).json() as { id: string };
    await uploadAvatar(ctx, owner, await pngOf(48, 48));
    const state = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/servers/${server.id}/state`,
      headers: authHeader(owner),
    });
    const body = state.json() as {
      memberList: { user: { id: string; avatarUrl: string | null } }[];
    };
    const me = body.memberList.find((entry) => entry.user.id === owner.id);
    expect(me?.user.avatarUrl).toContain(`/api/v1/users/${owner.id}/avatar?e=`);
  });
});

