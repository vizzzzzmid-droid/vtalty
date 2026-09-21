import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalStorage } from "../../src/modules/uploads/storage.js";

describe("LocalStorage", () => {
  let dir = "";
  afterEach(async () => {
    if (dir.length > 0) {
      await rm(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  it("round-trips files under generated keys", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "vitality-uploads-"));
    const storage = new LocalStorage(dir);
    await storage.save("abc123.png", Buffer.from([1, 2, 3]));
    await expect(storage.load("abc123.png")).resolves.toEqual(Buffer.from([1, 2, 3]));
    await storage.delete("abc123.png");
    await expect(storage.load("abc123.png")).rejects.toThrow();
  });

  it("refuses path traversal keys", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "vitality-uploads-"));
    const storage = new LocalStorage(dir);
    // Forward-slash traversal escapes on every OS (backslash is a legal
    // filename character on Linux, so it is not asserted here).
    for (const evil of ["../evil.png", "../../evil.png", "sub/../../evil.png", "/abs.png"]) {
      await expect(storage.save(evil, Buffer.from([1]))).rejects.toThrow(/escapes/);
    }
  });
});
