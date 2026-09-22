// Deterministic local `dist` without Docker or bash:
// 1. clean + tsc build, 2. copy renderer HTML, 3. electron-builder targets
// for the CURRENT platform (win: nsis, linux: AppImage, mac: skip).
// Usage: node scripts/dist.mjs  (extra args forwarded to electron-builder)
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: true });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const forwarded = process.argv.slice(2).filter((arg) => arg !== "--");
const hasTarget = forwarded.some((arg) => arg === "--win" || arg === "--linux" || arg === "--mac" || arg === "--dir");
const defaults =
  process.platform === "win32" ? ["--win", "nsis"] : process.platform === "darwin" ? ["--dir"] : ["--linux", "AppImage"];

rmSync(path.join(root, "dist"), { recursive: true, force: true });
run("node", ["scripts/build.mjs"]);
run("npx", ["electron-builder", ...(hasTarget ? forwarded : [...defaults, ...forwarded])]);
