#!/usr/bin/env node
// Generates the original vitality placeholder icon set (no third-party art):
// Pure Node.js (zlib only). Output: assets/icon.png (512), assets/icon.ico.
// Run: node scripts/generate-icon.mjs   (also wired as `pnpm --filter @vitality/desktop icon`)
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIZE = 512;
void SIZE;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c % 2 === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, sum]);
}

function roundedRectPixels(size) {
  // Returns RGBA rows: dark rounded square + violet ring + center dot.
  const radius = 112;
  const pixels = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const violet = [143, 123, 255];
  const dark = [30, 31, 34];
  const set = (x, y, color, alpha) => {
    const offset = (y * size + x) * 4;
    pixels[offset] = color[0];
    pixels[offset + 1] = color[1];
    pixels[offset + 2] = color[2];
    pixels[offset + 3] = alpha;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = Math.min(x, size - 1 - x);
      const dy = Math.min(y, size - 1 - y);
      const corner = Math.hypot(Math.max(radius - dx, 0), Math.max(radius - dy, 0));
      if (corner > radius) {
        set(x, y, [0, 0, 0], 0);
        continue;
      }
      const dist = Math.hypot(x - cx, y - cy);
      if (Math.abs(dist - 118) < 26) {
        set(x, y, violet, 255);
      } else if (dist < 52) {
        set(x, y, violet, 255);
      } else {
        set(x, y, dark, 255);
      }
    }
  }
  return pixels;
}

function encodePng(size) {
  const raw = roundedRectPixels(size);
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    rows.push(Buffer.concat([Buffer.from([0]), raw.subarray(y * size * 4, (y + 1) * size * 4)]));
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function encodeIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 0; // 256px stored as 0
  entry[1] = 0;
  entry[2] = 0; // palette
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(6 + 16, 12);
  return Buffer.concat([header, entry, png]);
}

const assets = path.join(ROOT, "assets");
mkdirSync(assets, { recursive: true });
const png512 = encodePng(512);
writeFileSync(path.join(assets, "icon.png"), png512);
const png256 = encodePng(256);
writeFileSync(path.join(assets, "icon.ico"), encodeIco(png256));
console.log(`Wrote assets/icon.png (${png512.length} bytes) and assets/icon.ico.`);
