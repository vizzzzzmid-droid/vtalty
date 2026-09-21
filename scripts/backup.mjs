#!/usr/bin/env node
// Backup: pg_dump plus the uploads volume archive into ./backups.
// Usage: node scripts/backup.mjs [--out <dir>]   (also: make backup)
// Pure Node.js; shells out to `docker` (compose project + a temp alpine).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "./preflight.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function sh(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    throw new Error(`command failed: ${cmd} ${args.join(" ")}`);
  }
}

async function main() {
  const outFlag = process.argv.indexOf("--out");
  const outDir = path.resolve(
    ROOT,
    outFlag === -1 ? "backups" : (process.argv[outFlag + 1] ?? "backups"),
  );
  const env = parseEnv(readFileSync(path.join(ROOT, ".env"), "utf8"));
  const user = env["POSTGRES_USER"] ?? "vitality";
  const db = env["POSTGRES_DB"] ?? "vitality";
  mkdirSync(outDir, { recursive: true });

  const tag = stamp();
  const sqlFile = path.join(outDir, `vitality-${tag}.sql`);

  // Database dump through the running postgres container.
  const dump = spawnSync(
    "docker",
    ["compose", "exec", "-T", "postgres", "pg_dump", "-U", user, db],
    { encoding: "utf8", cwd: ROOT, maxBuffer: 512 * 1024 * 1024 },
  );
  if (dump.status !== 0 || dump.stdout.length === 0) {
    throw new Error(`pg_dump failed:\n${dump.stderr ?? ""}\nIs the stack up? (make up)`);
  }
  writeFileSync(sqlFile, dump.stdout, "utf8");

  // Uploads volume archive (read-only mount + temp alpine).
  const uploadsFile = path.join(outDir, `uploads-${tag}.tar.gz`);
  sh("docker", [
    "run",
    "--rm",
    "-v",
    "vitality-uploads:/data:ro",
    "-v",
    `${outDir}:/out`,
    "alpine",
    "tar",
    "czf",
    `/out/uploads-${tag}.tar.gz`,
    "-C",
    "/data",
    ".",
  ], { cwd: ROOT });

  console.log(`Backup complete:\n  ${sqlFile}\n  ${uploadsFile}`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
