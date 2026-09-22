// Shared build step: main+preload (CJS for Electron) + connect-page
// renderer (esbuild ESM bundle for <script type="module">) + static assets.
// Used by `pnpm build`, dev.mjs and dist.mjs alike.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: true });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("npx", ["tsc", "-p", "tsconfig.json"]);
// The sandboxed preload loads as a classic script whose require() cannot
// resolve relative paths or node builtins: bundle shared.js into it and
// keep only electron external.
run("npx", [
  "esbuild",
  "src/preload.ts",
  "--bundle",
  "--format=cjs",
  "--platform=node",
  "--external:electron",
  "--outfile=dist/preload.js",
]);
run("npx", [
  "esbuild",
  "src/renderer/connect.ts",
  "--bundle",
  "--format=esm",
  "--target=chrome120",
  "--outfile=dist/renderer/connect.js",
]);
run("node", ["scripts/copy-assets.mjs"]);
