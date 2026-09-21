# AGENTS.md — instructions for AI agents continuing this repo

> Single source of truth for how to work in this monorepo.
> Update this file after EVERY phase. Keep it short but complete.
> Language rule: talk to the user in Russian; code, comments, commits and
> docs in English.

## 1. Project summary

- `vitality`: self-hosted Discord-like communication platform.
  Friends/community instance (2–50 users, up to 15 per voice room, one
  small VPS on Ubuntu).
- Prod domain (planned, DNS/IP pending): `vitality.kirskiy.shop`. Until DNS
  is ready, dev/prod-smoke runs on localhost (Caddy HTTPS / HTTP localhost).
- Decisions confirmed: registration `invite-only` (default), LiveKit media
  `UDP mux 7882`, monorepo goes into a new clean directory (current
  `Default Project` workdir is polluted with unrelated files).
- One `docker compose up` starts everything: Caddy (HTTPS) + server
  (Fastify REST + WS) + web (static React) + Postgres 16 + LiveKit SFU
  (voice/video/screenshare, built-in TURN).
- Full plan: `docs/ARCHITECTURE.md` (read it first). Deferred items:
  `docs/ROADMAP.md`. Manual voice test checklist: `docs/MANUAL_TESTS.md`
  (from Phase 4).
- Current phase: **Phase 2.5 — DONE (verified locally; integration +
  compose smoke need VPS/CI)**. Next: Phase 3 text chat (starts only after
  user says "continue").
- Repo root moved to `vitality/` (clean dir; parent `Default Project` holds
  unrelated files). All paths below are relative to `vitality/`.
- Local toolchain (this Windows machine): Node 24.19 + pnpm 9.15.0 via
  `%APPDATA%\npm` (`pnpm.cmd`; `*.ps1` shims blocked by ExecutionPolicy).
  Docker images pin `node:22-alpine` per the fixed stack.
- Pinned 2026-09-21 (see `pnpm-lock.yaml`): fastify 5, @fastify/* (cors 11,
  helmet 13, rate-limit 11), zod v4, drizzle-orm 0.45 / drizzle-kit 0.31,
  postgres-js 3, pino 10, TS 5.9 (NOT TS 7: typescript-eslint caps at <6.1),
  React 18.3 (spec), Vite 8 + plugin-react 6, Tailwind 4, vitest 5,
  eslint 10 + typescript-eslint 8, tsx 4, livekit-server v1.13,
  postgres:16-alpine, caddy:2-alpine.

## 2. Fixed tech stack (do not substitute without asking)

- pnpm workspaces monorepo: `apps/server`, `apps/web`, `apps/desktop`
  (Phase 6 only), `packages/shared`.
- Server: Node.js 22, TypeScript strict, Fastify, `@fastify/websocket`,
  PostgreSQL 16, Drizzle ORM + migrations, zod, argon2, access JWT +
  rotating refresh token, pino, rate limiting, helmet, CORS.
- Web: React 18, Vite, TypeScript strict, Zustand, TanStack Query, Tailwind,
  Radix UI, lucide-react, Inter.
- Desktop (Phase 6): Electron only (no Tauri — inconsistent
  getDisplayMedia in system webviews).
- Voice/video: self-hosted LiveKit SFU only. Backend `livekit-server-sdk`,
  web `livekit-client`. No custom SFU, no full-mesh.
- Proxy: Caddy with automatic HTTPS. Uploads: local Docker volume behind a
  storage interface (S3/MinIO later).

## 3. Repo layout (target)

```text
AGENTS.md  README.md  .env.example  Makefile
Caddyfile  livekit.example.yaml
docker-compose.yml  docker-compose.dev.yml
pnpm-workspace.yaml  package.json
docs/ARCHITECTURE.md  docs/ROADMAP.md  docs/MANUAL_TESTS.md
packages/shared/src/{events.ts,schemas.ts,constants.ts}
apps/server/src/{index.ts,env.ts,db/,modules/*/,ws/,plugins/,lib/}
apps/web/src/{api/,ws/,store/,voice/,audio/,components/,styles/}
apps/desktop/ (Phase 6)
```

## 4. Conventions (mandatory)

- Strict TypeScript, no `any` (use `unknown` + narrowing). Files ~300 lines
  max where reasonable. Small conventional commits
  (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`).
- Never invent library APIs. Check installed package types/README or official
  docs first (especially LiveKit, Fastify, Drizzle, Radix).
- No placeholder MVP implementations. Deferred work → `docs/ROADMAP.md`.
- Secrets via env only. `.env.example` with fake values. Never commit secrets
  or log them (pino redaction).
- Original branding only: no Discord name/logo/icons/sounds/text. Dark
  neutral palette is fine; accent via CSS variable.
- Working rules: phase by phase. After each phase: build, lint, tests,
  `docker compose up` smoke test → report (RU) → STOP until "continue".

## 5. Commands (Phase 1 scaffolds these; keep updated)

```bash
make dev      # compose.dev (postgres+livekit) + host server/web
make up       # full docker compose up
make logs     # compose logs
make migrate  # run Drizzle migrations
pnpm lint / pnpm typecheck / pnpm test        # per workspace + root
```

CI (Phase 1): lint + typecheck + unit/integration tests on every push.

## 6. Architecture cheat-sheet (details in docs/ARCHITECTURE.md)

- REST base `/api/v1`; single WS `/ws` with versioned envelope
  `{ v, seq, type, data, at }`, `WS_PROTOCOL_VERSION = 1` in
  `packages/shared`. WS auth is a single-use ticket
  (`POST /api/v1/ws-ticket` → `/ws?ticket=`, 30s TTL, session-bound);
  access JWT carries `sub`+`sid`. Reconnect: backoff + snapshot refetch.
  Typing throttled 1/3s per socket+channel; inbound frames capped 64 KiB.
- Data model: users, refresh_tokens, servers, roles (owner/admin/member +
  flags), members, channel_categories, channels (text|voice), messages
  (ULID id), attachments, invites, read_states. First user = owner. Seed:
  `Text/#general` + `Voice/General`.
- Voice: one LiveKit room per voice channel (`voice-<channelId>` sketch).
  Token endpoint checks permissions then `AccessToken` + `addGrant` +
  `toJwt()`. Webhooks (`application/webhook+json`, raw body,
  `WebhookReceiver.receive`) drive authoritative `voice.state` fan-out.
- Ports: 80/443 (Caddy), 7881/tcp ICE, 7882/udp media mux, 3478/udp
  TURN, 5349/tcp TURN/TLS (443 if no LB), 50000–60000/udp only in
  port-range mode. `use_external_ip: true` in prod; host networking for
  LiveKit on Linux preferred.
- Noise: Off / Standard (gUM constraints) / Enhanced (RNNoise WASM
  AudioWorklet via `@sapphi-red/web-noise-suppressor`, MIT — re-verify at
  Phase 5; stale-release risk tracked).

## 7. Phase log

- [x] Phase 0 — Plan only. Wrote `docs/ARCHITECTURE.md` + this file. No code.
- [x] Phase 1 — Skeleton + infra. Monorepo `vitality/`, shared WS v1
  contract (zod), server skeleton (env/migrations/health) + migration
  `0000` (`schema_meta`), web status page, compose + Caddy + LiveKit
  template, CI. Verified: `pnpm install/typecheck/lint/test` (16 unit
  tests green), `pnpm build`, compose YAML parse, livekit key audit,
  Makefile tabs, fail-fast boot without DB. See section 8 for what could
  NOT run locally.
- [x] Phase 2 — Auth + structure. argon2 + access JWT (15 min) + rotating
  refresh cookie (reuse detection revokes family); invite-only default,
  first user becomes owner with seeded server (`Text/#general`,
  `Voice/General`); roles owner/admin/member + flags; servers/categories/
  channels/invites/members/roles CRUD with permission checks; WS gateway
  (`/ws`, `server.ready`, presence, typing relay, heartbeat, backoff
  reconnect + snapshot refetch); `GET /servers/:id/state` snapshot;
  Discord-like shell (rail, collapsible sidebar, member list, user panel,
  settings with Account/Channels/Invites/Members). Migration `0001`
  (8 tables). Verified: typecheck/lint clean, 34 unit tests green,
  `pnpm build`, compose YAML parse. Integration tests (auth/team/
  channels/WS vs real Postgres) + `docker compose up` smoke still require
  CI/VPS (no local Docker/Postgres on this Windows box).
- [x] Phase 2.5 — Hardening. Git init + squashed baseline commit (git
  appeared only now; author vitalik@localhost). WS tickets replace
  `?token=`; `sid` session binding; pino redaction + Caddy ticket scrub;
  CI `compose-smoke` (`up -d --wait`, curl `-k` probes, logs on failure);
  `.nvmrc` (22) + `.gitattributes` (LF); livekit healthcheck REMOVED
  (busybox wget codes — would never go healthy); Caddy `/healthz`+`/readyz`
  handles. Adversarial review → 9 fixes (atomic invite redeem, kick-admin
  rule, state 404, typing throttle, maxPayload, tickets, argon2 pin) with
  regression tests; residuals in `docs/SECURITY_NOTES.md`.
- [ ] Phase 3 — Text chat.
- [ ] Phase 4 — Voice (LiveKit).
- [ ] Phase 5 — Screen share + noise suppression.
- [ ] Phase 6 — Electron polish + e2e + final docs.

## 8. Known issues / risks

- `@sapphi-red/web-noise-suppressor` last release ~2y ago — re-verify with
  current Vite in Phase 5; fallback = Standard + noise gate.
- NO local Docker on this Windows machine (Docker Desktop needs WSL2+reboot;
  skipped). Therefore `docker compose up` smoke test was NOT run here — it
  MUST be run on the Ubuntu VPS (`cp .env.example .env &&
  cp livekit.example.yaml livekit.yaml && make up`, then open
  `https://localhost`, accept the internal-CA warning). CI runs
  `docker compose config` + full image builds as a partial substitute.
- Server integration test (`test:integration`, real Postgres) runs in CI
  (postgres:16 service) and via `make test-integration`; plain `pnpm test`
  stays hermetic (test skips without DATABASE_URL).
- No `git` binary on this machine; no commits were made. Init repo + first
  conventional commit should happen on the dev machine/VPS.
- LiveKit `livekit.yaml` keys verified against upstream `config-sample.yaml`
  (master, Sep 2026): top-level `webhook:` (SINGULAR) with `api_key`+`urls`,
  top-level `log_level`, `rtc.udp_port` accepts a single port (we use 7882)
  or a small range — re-check against the pinned v1.13 image in Phase 4.
- `pnpm -r typecheck` requires shared `dist`: root `typecheck` script builds
  `@vitality/shared` first (documented workaround, keep it).
