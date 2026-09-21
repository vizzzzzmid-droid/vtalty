#!/usr/bin/env node
// First-run initializer: creates .env and livekit.yaml from the examples
// with cryptographically random secrets. Pure Node.js (no dependencies),
// so it runs on Linux, macOS and Windows.
//
// Usage:
//   node scripts/init.mjs [--domain <host>] [--ip <public-ip>] [--force]
//   make init
//
// Never overwrites existing files without --force. LIVEKIT_API_KEY/SECRET
// are written identically into .env and livekit.yaml (webhook signing
// breaks otherwise).

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_EXAMPLE = path.join(ROOT, ".env.example");
const ENV_FILE = path.join(ROOT, ".env");
const LIVEKIT_EXAMPLE = path.join(ROOT, "livekit.example.yaml");
const LIVEKIT_FILE = path.join(ROOT, "livekit.yaml");

// Placeholders we expect in the example files. If they change, fail loudly
// instead of writing a broken config. Exported for `make doctor`.
export const PLACEHOLDERS = {
  postgresPassword: "dev-only-password-change-me",
  jwtSecret: "dev-access-secret-please-change-me-32plus-chars",
  livekitKey: "devkey",
  livekitSecret: "dev-livekit-secret-please-change-me-32plus",
};

function parseArgs(argv) {
  const args = { domain: null, ip: null, force: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--force") {
      args.force = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg.startsWith("--domain=")) {
      args.domain = arg.slice("--domain=".length);
    } else if (arg === "--domain") {
      args.domain = argv[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith("--ip=")) {
      args.ip = arg.slice("--ip=".length);
    } else if (arg === "--ip") {
      args.ip = argv[i + 1] ?? null;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg} (see --help)`);
    }
  }
  return args;
}

function prompt(question, fallback) {
  if (!process.stdin.isTTY) {
    return Promise.resolve(fallback);
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed.length > 0 ? trimmed : fallback);
    });
  });
}

export function randomSecret(bytes = 48) {
  return randomBytes(bytes).toString("base64url");
}

export function randomKey() {
  return `vk_${randomBytes(8).toString("hex")}`;
}

function replaceOrThrow(text, needle, value, label) {
  if (!text.includes(needle)) {
    throw new Error(
      `placeholder for ${label} not found in the example file — refusing to guess`,
    );
  }
  return text.split(needle).join(value);
}

export function buildEnv(example, secrets, domain) {
  let out = example;
  out = replaceOrThrow(out, PLACEHOLDERS.postgresPassword, secrets.postgresPassword, "POSTGRES_PASSWORD");
  out = replaceOrThrow(out, PLACEHOLDERS.jwtSecret, secrets.jwtSecret, "JWT_ACCESS_SECRET");
  out = replaceOrThrow(out, PLACEHOLDERS.livekitKey, secrets.livekitKey, "LIVEKIT_API_KEY");
  out = replaceOrThrow(out, PLACEHOLDERS.livekitSecret, secrets.livekitSecret, "LIVEKIT_API_SECRET");
  out = out.replace(/^CADDY_DOMAIN=.*$/m, `CADDY_DOMAIN=${domain}`);
  out = out.replace(/^PUBLIC_APP_URL=.*$/m, `PUBLIC_APP_URL=https://${domain}`);
  out = out.replace(
    /^LIVEKIT_PUBLIC_URL=.*$/m,
    `LIVEKIT_PUBLIC_URL=wss://${domain}/livekit`,
  );
  return out;
}

export function buildLivekitYaml(example, secrets) {
  let out = example;
  out = replaceOrThrow(out, PLACEHOLDERS.livekitKey, secrets.livekitKey, "livekit key");
  out = replaceOrThrow(out, PLACEHOLDERS.livekitSecret, secrets.livekitSecret, "livekit secret");
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: node scripts/init.mjs [--domain <host>] [--ip <public-ip>] [--force]\n" +
        "\nCreates .env and livekit.yaml from the examples with random secrets.\n" +
        "DOMAIN defaults to localhost (no public IP needed). Existing files are\n" +
        "never overwritten without --force.",
    );
    return;
  }
  if (!args.force && (existsSync(ENV_FILE) || existsSync(LIVEKIT_FILE))) {
    const existing = [ENV_FILE, LIVEKIT_FILE].filter((file) => existsSync(file));
    console.error(`Refusing to overwrite: ${existing.join(", ")}\nRe-run with --force to regenerate.`);
    process.exitCode = 1;
    return;
  }
  const domain = args.domain ?? (await prompt("Domain (localhost for dev): ", "localhost"));
  const publicIp = args.ip ?? (await prompt("Public IP (empty to skip the DNS check hint): ", ""));
  if (domain.length === 0 || /[\s]/.test(domain)) {
    console.error("Invalid domain: must be a non-empty hostname without spaces.");
    process.exitCode = 1;
    return;
  }

  const secrets = {
    postgresPassword: randomBytes(24).toString("hex"),
    jwtSecret: randomSecret(48),
    livekitKey: randomKey(),
    livekitSecret: randomSecret(48),
  };
  const envExample = readFileSync(ENV_EXAMPLE, "utf8");
  const livekitExample = readFileSync(LIVEKIT_EXAMPLE, "utf8");
  // Owner-only permissions: both files hold live secrets.
  writeFileSync(ENV_FILE, buildEnv(envExample, secrets, domain), { encoding: "utf8", mode: 0o600 });
  writeFileSync(LIVEKIT_FILE, buildLivekitYaml(livekitExample, secrets), {
    encoding: "utf8",
    mode: 0o600,
  });

  console.log("Wrote .env and livekit.yaml with fresh random secrets.");
  console.log(`  CADDY_DOMAIN=${domain}`);
  console.log(`  LIVEKIT_PUBLIC_URL=wss://${domain}/livekit`);
  if (domain !== "localhost" && publicIp.length === 0) {
    console.log("  Tip: pass --ip <public-ip> next time so `make doctor` can check DNS.");
  }
  console.log("\nNext steps:");
  console.log("  1. make doctor     # preflight checks (ports, secrets, DNS)");
  console.log("  2. make up         # build and start the full stack");
  console.log("  3. Open https://" + domain + " and register the first user (becomes owner).");
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
