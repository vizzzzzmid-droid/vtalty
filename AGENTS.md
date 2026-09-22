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
- Current phase: **Phase 6b step 2 — DONE (picker UI + tray polish +
  mention notifications)**. Steps 1–2 committed; step 3 (PTT wiring in web
  is done via onPttKey/onToggleMute; remaining: packaging proof, CI run,
  full adversarial review) pending. STOP after reporting, wait for
  "continue".
- Repo root moved to `vitality/` (clean dir; parent `Default Project` holds
  unrelated files). All paths below are relative to `vitality/`.
- Local toolchain (this Windows machine): Node 24.19 + pnpm 9.15.0 via
  `%APPDATA%\npm` (`pnpm.cmd`; `*.ps1` shims blocked by ExecutionPolicy).
  Docker images pin `node:22-alpine` per the fixed stack.
- Pinned 2026-09-21 (see `pnpm-lock.yaml`): fastify 5, @fastify/* (cors 11,
  helmet 13, rate-limit 11), zod v4, drizzle-orm 0.45 / drizzle-kit 0.31,
  postgres-js 3, pino 10, TS 5.9 (NOT TS 7: typescript-eslint caps at <6.1),
  React 18.3 (spec), Vite 8 + plugin-react 6, Tailwind 4, vitest 5,
  eslint 10 + typescript-eslint 8, tsx 4, livekit-server-sdk 2.19.1,
  livekit-client 2.22.3, @sapphi-red/web-noise-suppressor 0.4.1,
  livekit-server v1.13,
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
docs/VOICE.md  docs/FIRST_RUN.md  docs/ADMIN.md  docs/TEST_STATUS.md
docs/SECURITY_NOTES.md  scripts/{init,preflight,backup,restore}.mjs
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
- Voice (Phase 4 DONE): room = channel id, token endpoint checks
  permissions then `AccessToken` + mic-only/`canPublishSources` grants +
  `toJwt()` (TTL 600s). Webhooks (`application/webhook+json`, raw body,
  `WebhookReceiver.receive`) drive the authoritative in-memory store with
  startup/periodic reconcile; `voice.state` fan-out fills the snapshot.
  Client: livekit-client via Caddy `/livekit` path route.
- Chat (Phase 3 DONE): ULID ids, cursor pagination, soft delete, mentions
  table, read_states + `/unread`, magic-bytes uploads on local volume,
  markdown via react-markdown+remark-gfm with safeUrl allowlist.
- `pnpm test` / `typecheck` build `@vitality/shared` first (web tests and
  all typechecks consume shared `dist`; keeps CI order-independent).
- Ports: 80/443 (Caddy), 7881/tcp ICE, 7882/udp media mux, 3478/udp
  TURN, 5349/tcp TURN/TLS (443 if no LB), 50000–60000/udp only in
  port-range mode. `use_external_ip: true` in prod; host networking for
  LiveKit on Linux preferred.
- Noise (Phase 5 DONE): Off / Standard (gUM constraints) / Enhanced
  (RNNoise WASM AudioWorklet via `@sapphi-red/web-noise-suppressor` 0.4.1
  MIT, 48 kHz, lazy WASM, fallback to Standard). Screen: opt-in tiles,
  sharer cap 3, theater/fullscreen, per-stream volume + quality.

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
- [x] Phase 3 — Text chat. ULID messages + cursor pagination
  (before/after/around, limit+1 hasMore), send/edit/delete with
  send_messages + author/admin rules, soft delete, per-user 30/min send and
  upload limiters, @mentions (server table + unread mention counts),
  read_states + per-server unread endpoint, message.* WS fan-out with
  precise TanStack cache patching, uploads (magic-bytes allowlist,
  random keys, local volume driver, inline images vs attachment, nosniff),
  sanitizing markdown pipeline (react-markdown + remark-gfm, no raw HTML,
  safeUrl allowlist, mention highlight), chat UI (anchored infinite scroll,
  bottom-only autoscroll, new-messages divider, typing bar, mention
  autocomplete, upload chips, edit/delete, unread/mention badges),
  Playwright e2e + CI `e2e` job. Migration `0003` (messages, attachments,
  message_mentions, read_states). Verified: typecheck/lint clean,
  58 unit tests green, `pnpm build`, YAML/Caddyfile checks.
- [x] Phase 4 — Voice (LiveKit). Server: `POST voice-token` (connect perm,
  mic-only or listen-only grants, TTL 600s, max 15, rate-limited,
  one-session eviction), `/webhooks/livekit` (raw-body signature verify,
  idempotent join/leave/track/room handlers), in-memory voice store +
  startup/periodic reconcile (membership-gated), `voice.state.update` intent
  (participants only, 1s throttle, server-mute enforced), moderation
  (server-mute via `mutePublishedTrack`, disconnect via `removeParticipant`),
  eviction on kick/leave/channel-delete/role-change/server-delete. Web:
  livekit-client room manager (adaptiveStream/dynacast, processed-mic
  processor chain ready for RNNoise, per-user volume, deafen via
  unsubscribe, PTT, device pickers, mic-test meter, generated UI sounds,
  reconnect/autoplay banners, human errors, unload cleanup), sidebar
  participants with speaking ring + volume/moderation menu, user panel with
  mute/deafen/quality/disconnect, Voice & Audio settings tab. Infra/docs:
  Caddy `/livekit` path route (client appends `/rtc`, verified in source)
  + `access_token` scrub, `livekit.yaml` webhook URL + TURN/host-networking
  notes, `docs/VOICE.md`, `docs/MANUAL_TESTS.md`, `docs/FIRST_RUN.md`.
  Tests: 8 voice unit + voice/moderation integration (fake LiveKitAdmin,
  signed webhooks), experimental CI `e2e-voice` (continue-on-error, fake
  media, 2-user + lurker scenario). Verified locally: typecheck/lint
  clean, 69 unit tests green, `pnpm build`. Live media, integration, e2e
  and compose smoke require CI/VPS.
- [x] Phase 5 — Screen share + noise suppression. Server: screen grants only
  with `share_screen` (SFU-enforced + webhook double-check), sharer cap
  `VOICE_MAX_SHARERS=3` (per-channel mutex, excess frozen), stop-share
  moderation, share cleanup on kick/role-loss/channel-delete, settings
  endpoint `GET/PUT users/me/voice-settings` (migration `0004`), CSP
  `wasm-unsafe-eval` (helmet merge + Caddy SPA header, pinned by test + CI
  checks). Web: share dialog (presets 720p30/1080p30/1080p60/source,
  detail/motion, system-audio note), opt-in StreamTile (theater, fullscreen,
  quality selector, per-stream volume, degraded hint, LIVE badges), RNNoise
  Enhanced (48 kHz check, lazy WASM, live switching with fallback notice),
  gate + loopback test, server-synced settings. Tests: screen grants/limit/
  stop-share/replay integration, settings validation, screen + noise-mode
  e2e (experimental job), MANUAL_TESTS Phase 5 rows. Docs: VOICE bandwidth
  table, ARCHITECTURE §8/§9, SECURITY_NOTES Phase 5, ROADMAP prune,
  FIRST_RUN unchanged. Verified locally: typecheck/lint clean, unit tests
  green, `pnpm build` (+ dist wasm/worklet listing), YAML/Caddyfile checks.
  Live media, integration, e2e and compose smoke require CI/VPS.
- [x] Phase 6a.5 — Full-stack CI proof. `scripts/smoke-stack.mjs` + blocking
  CI `stack-smoke`: register/login/seed, WS handshake, chat, PNG
  up/download (non-root read-only server + volume perms), voice-token,
  Caddy `/livekit` path probe, real `@livekit/rtc-node` join+publish with
  presence in snapshot AND `voice.state`, leave-removal, backup → destroy →
  restore survival, restart reconcile resurrection (replaces the old
  curl-only `compose-smoke`). `docker-compose.smoke.yml` overlay
  (localhost-only `:7880`). Verified locally: `node --check`, dependency
  versions, API shapes against installed packages — never executed
  (no Docker on this box); CI is the first run.
- [x] Phase 6a — First-run friction, polish, hardening, ops docs. `make
  init`/`make doctor` (zero-dep Node scripts, flags/prompts, 0600 secrets,
  tested via node:test + executed locally); `make backup`/`make restore`
  (pg_dump + volume archive, confirm-gated, cron doc). Bundle 1167→475 KB
  initial (settings/markdown/livekit-client/suppressor code-split; gzip
  330→144 KB). Orphan-upload purge job + test. Mentions in all markdown
  contexts + XSS tests. A11y (AA palette: accent-strong fills, muted
  lightened, LIVE red darkened — all computed; reduced-motion; voice
  live-region; focus trap via Radix), axe e2e gate, toasts, offline banner,
  loading/error/retry states, dialog errors, Ctrl+K switcher. Docker:
  digest pins (fetched), no-new-privileges, read-only server/web + tmpfs,
  json log rotation, healthchecks kept. `pnpm audit` gate (fixed ws HIGHs),
  dependency-review, Renovate. Final review: 0600 secrets/backups,
  announcer-first-load, non-member state 404 already covered. Docs:
  ADMIN.md, README rewrite, TEST_STATUS.md, FIRST_RUN init/doctor,
  VOICE bandwidth, SECURITY_NOTES S1–S7. Verified locally: typecheck/lint
  clean, 76 unit + 7 script tests green, `pnpm build`, YAML/Caddyfile
  checks, init+doctor executed, contrast computed. Docker/CI-only jobs
  (integration, e2e, smoke) still need CI/VPS.
- [ ] Phase 6b — Electron desktop app (steps 1–2 done, committed: skeleton,
  connect screen, security shell, web picker UI via `window.desktop`,
  tray/single-instance/minimize-to-tray/start-minimized, mention
  notifications with click-to-channel, `notificationsEnabled` setting,
  39 desktop + 32 web unit tests, desktop.yml CI, README Download section,
  MANUAL_TESTS desktop rows, ROADMAP Desktop section;
  verified locally: desktop+web lint/typecheck/tests green, `tsc` builds +
  asset copy green. NOT verified locally: Electron runtime launch (GUI),
  `dist` packaging, CI run — need CI/VPS. Step 3 pending: packaging proof,
  full adversarial review with fixes+tests).

## 8. Known issues / risks

- `@sapphi-red/web-noise-suppressor` 0.4.1 (MIT) verified with the Vite 8
  build (worklet + wasm ship in dist, asserted in CI); needs 48 kHz +
  AudioWorklet + WASM, otherwise auto-falls back to Standard with notice.
- NO local Docker on this Windows machine (Docker Desktop needs WSL2+reboot;
  skipped). Therefore `docker compose up` smoke test was NOT run here — it
  MUST be run on the Ubuntu VPS (`cp .env.example .env &&
  cp livekit.example.yaml livekit.yaml && make up`, then open
  `https://localhost`, accept the internal-CA warning). CI runs
  `docker compose config` + full image builds as a partial substitute.
- Server integration tests (`test:integration`, real Postgres) and the
  Playwright e2e suite run in CI (postgres:16 service; e2e boots the built
  API + Vite dev + Chromium) and via `make test-integration` /
  `make test-e2e`; plain `pnpm test` stays hermetic.
  `docker compose up` smoke runs in CI (`compose-smoke`) and must additionally
  pass once on the Ubuntu VPS.
- No `git` binary on this machine; no commits were made. Init repo + first
  conventional commit should happen on the dev machine/VPS.
- LiveKit `livekit.yaml` keys verified against upstream `config-sample.yaml`
  (master, Sep 2026): top-level `webhook:` (SINGULAR) with `api_key`+`urls`,
  top-level `log_level`, `rtc.udp_port` accepts a single port (we use 7882)
  or a small range — re-check against the pinned v1.13 image in Phase 4.
- `pnpm -r typecheck` requires shared `dist`: root `typecheck` script builds
  `@vitality/shared` first (documented workaround, keep it).
- Web bundle is ~600 KB (radix + markdown); code-splitting deferred.
- Unclaimed uploads (chips removed before send) stay orphaned; cleanup cron
  deferred to ROADMAP.
- Mentions highlight only top-level paragraph text (not inside code/bold).
- No local Docker/live media on this Windows box: voice/screen
  integration tests, the `e2e-voice` job (now also screen + noise-mode
  specs) and compose smoke run in CI; real two-device audio/video is
  covered by `docs/MANUAL_TESTS.md`. The CI `e2e-voice` job is
  `continue-on-error` (experimental) until it proves green.
