#!/usr/bin/env node
// Full-stack smoke proof: drives the PRODUCTION compose stack through its
// public HTTPS entrypoint (plus localhost-only :7880 for the native RTC
// client, via docker-compose.smoke.yml). Covers register/login/state,
// WS handshake, messaging, uploads (non-root server + read-only fs +
// volume perms), voice-token, the Caddy /livekit path, a real LiveKit
// join+publish with presence asserted via snapshot AND voice.state,
// backup/restore survival, and post-restart reconcile.
//
// Needs: .env + livekit.yaml (make init), docker + compose.
// CI-only localhost TLS: NODE_TLS_REJECT_UNAUTHORIZED=0 and ws
// rejectUnauthorized:false (the Caddy cert is internal-CA signed).
//
// Usage: node scripts/smoke-stack.mjs [--domain localhost] [--keep]
// Exit 0 all green; 1 with "SMOKE FAIL: <step>" after dumping diagnostics.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from "@livekit/rtc-node";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE = ["compose", "-f", "docker-compose.yml", "-f", "docker-compose.smoke.yml"];

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

class SmokeError extends Error {
  constructor(step, message) {
    super(`[${step}] ${message}`);
    this.step = step;
  }
}

function sh(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", cwd: ROOT, ...options });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function compose(...args) {
  return sh("docker", [...COMPOSE, ...args]);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor({ timeoutMs, intervalMs = 2000, describe, check }) {
  const deadline = Date.now() + timeoutMs;
  let last = "not ready yet";
  for (;;) {
    try {
      const value = await check();
      if (value !== null && value !== undefined && value !== false) {
        return value;
      }
      last = "condition false";
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${describe} (last: ${last})`);
    }
    await sleep(intervalMs);
  }
}

function dumpDiagnostics() {
  console.log("--- docker compose ps ---");
  console.log(compose("ps").stdout);
  for (const service of ["server", "livekit", "caddy", "postgres", "web"]) {
    console.log(`--- logs ${service} (tail 120) ---`);
    console.log(compose("logs", "--tail=120", "--no-log-prefix", service).stdout);
  }
}

export function parseArgs(argv) {
  return {
    domain: arg("--domain", "localhost"),
    keep: argv.includes("--keep"),
  };
}

async function main() {
  const { domain, keep } = parseArgs(process.argv.slice(2));
  const base = `https://${domain}`;
  const wsBase = `wss://${domain}`;
  const directLk = "ws://127.0.0.1:7880";
  if (!existsSync(path.join(ROOT, ".env")) || !existsSync(path.join(ROOT, "livekit.yaml"))) {
    throw new SmokeError("preflight", "missing .env/livekit.yaml — run `make init` first");
  }

  const step = async (name, fn) => {
    process.stdout.write(`[step] ${name} ... `);
    try {
      const result = await fn();
      console.log("PASS");
      return result;
    } catch (err) {
      console.log("FAIL");
      throw err instanceof SmokeError ? err : new SmokeError(name, err instanceof Error ? err.message : String(err));
    }
  };

  const api = async (method, urlPath, { token, body, form } = {}) => {
    const headers = {};
    if (token !== undefined) {
      headers["authorization"] = `Bearer ${token}`;
    }
    let payload;
    if (form !== undefined) {
      payload = form;
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const response = await fetch(`${base}${urlPath}`, { method, headers, body: payload });
    const text = await response.text();
    let json = null;
    try {
      json = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json, text, headers: response.headers };
  };

  const expectStatus = (res, want, what) => {
    if (res.status !== want) {
      throw new Error(`${what}: want HTTP ${want}, got ${res.status} (${res.text.slice(0, 200)})`);
    }
    return res.json;
  };

  const teardown = () => {
    if (keep) {
      return;
    }
    console.log("[cleanup] docker compose down -v");
    compose("down", "-v");
  };

  try {
    await step("fresh stack up", async () => {
      let out = compose("down", "-v");
      if (out.status !== 0) {
        throw new Error(`down failed: ${out.stderr.slice(0, 300)}`);
      }
      out = compose("up", "-d", "--wait", "--wait-timeout", "300");
      if (out.status !== 0) {
        throw new Error(`up --wait failed:\n${out.stdout.slice(-2000)}\n${out.stderr.slice(-2000)}`);
      }
    });

    await step("public HTTPS entrypoint + CSP header", async () => {
      const healthz = await fetch(`${base}/healthz`);
      if (healthz.status !== 200) {
        throw new Error(`GET /healthz: HTTP ${healthz.status}`);
      }
      const apiHealth = await fetch(`${base}/api/v1/health`);
      if (apiHealth.status !== 200) {
        throw new Error(`GET /api/v1/health: HTTP ${apiHealth.status}`);
      }
      const root = await fetch(`${base}/`, { method: "HEAD" });
      const csp = root.headers.get("content-security-policy") ?? "";
      if (!csp.includes("wasm-unsafe-eval")) {
        throw new Error(`CSP header missing wasm-unsafe-eval: ${csp.slice(0, 160)}`);
      }
    });

    const { userId, token, serverId, textId, voiceId } = await step("register + login + seed state", async () => {
      const reg = await api("POST", "/api/v1/auth/register", {
        body: { username: "smokeowner", password: "smoke-password-123" },
      });
      const regBody = expectStatus(reg, 201, "register first user");
      const userId = regBody.user.id;
      const login = await api("POST", "/api/v1/auth/login", {
        body: { username: "smokeowner", password: "smoke-password-123" },
      });
      const token = expectStatus(login, 200, "login").accessToken;
      const servers = expectStatus(await api("GET", "/api/v1/servers", { token }), 200, "servers");
      if (servers.length !== 1) {
        throw new Error(`expected 1 server, got ${servers.length}`);
      }
      const state = expectStatus(
        await api("GET", `/api/v1/servers/${servers[0].id}/state`, { token }),
        200,
        "state",
      );
      const text = state.channels.find((entry) => entry.name === "general" && entry.type === "text");
      const voice = state.channels.find((entry) => entry.name === "General" && entry.type === "voice");
      if (text === undefined || voice === undefined) {
        throw new Error("seed channels missing from snapshot");
      }
      return { userId, token, serverId: servers[0].id, textId: text.id, voiceId: voice.id };
    });

    const wsEvents = [];
    let ws = null;
    await step("WS ticket + handshake + server.ready", async () => {
      const ticket = expectStatus(await api("POST", "/api/v1/ws-ticket", { token }), 200, "ws-ticket").ticket;
      ws = new WebSocket(`${wsBase}/ws?ticket=${encodeURIComponent(ticket)}`, {
        rejectUnauthorized: false,
      });
      const ready = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no server.ready in 15s")), 15000);
        ws.on("message", (data) => {
          try {
            const event = JSON.parse(data.toString());
            if (event.type === "voice.state") {
              wsEvents.push(event);
            }
            if (event.type === "server.ready") {
              clearTimeout(timer);
              resolve(event);
            }
          } catch {
            // Ignore non-JSON frames.
          }
        });
        ws.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      if (ready.data?.userId !== userId) {
        throw new Error("server.ready carried the wrong user");
      }
      ws.send(JSON.stringify({ type: "client.hello", lastSeq: null }));
    });

    const messageId = await step("send + read back a message", async () => {
      const sent = expectStatus(
        await api("POST", `/api/v1/channels/${textId}/messages`, {
          token,
          body: { content: "smoke hello" },
        }),
        201,
        "send",
      );
      const history = expectStatus(
        await api("GET", `/api/v1/channels/${textId}/messages?limit=10`, { token }),
        200,
        "history",
      );
      if (!history.messages.some((entry) => entry.id === sent.id && entry.content === "smoke hello")) {
        throw new Error("sent message missing from history");
      }
      return sent.id;
    });

    const attachmentId = await step("upload PNG + download identical bytes", async () => {
      const form = new FormData();
      form.append("file", new Blob([PNG_1X1], { type: "image/png" }), "smoke.png");
      const uploaded = expectStatus(
        await api("POST", `/api/v1/channels/${textId}/attachments`, { token, form }),
        200,
        "upload",
      );
      const attachment = uploaded[0];
      if (attachment?.mime !== "image/png") {
        throw new Error(`sniffed mime wrong: ${attachment?.mime}`);
      }
      const response = await fetch(`${base}/api/v1/attachments/${attachment.id}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.status !== 200) {
        throw new Error(`download: HTTP ${response.status}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.equals(PNG_1X1)) {
        throw new Error("downloaded bytes differ from upload (volume/perms issue?)");
      }
      if (response.headers.get("x-content-type-options") !== "nosniff") {
        throw new Error("missing nosniff header on download");
      }
      return attachment.id;
    });
    void attachmentId;

    const voiceToken = await step("voice-token for the voice channel", async () => {
      const body = expectStatus(
        await api("POST", `/api/v1/channels/${voiceId}/voice-token`, { token }),
        200,
        "voice-token",
      );
      if (typeof body.token !== "string" || typeof body.url !== "string") {
        throw new Error("voice-token shape wrong");
      }
      if (!body.url.startsWith("wss://")) {
        throw new Error(`public URL must be wss://, got ${body.url}`);
      }
      return body.token;
    });

    await step("Caddy /livekit path accepts the token (raw WS probe)", async () => {
      const probe = new WebSocket(
        `${wsBase}/livekit/rtc?access_token=${encodeURIComponent(voiceToken)}`,
        { rejectUnauthorized: false },
      );
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("no LiveKit frame in 15s — Caddy path or upgrade broken")), 15000);
          probe.on("message", () => {
            clearTimeout(timer);
            resolve(null);
          });
          probe.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
          probe.on("unexpected-response", (_req, res) => {
            clearTimeout(timer);
            reject(new Error(`unexpected HTTP ${res.statusCode} on /livekit/rtc`));
          });
        });
      } finally {
        probe.close();
      }
    });

    let room = null;
    await step("native RTC join + publish + presence (snapshot + voice.state)", async () => {
      room = new Room();
      await room.connect(directLk, voiceToken, { autoSubscribe: true, dynacast: true });
      const source = new AudioSource(16000, 1);
      const track = LocalAudioTrack.createAudioTrack("audio", source);
      const options = new TrackPublishOptions();
      options.source = TrackSource.SOURCE_MICROPHONE;
      await room.localParticipant.publishTrack(track, options);
      const frame = new Int16Array(320);
      for (let i = 0; i < frame.length; i += 1) {
        frame[i] = Math.floor(3000 * Math.sin((2 * Math.PI * 440 * i) / 16000));
      }
      await source.captureFrame(new AudioFrame(frame, 16000, 1, frame.length));
      await waitFor({
        timeoutMs: 30000,
        describe: "webhook-driven presence in snapshot",
        check: async () => {
          const state = expectStatus(
            await api("GET", `/api/v1/servers/${serverId}/state`, { token }),
            200,
            "state",
          );
          const entry = state.voice.find((item) => item.channelId === voiceId);
          return entry?.participants.some((p) => p.userId === userId) === true ? true : null;
        },
      });
      await waitFor({
        timeoutMs: 15000,
        describe: "voice.state over WS",
        check: () =>
          wsEvents.some(
            (event) =>
              event.data?.channelId === voiceId &&
              (event.data?.participants ?? []).some((p) => p.userId === userId),
          )
            ? true
            : null,
      });
    });

    await step("leave removes presence", async () => {
      await room.disconnect();
      room = null;
      await waitFor({
        timeoutMs: 20000,
        describe: "presence removal in snapshot",
        check: async () => {
          const state = expectStatus(
            await api("GET", `/api/v1/servers/${serverId}/state`, { token }),
            200,
            "state",
          );
          const entry = state.voice.find((item) => item.channelId === voiceId);
          return (entry?.participants.length ?? 0) === 0 ? true : null;
        },
      });
    });

    await step("backup, destroy, restore, survival", async () => {
      let out = sh("make", ["backup"], {});
      if (out.status !== 0) {
        throw new Error(`make backup failed: ${(out.stderr || out.stdout).slice(0, 500)}`);
      }
      const files = readdirSync(path.join(ROOT, "backups"));
      const sqlFile = files.filter((name) => name.endsWith(".sql")).sort().at(-1);
      const uploadsFile = files.filter((name) => name.endsWith(".tar.gz")).sort().at(-1);
      if (sqlFile === undefined || uploadsFile === undefined) {
        throw new Error("backup produced no files");
      }
      out = compose("down", "-v");
      if (out.status !== 0) {
        throw new Error("down -v failed");
      }
      out = compose("up", "-d", "--wait", "--wait-timeout", "300");
      if (out.status !== 0) {
        throw new Error(`re-up failed:\n${out.stdout.slice(-1500)}`);
      }
      out = sh("make", ["restore", `SQL=backups/${sqlFile}`, `UPLOADS=backups/${uploadsFile}`, "YES=1"], {});
      if (out.status !== 0) {
        throw new Error(`restore failed: ${(out.stderr || out.stdout).slice(-1500)}`);
      }
      const relogin = expectStatus(
        await api("POST", "/api/v1/auth/login", {
          body: { username: "smokeowner", password: "smoke-password-123" },
        }),
        200,
        "login after restore",
      );
      const history = expectStatus(
        await api("GET", `/api/v1/channels/${textId}/messages?limit=10`, {
          token: relogin.accessToken,
        }),
        200,
        "history after restore",
      );
      if (!history.messages.some((entry) => entry.id === messageId)) {
        throw new Error("smoke message did not survive restore");
      }
      const state = expectStatus(
        await api("GET", `/api/v1/servers/${serverId}/state`, { token: relogin.accessToken }),
        200,
        "state after restore",
      );
      if (!state.channels.some((entry) => entry.id === textId)) {
        throw new Error("channel did not survive restore");
      }
    });

    await step("server restart reconciles (no ghosts)", async () => {
      const relogin = expectStatus(
        await api("POST", "/api/v1/auth/login", {
          body: { username: "smokeowner", password: "smoke-password-123" },
        }),
        200,
        "login",
      );
      const freshToken = relogin.accessToken;
      const vt = expectStatus(
        await api("POST", `/api/v1/channels/${voiceId}/voice-token`, { token: freshToken }),
        200,
        "voice-token",
      ).token;
      const probe = new Room();
      await probe.connect(directLk, vt, { autoSubscribe: true, dynacast: true });
      await waitFor({
        timeoutMs: 30000,
        describe: "presence before restart",
        check: async () => {
          const state = expectStatus(
            await api("GET", `/api/v1/servers/${serverId}/state`, { token: freshToken }),
            200,
            "state",
          );
          const entry = state.voice.find((item) => item.channelId === voiceId);
          return (entry?.participants.length ?? 0) === 1 ? true : null;
        },
      });
      const restarted = compose("restart", "server");
      if (restarted.status !== 0) {
        await probe.disconnect().catch(() => undefined);
        throw new Error("server restart failed");
      }
      await waitFor({
        timeoutMs: 90000,
        describe: "readyz after restart",
        check: async () => {
          const res = await fetch(`${base}/readyz`);
          return res.status === 200 ? true : null;
        },
      });
      // Store was wiped with the container: startup reconcile must resurrect
      // the still-connected participant (member with connect).
      await waitFor({
        timeoutMs: 60000,
        describe: "reconciled presence after restart",
        check: async () => {
          const state = expectStatus(
            await api("GET", `/api/v1/servers/${serverId}/state`, { token: freshToken }),
            200,
            "state",
          );
          const entry = state.voice.find((item) => item.channelId === voiceId);
          const ids = (entry?.participants ?? []).map((p) => p.userId);
          return ids.length === 1 && ids[0] === userId ? true : null;
        },
      });
      await probe.disconnect().catch(() => undefined);
      await waitFor({
        timeoutMs: 30000,
        describe: "removal after leave",
        check: async () => {
          const state = expectStatus(
            await api("GET", `/api/v1/servers/${serverId}/state`, { token: freshToken }),
            200,
            "state",
          );
          const entry = state.voice.find((item) => item.channelId === voiceId);
          return (entry?.participants.length ?? 0) === 0 ? true : null;
        },
      });
    });

    console.log("\nSMOKE PASS: full stack proven through the public entrypoint.");
  } catch (err) {
    console.log(`\nSMOKE FAIL: ${err instanceof Error ? err.message : err}`);
    dumpDiagnostics();
    process.exitCode = 1;
    return;
  } finally {
    try {
      ws?.close();
    } catch {
      // Already closed.
    }
    teardown();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.log(`SMOKE FAIL: ${err instanceof Error ? err.message : err}`);
    dumpDiagnostics();
    process.exitCode = 1;
  });
}
