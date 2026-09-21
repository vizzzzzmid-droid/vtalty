// Dev launcher: rebuilds main+renderer, then starts Electron.
// Usage: VITALITY_SERVER_URL=https://... pnpm --filter @vitality/desktop dev
// (or: node scripts/dev.mjs --server-url https://...)
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const flagIndex = process.argv.indexOf("--server-url");
const flagUrl = flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;
if (typeof flagUrl === "string" && process.env["VITALITY_SERVER_URL"] === undefined) {
  process.env["VITALITY_SERVER_URL"] = flagUrl;
}

const extraArgs = process.argv.slice(2).filter((arg, index, all) => {
  if (arg === "--server-url") return false;
  if (index > 0 && all[index - 1] === "--server-url") return false;
  return true;
});

const build = spawnSync("npx", ["tsc", "-p", "tsconfig.json"], { cwd: root, stdio: "inherit", shell: true });
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}
const copy = spawnSync("node", ["scripts/copy-assets.mjs"], { cwd: root, stdio: "inherit", shell: true });
if (copy.status !== 0) {
  process.exit(copy.status ?? 1);
}

const electron = spawnSync("npx", ["electron", ".", ...extraArgs], {
  cwd: root,
  stdio: "inherit",
  shell: true,
  env: process.env,
});
process.exit(electron.status ?? 0);
