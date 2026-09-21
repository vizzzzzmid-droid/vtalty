import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** Storage backend for uploads. S3/MinIO can implement this later. */
export interface UploadStorage {
  save(key: string, data: Buffer): Promise<void>;
  load(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** Local-disk driver on a Docker volume. Keys are server-generated. */
export class LocalStorage implements UploadStorage {
  constructor(private readonly dir: string) {}

  /** Resolve a key strictly inside the storage dir (path-traversal guard). */
  resolve(key: string): string {
    const root = path.resolve(this.dir);
    const full = path.resolve(root, key);
    if (full !== root && full.startsWith(root + path.sep)) {
      return full;
    }
    throw new Error("storage key escapes the upload directory");
  }

  async save(key: string, data: Buffer): Promise<void> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data);
  }

  async load(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await unlink(this.resolve(key));
  }
}
