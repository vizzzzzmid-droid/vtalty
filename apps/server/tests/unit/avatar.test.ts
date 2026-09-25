import { describe, expect, it } from "vitest";
import {
  AVATAR_MAX_BYTES,
  AVATAR_SIZE,
  assertAvatarType,
  resizeAvatar,
} from "../../src/modules/users/service.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG_MIN = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', "utf8");
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from("WEBPVP8 ", "ascii"),
]);

function httpErrorCode(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    return (err as { code: string }).code;
  }
  throw new Error("expected the call to throw");
}

describe("avatar upload validation", () => {
  it("accepts png, jpeg and webp by magic bytes", () => {
    expect(() => assertAvatarType(PNG_1X1)).not.toThrow();
    expect(() => assertAvatarType(JPEG_MIN)).not.toThrow();
    expect(() => assertAvatarType(WEBP)).not.toThrow();
  });

  it("rejects non-image and scriptable payloads (gif, svg, html)", () => {
    expect(httpErrorCode(() => assertAvatarType(GIF))).toBe("UNSUPPORTED_FILE_TYPE");
    expect(httpErrorCode(() => assertAvatarType(SVG))).toBe("UNSUPPORTED_FILE_TYPE");
    expect(httpErrorCode(() => assertAvatarType(Buffer.from("<html>hi</html>", "utf8")))).toBe(
      "UNSUPPORTED_FILE_TYPE",
    );
  });

  it("rejects empty and oversized uploads", () => {
    expect(httpErrorCode(() => assertAvatarType(Buffer.alloc(0)))).toBe("EMPTY_FILE");
    expect(httpErrorCode(() => assertAvatarType(Buffer.alloc(AVATAR_MAX_BYTES + 1)))).toBe(
      "FILE_TOO_LARGE",
    );
  });
});

describe("avatar resize", () => {
  it("re-encodes to a fixed 256x256 png regardless of source size", async () => {
    const sharp = (await import("sharp")).default;
    const source = await sharp({
      create: { width: 800, height: 400, channels: 3, background: "#ff0000" },
    })
      .png()
      .toBuffer();
    const out = await resizeAvatar(source);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(AVATAR_SIZE);
    expect(meta.height).toBe(AVATAR_SIZE);
    expect(meta.format).toBe("png");
  });

  it("rejects corrupt image data", async () => {
    const broken = Buffer.concat([JPEG_MIN, Buffer.alloc(64, 0x41)]);
    await expect(resizeAvatar(broken)).rejects.toThrow();
  });
});
