// Zero-dependency tests for the init/doctor scripts.
// Run: node --test scripts/   (also wired as `pnpm test:scripts`)
import assert from "node:assert/strict";
import test from "node:test";
import { buildEnv, buildLivekitYaml, PLACEHOLDERS, randomKey, randomSecret } from "./init.mjs";
import { parseEnv, parseLivekitKeys } from "./preflight.mjs";

const ENV_EXAMPLE = [
  "POSTGRES_PASSWORD=dev-only-password-change-me",
  "JWT_ACCESS_SECRET=dev-access-secret-please-change-me-32plus-chars",
  "LIVEKIT_API_KEY=devkey",
  "LIVEKIT_API_SECRET=dev-livekit-secret-please-change-me-32plus",
  "LIVEKIT_PUBLIC_URL=wss://localhost/livekit",
  "CADDY_DOMAIN=localhost",
  "PUBLIC_APP_URL=https://localhost",
].join("\n");

const LIVEKIT_EXAMPLE = [
  "keys:",
  "  devkey: dev-livekit-secret-please-change-me-32plus",
  "webhook:",
  "  api_key: devkey",
  "  urls:",
  "    - http://server:3000/webhooks/livekit",
].join("\n");

const SECRETS = {
  postgresPassword: "aa".repeat(24),
  jwtSecret: "bb".repeat(32),
  livekitKey: "vk_0011223344556677",
  livekitSecret: "cc".repeat(32),
};

test("secrets look random and long enough", () => {
  assert.match(randomSecret(), /^[A-Za-z0-9_-]{60,}$/);
  assert.match(randomKey(), /^vk_[0-9a-f]{16}$/);
  assert.notEqual(randomSecret(), randomSecret());
});

test("buildEnv replaces every secret and the domain", () => {
  const out = buildEnv(ENV_EXAMPLE, SECRETS, "example.com");
  assert.ok(!out.includes(PLACEHOLDERS.postgresPassword));
  assert.ok(!out.includes(PLACEHOLDERS.jwtSecret));
  assert.ok(!out.includes(PLACEHOLDERS.livekitSecret));
  assert.ok(out.includes("CADDY_DOMAIN=example.com"));
  assert.ok(out.includes("PUBLIC_APP_URL=https://example.com"));
  assert.ok(out.includes("LIVEKIT_PUBLIC_URL=wss://example.com/livekit"));
  assert.ok(out.includes(`LIVEKIT_API_KEY=${SECRETS.livekitKey}`));
});

test("buildEnv fails loudly on edited examples", () => {
  assert.throws(() => buildEnv("POSTGRES_PASSWORD=x", SECRETS, "example.com"), /placeholder/);
});

test("buildLivekitYaml keeps keys in sync", () => {
  const out = buildLivekitYaml(LIVEKIT_EXAMPLE, SECRETS);
  assert.ok(out.includes(`  ${SECRETS.livekitKey}: ${SECRETS.livekitSecret}`));
  assert.ok(out.includes(`api_key: ${SECRETS.livekitKey}`));
  assert.ok(!out.includes("devkey"));
});

test("parseEnv reads KEY=VALUE with quotes and comments", () => {
  const parsed = parseEnv('# comment\nA=1\nB="two three"\nC=\'four\'\nEMPTY=\nNOEQUALS\n');
  assert.deepEqual(parsed, { A: "1", B: "two three", C: "four", EMPTY: "" });
});

test("parseLivekitKeys extracts key, secret and webhook api_key", () => {
  const out = buildLivekitYaml(LIVEKIT_EXAMPLE, SECRETS);
  assert.deepEqual(parseLivekitKeys(out), {
    apiKey: SECRETS.livekitKey,
    key: SECRETS.livekitKey,
    secret: SECRETS.livekitSecret,
  });
});

test("parseLivekitKeys fails loudly on garbage", () => {
  assert.throws(() => parseLivekitKeys("keys: {}\n"), /could not find/);
});
