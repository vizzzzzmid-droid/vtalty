import { describe, expect, it } from "vitest";
import { isInlineImage, sniffFileType } from "../../src/lib/magic.js";

const png = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
]);
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const webp = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const zip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const mp4 = Uint8Array.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
]);

describe("sniffFileType", () => {
  it("identifies images, pdf, zip and mp4 by magic bytes", () => {
    expect(sniffFileType(png)).toEqual({ mime: "image/png", ext: "png" });
    expect(sniffFileType(jpeg)).toEqual({ mime: "image/jpeg", ext: "jpg" });
    expect(sniffFileType(gif)).toEqual({ mime: "image/gif", ext: "gif" });
    expect(sniffFileType(webp)).toEqual({ mime: "image/webp", ext: "webp" });
    expect(sniffFileType(pdf)).toEqual({ mime: "application/pdf", ext: "pdf" });
    expect(sniffFileType(zip)).toEqual({ mime: "application/zip", ext: "zip" });
    expect(sniffFileType(mp4)).toEqual({ mime: "video/mp4", ext: "mp4" });
  });

  it("rejects SVG, HTML, scripts and truncated headers", () => {
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'>");
    const html = new TextEncoder().encode("<!DOCTYPE html><html>");
    const elf = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46]);
    expect(sniffFileType(svg)).toBeNull();
    expect(sniffFileType(html)).toBeNull();
    expect(sniffFileType(elf)).toBeNull();
    expect(sniffFileType(new Uint8Array(0))).toBeNull();
    expect(sniffFileType(Uint8Array.from([0x89, 0x50]))).toBeNull();
  });

  it("only allows raster images inline", () => {
    expect(isInlineImage("image/png")).toBe(true);
    expect(isInlineImage("image/webp")).toBe(true);
    expect(isInlineImage("application/pdf")).toBe(false);
    expect(isInlineImage("image/svg+xml")).toBe(false);
    expect(isInlineImage("text/html")).toBe(false);
  });
});
