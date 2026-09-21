#!/usr/bin/env node
// Preflight checks for first runs: `make doctor` / `node scripts/preflight.mjs`.
// Pure Node.js (no dependencies): Docker versions, free ports, .env secrets,
// LiveKit key match between .env and livekit.yaml, DNS sanity (warning
// only), free disk space. Every failure prints an actionable message.
// Exit code: 0 when nothing FAILs, 1 otherwise (warnings never fail).

import { execFile } from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns/promises";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PLACEHOLDERS } from "./init.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const TCP_PORTS = [80, 443, 7881, 5349];
const UDP_PORTS = [7882, 3478];
const MIN_DISK_BYTES = 5 * 1024 * 1024 * 1024;

export function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    if (index === -1) {
      continue;
    }
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Extract { key, secret } from a livekit.yaml text. Throws with context. */
export function parseLivekitKeys(text) {
  const apiKeyMatch = text.match(/^\s*api_key:\s*(\S+)\s*$/m);
  const keysBlock = text.match(/^keys:\s*\n((?:[ \t]+\S.*\n?)+)/m);
  let pair = null;
  if (keysBlock !== null) {
    const entry = keysBlock[1].match(/^\s*(\S+):\s*(\S+)\s*$/m);
    if (entry !== null) {
      pair = { key: entry[1], secret: entry[2] };
    }
  }
  if (apiKeyMatch === null || pair === null) {
    throw new Error("could not find keys:/api_key in livekit.yaml");
  }
  return { apiKey: apiKeyMatch[1], key: pair.key, secret: pair.secret };
}

function tcpPortFree(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1", timeout: 800 });
    socket.on("connect", () => {
      socket.destroy();
      resolve("occupied");
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve("unknown");
    });
    socket.on("error", (err) => {
      resolve(err.code === "ECONNREFUSED" ? "free" : "unknown");
    });
  });
}

function udpPortFree(port) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    socket.on("error", (err) => {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      resolve(err.code === "EADDRINUSE" ? "occupied" : "unknown");
    });
    socket.bind(port, "0.0.0.0", () => {
      socket.close();
      resolve("free");
    });
  });
}

async function commandVersion(command, args) {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 10000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

function localAddresses() {
  const found = new Set();
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const entry of interfaces ?? []) {
      if (!entry.internal) {
        found.add(entry.address);
      }
    }
  }
  return found;
}

async function main() {
  const results = [];
  const push = (level, name, message) => results.push({ level, name, message });

  // 1. Docker + compose.
  const dockerVersion = await commandVersion("docker", ["--version"]);
  if (dockerVersion === null) {
    push("fail", "docker", "Docker not found. Install it: https://get.docker.com (then log out/in for the docker group).");
  } else {
    const major = Number(dockerVersion.match(/(\d+)\./)?.[1] ?? 0);
    push(
      major >= 24 ? "ok" : "warn",
      "docker",
      major >= 24
        ? `Docker present (${dockerVersion.split(",")[0]}).`
        : `Docker is old (${dockerVersion}); 24+ recommended — upgrade at https://get.docker.com.`,
    );
  }
  const composeVersion = await commandVersion("docker", ["compose", "version"]);
  if (composeVersion === null || !/v2/i.test(composeVersion)) {
    push("fail", "compose", "Docker Compose v2 not found (`docker compose version` failed). Install the compose plugin.");
  } else {
    push("ok", "compose", `Compose present (${composeVersion.split(",")[0]}).`);
  }

  // 2. Ports.
  for (const port of TCP_PORTS) {
    const state = await tcpPortFree(port);
    if (state === "free") {
      push("ok", `tcp/${port}`, `TCP port ${port} is free.`);
    } else if (state === "occupied") {
      push("fail", `tcp/${port}`, `TCP port ${port} is already in use. Stop the other service or remap ports in docker-compose.yml.`);
    } else {
      push("warn", `tcp/${port}`, `Could not probe TCP port ${port} (no permission?). Make sure nothing else listens there.`);
    }
  }
  for (const port of UDP_PORTS) {
    const state = await udpPortFree(port);
    if (state === "free") {
      push("ok", `udp/${port}`, `UDP port ${port} is free.`);
    } else if (state === "occupied") {
      push("fail", `udp/${port}`, `UDP port ${port} is already in use. Stop the other service or remap ports in docker-compose.yml.`);
    } else {
      push("warn", `udp/${port}`, `Could not probe UDP port ${port}. Make sure nothing else listens there.`);
    }
  }

  // 3. .env secrets.
  const envPath = path.join(ROOT, ".env");
  let env = null;
  if (!existsSync(envPath)) {
    push("fail", ".env", "Missing .env. Run `make init` first.");
  } else {
    env = parseEnv(readFileSync(envPath, "utf8"));
    const checks = [
      ["POSTGRES_PASSWORD", PLACEHOLDERS.postgresPassword, 8],
      ["JWT_ACCESS_SECRET", PLACEHOLDERS.jwtSecret, 32],
      ["LIVEKIT_API_SECRET", PLACEHOLDERS.livekitSecret, 16],
    ];
    for (const [key, placeholder, minLength] of checks) {
      const value = env[key] ?? "";
      if (value.length === 0) {
        push("fail", `.env:${key}`, `${key} is empty. Re-run \`make init --force\` or set it manually.`);
      } else if (value === placeholder) {
        push("fail", `.env:${key}`, `${key} still holds the example placeholder. Re-run \`make init --force\`.`);
      } else if (value.length < minLength) {
        push("fail", `.env:${key}`, `${key} is too short (min ${minLength} chars). Re-run \`make init --force\`.`);
      } else {
        push("ok", `.env:${key}`, `${key} looks generated.`);
      }
    }
  }

  // 4. livekit.yaml key match.
  const livekitPath = path.join(ROOT, "livekit.yaml");
  if (!existsSync(livekitPath)) {
    push("fail", "livekit.yaml", "Missing livekit.yaml. Run `make init` first.");
  } else if (env !== null) {
    try {
      const parsed = parseLivekitKeys(readFileSync(livekitPath, "utf8"));
      if (parsed.key !== env["LIVEKIT_API_KEY"]) {
        push("fail", "livekit-keys", "API key mismatch: livekit.yaml keys: does not match .env LIVEKIT_API_KEY. Re-run `make init --force`.");
      } else if (parsed.secret !== env["LIVEKIT_API_SECRET"]) {
        push("fail", "livekit-keys", "API secret mismatch between livekit.yaml and .env LIVEKIT_API_SECRET (webhooks would fail). Re-run `make init --force`.");
      } else if (parsed.apiKey !== parsed.key) {
        push("fail", "livekit-keys", "webhook api_key does not match the keys: entry in livekit.yaml. Re-run `make init --force`.");
      } else {
        push("ok", "livekit-keys", "LiveKit keys match between .env and livekit.yaml.");
      }
    } catch (err) {
      push("fail", "livekit-keys", `Could not parse livekit.yaml: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 5. DNS sanity (warning only).
  const domain = env?.["CADDY_DOMAIN"] ?? "localhost";
  if (domain === "localhost") {
    push("ok", "dns", "CADDY_DOMAIN=localhost: no public DNS needed (dev mode).");
  } else {
    try {
      const records = await dns.lookup(domain, { all: true });
      const addresses = records.map((entry) => entry.address);
      const local = localAddresses();
      if (addresses.some((address) => local.has(address))) {
        push("ok", "dns", `${domain} resolves to this machine (${addresses.join(", ")}).`);
      } else {
        push(
          "warn",
          "dns",
          `${domain} resolves to ${addresses.join(", ")}, none of this machine's public IPs (${[...local].join(", ") || "none detected"}). If that address is not this VPS, fix the A record — Caddy cannot issue certificates otherwise.`,
        );
      }
    } catch {
      push("warn", "dns", `${domain} does not resolve yet. Create the A record pointing at this VPS, then re-run doctor.`);
    }
  }

  // 6. Disk space.
  try {
    const stats = fs.statfsSync(ROOT);
    const freeBytes = stats.bfree * stats.bsize;
    const freeGb = freeBytes / 1024 ** 3;
    if (freeBytes < MIN_DISK_BYTES) {
      push("warn", "disk", `Only ${freeGb.toFixed(1)} GB free (want 5+ GB for images, DB and uploads). Free space or add a volume.`);
    } else {
      push("ok", "disk", `${freeGb.toFixed(0)} GB free.`);
    }
  } catch {
    push("warn", "disk", "Could not determine free disk space on this platform. Ensure 5+ GB are free.");
  }

  let failed = 0;
  let warned = 0;
  for (const result of results) {
    const tag = result.level === "ok" ? "OK  " : result.level === "warn" ? "WARN" : "FAIL";
    if (result.level === "fail") {
      failed += 1;
    } else if (result.level === "warn") {
      warned += 1;
    }
    console.log(`[${tag}] ${result.name}: ${result.message}`);
  }
  console.log(`\n${results.length - failed - warned} ok, ${warned} warnings, ${failed} failures.`);
  if (failed > 0) {
    console.log("Fix the FAILs above, then re-run `make doctor`.");
    process.exitCode = 1;
  } else {
    console.log("Ready: run `make up`.");
  }
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
