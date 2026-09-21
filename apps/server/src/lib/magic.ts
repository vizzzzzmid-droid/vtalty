export interface SniffedType {
  mime: string;
  ext: string;
}

function startsWith(data: Uint8Array, prefix: number[]): boolean {
  if (data.length < prefix.length) {
    return false;
  }
  return prefix.every((byte, index) => data[index] === byte);
}

/**
 * Identify a file by magic bytes, never by client MIME or extension.
 * Only types in this allowlist can be uploaded; SVG/HTML and everything
 * else are rejected (returns null).
 */
export function sniffFileType(data: Uint8Array): SniffedType | null {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: "image/png", ext: "png" };
  }
  if (startsWith(data, [0xff, 0xd8, 0xff])) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (startsWith(data, [0x47, 0x49, 0x46, 0x38])) {
    return { mime: "image/gif", ext: "gif" };
  }
  if (
    data.length >= 12 &&
    startsWith(data, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(data.slice(8, 12), [0x57, 0x45, 0x42, 0x50])
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  if (startsWith(data, [0x25, 0x50, 0x44, 0x46])) {
    return { mime: "application/pdf", ext: "pdf" };
  }
  if (
    startsWith(data, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(data, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(data, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return { mime: "application/zip", ext: "zip" };
  }
  if (
    data.length >= 8 &&
    startsWith(data.slice(4, 8), [0x66, 0x74, 0x79, 0x70])
  ) {
    return { mime: "video/mp4", ext: "mp4" };
  }
  return null;
}

/** Raster images safe to serve inline; everything else is an attachment. */
export function isInlineImage(mime: string): boolean {
  return (
    mime === "image/png" ||
    mime === "image/jpeg" ||
    mime === "image/gif" ||
    mime === "image/webp"
  );
}
