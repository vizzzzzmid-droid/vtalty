#!/usr/bin/env node
// Restore a backup created by scripts/backup.mjs.
// Usage: node scripts/restore.mjs --sql <file> [--uploads <file>] [--yes]
//        make restore SQL=... UPLOADS=...   (add YES=1 to skip confirmation)
// DESTRUCTIVE: wipes the database schema and the uploads volume first.
// Pure Node.js; shells out to `docker`.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { parseEnv } from "./preflight.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function flag(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function sh(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    throw new Error(`command failed: ${cmd} ${args.join(" ")}`);
  }
}

async function confirm(question) {
  if (flag("--yes") !== null || process.env["YES"] === "1") {
    return true;
  }
  if (!process.stdin.isTTY) {
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function main() {
  const sqlFlag = flag("--sql") ?? process.env["SQL"] ?? null;
  const uploadsFlag = flag("--uploads") ?? process.env["UPLOADS"] ?? null;
  // GNU make always passes the variables (possibly empty): treat "" as absent.
  const sqlFile = sqlFlag === null || sqlFlag.length === 0 ? null : sqlFlag;
  const uploadsFile = uploadsFlag === null || uploadsFlag.length === 0 ? null : uploadsFlag;
  if (sqlFile === null && uploadsFile === null) {
    console.error("Nothing to restore: pass --sql <file> and/or --uploads <file>.");
    process.exitCode = 1;
    return;
  }
  for (const file of [sqlFile, uploadsFile]) {
    if (file !== null && !existsSync(path.resolve(file))) {
      console.error(`File not found: ${file}`);
      process.exitCode = 1;
      return;
    }
  }
  const ok = await confirm(
    "This WIPES the database schema and uploads volume, then restores. Continue? [y/N] ",
  );
  if (!ok) {
    console.log("Aborted.");
    return;
  }

  const env = parseEnv(readFileSync(path.join(ROOT, ".env"), "utf8"));
  const user = env["POSTGRES_USER"] ?? "vitality";
  const db = env["POSTGRES_DB"] ?? "vitality";

  if (sqlFile !== null) {
    // Recreate empty schemas, then import (plain pg_dump has no --clean).
    // The drizzle journal lives in its own schema outside public: drop it
    // too, or the import aborts on "schema drizzle already exists".
    sh("docker", [
      "compose", "exec", "-T", "postgres",
      "psql", "-U", user, "-d", db,
      "-c", "DROP SCHEMA public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;",
    ], { cwd: ROOT });
    const sql = readFileSync(path.resolve(sqlFile), "utf8");
    const imported = spawnSync(
      "docker",
      ["compose", "exec", "-T", "postgres", "psql", "-U", user, "-d", db, "-v", "ON_ERROR_STOP=1"],
      { input: sql, encoding: "utf8", cwd: ROOT, maxBuffer: 512 * 1024 * 1024 },
    );
    if (imported.status !== 0) {
      throw new Error(`psql import failed:\n${imported.stderr ?? ""}`);
    }
    console.log(`Database restored from ${sqlFile}.`);
  }

  if (uploadsFile !== null) {
    const absolute = path.resolve(uploadsFile);
    sh("docker", [
      "run", "--rm",
      "-v", "vitality-uploads:/data",
      "-v", `${path.dirname(absolute)}:/in:ro`,
      "alpine", "sh", "-c",
      `rm -rf /data/* /data/..?* /data/.[!.]* ; tar xzf /in/${path.basename(absolute)} -C /data`,
    ], { cwd: ROOT });
    console.log(`Uploads restored from ${uploadsFile}.`);
  }
  console.log("Done. Restart the server (`docker compose restart server`) to re-run migrations.");
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
