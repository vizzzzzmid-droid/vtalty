import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
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
import { cleanupOrphanUploads } from "../../src/modules/uploads/service.js";
import { LocalStorage } from "../../src/modules/uploads/storage.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG_MIN = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

function buildMultipart(
  boundary: string,
  files: { field: string; filename: string; contentType: string; data: Buffer }[],
): Buffer {
  const chunks: Buffer[] = [];
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
        "utf8",
      ),
    );
    chunks.push(file.data);
    chunks.push(Buffer.from("\r\n", "utf8"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return Buffer.concat(chunks);
}

async function upload(
  ctx: TestContext,
  user: TestUser,
  channelId: string,
  files: { field: string; filename: string; contentType: string; data: Buffer }[],
): Promise<{ status: number; json: unknown; headers: unknown }> {
  const boundary = "----vitality-test-boundary";
  const res = (await ctx.app.inject({
    method: "POST",
    url: `/api/v1/channels/${channelId}/attachments`,
    headers: {
      ...authHeader(user),
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload: buildMultipart(boundary, files),
  })) as unknown as {
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    json: () => unknown;
  };
  return { status: res.statusCode, json: res.json(), headers: res.headers };
}

describeIf("uploads", () => {
  let ctx: TestContext;
  let uploadDir = "";
  beforeAll(async () => {
    uploadDir = await mkdtemp(path.join(tmpdir(), "vitality-uploads-"));
    ctx = await setup({ uploadMaxBytes: 2048, uploadDir });
  });
  beforeEach(async () => {
    await resetDatabase(ctx);
  });
  afterAll(async () => {
    await teardown(ctx);
    await rm(uploadDir, { recursive: true, force: true });
  });

  it("accepts real images, serves them inline, sniffs type", async () => {
    const owner = await registerUser(ctx, "owner");
    const servers = (await (
      await ctx.app.inject({
        method: "GET",
        url: "/api/v1/servers",
        headers: authHeader(owner),
      })
    ).json()) as { id: string }[];
    const serverId = servers[0]?.id ?? "";
    const state = (await (
      await ctx.app.inject({
        method: "GET",
        url: `/api/v1/servers/${serverId}/state`,
        headers: authHeader(owner),
      })
    ).json()) as { channels: { id: string; name: string }[] };
    const channelId = state.channels.find((entry) => entry.name === "general")?.id ?? "";

    // Client lies about name and MIME: magic bytes decide.
    const up = await upload(ctx, owner, channelId, [
      { field: "file", filename: "evil.exe", contentType: "application/x-msdownload", data: PNG_1X1 },
    ]);
    expect(up.status).toBe(200);
    const [attachment] = up.json as {
      id: string;
      filename: string;
      mime: string;
      size: number;
      url: string;
    }[];
    if (attachment === undefined) {
      throw new Error("upload returned no attachments");
    }
    expect(attachment.mime).toBe("image/png");
    expect(attachment.url).toBe(`/api/v1/attachments/${attachment.id}`);

    const served = await ctx.app.inject({
      method: "GET",
      url: attachment.url,
      headers: authHeader(owner),
    });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toBe("image/png");
    expect(served.headers["x-content-type-options"]).toBe("nosniff");
    expect(served.headers["content-disposition"]).toBe("inline");
    // light-my-request v6 exposes the raw bytes as `rawPayload` (Buffer).
    const rawPayload = (served as unknown as { rawPayload: Buffer }).rawPayload;
    expect(Buffer.compare(rawPayload, PNG_1X1)).toBe(0);
  });

  it("rejects spoofed, unsupported and oversized files", async () => {
    const owner = await registerUser(ctx, "owner");
    const servers = (await (
      await ctx.app.inject({
        method: "GET",
        url: "/api/v1/servers",
        headers: authHeader(owner),
      })
    ).json()) as { id: string }[];
    const serverId = servers[0]?.id ?? "";
    const state = (await (
      await ctx.app.inject({
        method: "GET",
        url: `/api/v1/servers/${serverId}/state`,
        headers: authHeader(owner),
      })
    ).json()) as { channels: { id: string; name: string }[] };
    const channelId = state.channels.find((entry) => entry.name === "general")?.id ?? "";

    const fakePng = await upload(ctx, owner, channelId, [
      {
        field: "file",
        filename: "photo.png",
        contentType: "image/png",
        data: Buffer.from("this is plain text, not a png", "utf8"),
      },
    ]);
    expect(fakePng.status).toBe(415);

    const svg = await upload(ctx, owner, channelId, [
      {
        field: "file",
        filename: "pic.svg",
        contentType: "image/svg+xml",
        data: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>", "utf8"),
      },
    ]);
    expect(svg.status).toBe(415);

    const big = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(3000, 0),
    ]);
    const oversized = await upload(ctx, owner, channelId, [
      { field: "file", filename: "big.png", contentType: "image/png", data: big },
    ]);
    expect(oversized.status).toBe(413);
  });

  it("claims uploads on send and guards serving", async () => {
    const owner = await registerUser(ctx, "owner");
    const servers = (await (
      await ctx.app.inject({
        method: "GET",
        url: "/api/v1/servers",
        headers: authHeader(owner),
      })
    ).json()) as { id: string }[];
    const serverId = servers[0]?.id ?? "";
    const invite = (await (
      await ctx.app.inject({
        method: "POST",
        url: `/api/v1/servers/${serverId}/invites`,
        headers: authHeader(owner),
        payload: {},
      })
    ).json()) as { code: string };
    const friend = await registerUser(ctx, "friend", invite.code);
    const state = (await (
      await ctx.app.inject({
        method: "GET",
        url: `/api/v1/servers/${serverId}/state`,
        headers: authHeader(owner),
      })
    ).json()) as { channels: { id: string; name: string }[] };
    const channelId = state.channels.find((entry) => entry.name === "general")?.id ?? "";

    const up = await upload(ctx, owner, channelId, [
      { field: "file", filename: "a.jpg", contentType: "image/jpeg", data: JPEG_MIN },
    ]);
    const [attachment] = up.json as { id: string }[];

    const sent = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: authHeader(owner),
      payload: { content: "", attachmentIds: [attachment?.id] },
    });
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toMatchObject({
      content: "",
      attachments: [{ id: attachment?.id, mime: "image/jpeg" }],
    });

    // Claimed attachments cannot be reused in another message.
    const reuse = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: authHeader(owner),
      payload: { content: "again", attachmentIds: [attachment?.id] },
    });
    expect(reuse.statusCode).toBe(400);

    // Members can download; outsiders get 404 ( kick friend out first ).
    const members = (await (
      await ctx.app.inject({
        method: "GET",
        url: `/api/v1/servers/${serverId}/state`,
        headers: authHeader(owner),
      })
    ).json()) as { members: { id: string; userId: string }[] };
    const friendMember = members.members.find((entry) => entry.userId === friend.id);
    await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/members/${friendMember?.id}`,
      headers: authHeader(owner),
    });
    const denied = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/attachments/${attachment?.id}`,
      headers: authHeader(friend),
    });
    expect(denied.statusCode).toBe(404);
    const allowed = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/attachments/${attachment?.id}`,
      headers: authHeader(owner),
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("purges only old unclaimed uploads", async () => {
    const owner = await registerUser(ctx, "owner");
    const servers = (await (
      await ctx.app.inject({
        method: "GET",
        url: "/api/v1/servers",
        headers: authHeader(owner),
      })
    ).json()) as { id: string }[];
    const serverId = servers[0]?.id ?? "";
    const state = (await (
      await ctx.app.inject({
        method: "GET",
        url: `/api/v1/servers/${serverId}/state`,
        headers: authHeader(owner),
      })
    ).json()) as { channels: { id: string; name: string }[] };
    const channelId = state.channels.find((entry) => entry.name === "general")?.id ?? "";
    const file = {
      field: "file",
      filename: "old.png",
      contentType: "image/png",
      data: PNG_1X1,
    };

    const oldUp = await upload(ctx, owner, channelId, [file]);
    const oldId = ((oldUp.json as { id: string }[])[0]?.id ?? "");
    const freshUp = await upload(ctx, owner, channelId, [file]);
    const freshId = ((freshUp.json as { id: string }[])[0]?.id ?? "");
    const claimedUp = await upload(ctx, owner, channelId, [file]);
    const claimedId = ((claimedUp.json as { id: string }[])[0]?.id ?? "");
    const sent = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/channels/${channelId}/messages`,
      headers: authHeader(owner),
      payload: { content: "with file", attachmentIds: [claimedId] },
    });
    expect(sent.statusCode).toBe(201);

    // Age the old unclaimed row and the claimed row by 2 days; only the
    // old *unclaimed* one must go (fresh unclaimed + claimed survive).
    await ctx.db.db.execute(
      sql`UPDATE attachments SET created_at = now() - interval '2 days' WHERE id = ${oldId} OR id = ${claimedId}`,
    );
    const summary = await cleanupOrphanUploads(ctx.db.db, new LocalStorage(uploadDir), 24);
    expect(summary.deleted).toBe(1);
    expect(summary.bytes).toBeGreaterThan(0);

    const remaining = (await ctx.db.db.execute(
      sql`SELECT id FROM attachments`,
    )) as unknown;
    const rows = Array.isArray(remaining)
      ? (remaining as { id: string }[])
      : ((remaining as { rows?: { id: string }[] }).rows ?? []);
    const ids = rows.map((row) => row.id);
    expect(ids).not.toContain(oldId);
    expect(ids).toContain(freshId);
    expect(ids).toContain(claimedId);

    const gone = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/attachments/${oldId}`,
      headers: authHeader(owner),
    });
    expect(gone.statusCode).toBe(404);
  });
});
