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
- Current phase: **Phase 6b — DONE (all 3 steps committed) + Windows
  AppUserModelID/metadata fix + post-6b bugfixes (tray disappearance,
  aggressive re-auth)**. Desktop workflow green on main (NSIS + AppImage,
  Electron smoke in CI, installer contents inspected); the AUMID fix declares
  the explicit AUMID = `appId` before any UI and aligns
  productName/executableName; the tray fix ships `assets/` via
  `extraResources` + a `trayReady` hide-gate; the refresh fix adds a 15 s
  rotation-grace window server-side and single-flight/classified refresh
  client-side (details in §7, manual checks in docs/MANUAL_TESTS.md).
  `ci` + `desktop` both GREEN on main (runs 35976612008/35976612056,
  2026-09-24) after the post-6b screen-share viewing fix (§7, commit
  c557a5b): stream tiles are now 16:9 grid cards with a custom in-app
  fullscreen overlay (native Fullscreen API removed), and the silent
  screen-share audio root cause is fixed (visually-hidden audio element
  instead of `display:none` + suspended upmix AudioContext resume +
  gesture unlock). Follow-up fix (3c55680): audio played LEFT-EAR-ONLY in one ear - a ChannelMergerNode maps input N to output channel N and bare `connect(merger)` fed input 0 (left) only; both upmix sites (screen.ts, chain.ts) now feed BOTH inputs, stereo sources keep L/R via ChannelSplitter, and chain.ts's dead mono detection (`gain.channelCount === 1` is never true) now reads the track's `getSettings().channelCount`; all TEMP-DEBUG(screen-audio) logging removed. Follow-up feature (8bc23b1): per-user + per-stream volume BOOST to 400% - native element.volume/LiveKit setVolume cap at 100%, so past 100% elements are rerouted through a WebAudio GainNode (boost.ts, lazy: <=100% stays native). That boost was inaudible in production and is FIXED in fc7cf5a: createMediaElementSource returns silence for srcObject MediaStreams (measured, see §7), so the boost now taps the stream via createMediaStreamSource -> GainNode -> MediaStreamDestination -> element.srcObject. Follow-up fix (1d75b16): the slider could still go dead in production - a boost node armed while the AudioContext was suspended was never swapped in (every later slider move wrote an orphaned GainNode while the element kept playing its original stream), Chromium drops a WebRTC stream once nothing consumes it (the graph's own MediaStreamSourceNode does not count), and a re-attached srcObject silently detached the gain; boost.ts now self-heals on every apply (statechange flush + resume retry + drift re-tap), keeps native element.volume carrying <=100% until the swap happens (a <=100% request on a never-activated node releases the graph entirely), and attaches a muted keeper element feeding the original stream while boosted (see §7). STOP after reporting, wait for "continue".
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
  sharer cap 3, custom fullscreen overlay (native API removed), per-stream
  volume + quality.

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
  detail/motion, system-audio note), opt-in StreamTile (custom fullscreen
  overlay, quality selector, per-stream volume, degraded hint, LIVE badges), RNNoise
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
- [x] Phase 6b — Electron desktop app. Skeleton, connect screen, security
  shell, web picker UI, tray/single-instance, mention notifications with
  click-to-channel, PTT rebind + configurable mute shortcut, CJS/esbuild
  module layout, Playwright-Electron smoke (5 tests, green locally AND in
  CI under xvfb), adversarial review D1–D6 fixed, 51 desktop + 32 web unit
  tests. Desktop CI green: NSIS + AppImage built, installer inspected
  (asar contents + unpacked win32 .node confirmed). Docs: desktop README,
  MANUAL_TESTS desktop rows, SECURITY_NOTES desktop section, ROADMAP
  pruned. CI repairs along the way (caddy digest, X11/xorg-dev, shared
  build, compose env, migrate secret, vite host, executableName, AppImage
  metadata, dist.mjs `--` strip, uploads chown). Residual red in `ci`
  workflow is pre-existing server/web breakage (see §8).
- [x] Phase 6b fix — Windows AppUserModelID / packaging metadata. The app never
  declared an explicit AUMID, so Electron's fallback won:
  `electron.app.<product_name>` read from the exe version resource
  (`shell/common/application_info_win.cc` → `GetRawAppUserModelID`), i.e.
  `electron.app.Electron` for unpackaged runs — never equal to the
  `shop.kirskiy.vitality` that electron-builder's NSIS stamps on the shortcuts
  (`installer.nsh` → `WinShell::SetLnkAUMI ${APP_ID}`). Windows resolves
  taskbar/Task Manager identity per AppUserModelID, so the processes/windows did
  not belong to the app's own shortcuts (flat, ungrouped entries). Fix:
  `app.setAppUserModelId(APP_ID)` at module top level before any UI (MS:
  "during an application's initial startup routine before the application
  presents any UI"); new `src/identity.ts` (APP_ID = appId, PRODUCT_NAME);
  `productName: vitality` added to `package.json` (app.getName()/userData no
  longer the scoped `@vitality/desktop`); `executableName` changed
  `vitality-desktop` → `vitality` so the exe InternalName matches
  ProductName/FileDescription (`winPackager.js` derives InternalName from the
  exe basename). Tests: `tests/metadata.test.ts` (7 tests: appId↔APP_ID,
  productName↔productName↔PRODUCT_NAME, exe name, shortcutName,
  author/description/copyright/version sources, AUMID wired in main) plus an
  `app.getName()`/userData assertion in the Playwright-Electron smoke (now 6).
  Verified locally: lint/tsc clean, 58 unit tests green, smoke 6/6 on real
  Windows Electron, `pnpm build`. NOT verified locally: NSIS packaging
  (`@electron/rebuild` needs MSVC, absent on this box) and the Task Manager
  visual — manual rows added to `docs/MANUAL_TESTS.md`; the CI desktop rebuild
  is the packaging check.
- [x] Post-6b bugfix — tray disappearance (Windows) + aggressive re-auth.
  **1. Minimize lost the app entirely.** Root cause (verified against the
  installed electron-builder source): the `files:` allowlist in
  `electron-builder.yml` never shipped `assets/` (positive user patterns
  replace electron-builder's default `**/*`, see `fileMatcher.js:117-125`), so
  `nativeImage.createFromPath(<asar>/assets/icon.png)` produced an empty image,
  `setupTray()` returned early and no tray icon existed — while `minimize`/
  `close` still hid the window (`minimizeToTray` defaults to true): no window,
  no taskbar entry, no tray. Fix: ship the icon via `extraResources` (real file
  at `<resources>/assets/icon.png`, outside the asar), embedded fallback PNG,
  `shouldHideToTray(setting, trayReady)` gate so the window is never hidden
  without a tray (all in new `src/tray.ts`, pure/unit-tested), and
  `tray.destroy()` on `before-quit`. Tray API usage checked against the
  installed `electron.d.ts` (`Tray` ctor/`setImage`/`setToolTip`/
  `setContextMenu`/`destroy`).
  **2. Sessions killed during active use.** Three converging defects (the old
  accepted risk A5 now reported as a real bug): (a) `refresh()` treated reuse
  of a just-rotated cookie as theft and **revoked the whole family**, so the
  parallel-401 burst that follows every 900 s access-TTL expiry (backgrounded
  resume, long-idle WS reconnect + settings sync) logged active users out;
  (b) the web client ran one refresh per 401 with no coalescing; (c) ANY
  refresh failure — including network blips and 5xx — called `applyGuest()`.
  Fix: server grace window `REFRESH_REUSE_GRACE_MS = 15_000` (reuse tolerated
  only while the family still has a live token; outside the window or drained
  → family still revoked as before), client `api/refresh.ts` with
  single-flight + failure classification (only explicit 401/403 ends the
  session). Tests: server `tests/integration/auth.test.ts` rewritten (rotation,
  grace reuse keeps family alive, theft outside grace via SQL-aged
  `revoked_at`, two concurrent same-cookie refreshes) — 9/9 auth and full
  integration 56/56 green locally on PG 17; web `tests/refresh.test.ts`
  (16 cases: classification, malformed bodies, network/5xx keep-session,
  single-flight collapse); desktop `tests/tray.test.ts` (11 cases incl. the
  yml `extraResources` guard). Verified locally: web 54 + desktop 69 + server
  50 unit, all lint/typecheck clean, Electron smoke 6/6, `pnpm build`.
  NOT verified locally: the visual tray icon and >15 min session survival on a
  packaged Windows build (manual rows added to `docs/MANUAL_TESTS.md`); CI
  rebuild + artifact inspection is the packaging check.
- [x] Post-6b bugfix — screen-share viewing UX + silent stream audio
  (commit c557a5b). **1. Native fullscreen replaced.** `requestFullscreen()`
  showed generic OS/browser chrome and misbehaved in the Electron shell;
  StreamTile now opens a custom in-app overlay (React portal to
  `document.body`, `fixed inset-0 z-50 bg-black`, video `object-contain`),
  top bar with avatar/name/LIVE/volume + always-visible close, Esc to exit,
  body scroll-lock; a second `<video>` is attached while the overlay is open
  (tile keeps playing). Theater mode removed (superseded by the overlay).
  **2. Tiles are a 16:9 grid** (`MainView`:
  `grid-cols-[repeat(auto-fill,minmax(320px,1fr))]`): placeholder card
  (avatar, LIVE, "Watch stream") before subscribing; watching card with
  hover chrome (fullscreen button top-right, sharer-name gradient bottom)
  and a footer (LIVE, name, Degraded, quality select, volume, stop);
  `--surface-2`/`--accent-strong` theme tokens; `sharerAvatarUrl` prop.
  **3. Silent audio root cause** (static analysis; no live LiveKit on this
  box): (a) the tile `<audio>` was `className="hidden"` = `display:none`,
  which Chromium suspends (same caveat documented in `remoteAudio.ts`) —
  now visually-hidden (`absolute h-px w-px opacity-0`); (b) the shared
  upmix `AudioContext` created without a user gesture stays `suspended`,
  so `play()` resolved into silence — now `resume()`d on attach, stream
  audio elements self-unlock on the first pointerdown/keydown (voice uses
  the autoplay banner; tiles are excluded from it), and `play()` is retried
  while paused. All `[TEMP-DEBUG]` logging removed. Tests
  (`tests/screen.test.ts`): pin no-`requestFullscreen`/`exitFullscreen`,
  overlay portal + close control, audio element not `display:none`.
  Verified locally: typecheck/lint clean, web 62/62 unit, `vite build`;
  CI `ci` + `desktop` green (runs 35976612008/35976612056). Live two-client
  audio/overlay check stays manual (docs/MANUAL_TESTS.md).
- [x] Post-6b bugfix - stream/mic audio LEFT-EAR-ONLY (commit 3c55680).
  TEMP-DEBUG(screen-audio) instrumentation (dfc91e1) proved playback healthy
  (AudioContext `running`, srcObject set, unlock gestures firing, `play()`
  resolved) - the remaining defect was stereo CENTERING. Root cause: a
  ChannelMergerNode maps input N to output channel N, and both upmix sites
  used a bare `connect(merger)`, landing the source on input 0 (left) only:
  (a) `screen.ts upmixToStereo` - mono sources now feed BOTH inputs
  (`connect(merger, 0, 0)` + `connect(merger, 0, 1)`), and genuine stereo
  sources keep L/R via ChannelSplitter(2) -> merger 0->0/1->1 (a bare merger
  input would down-mix stereo to mono); (b) `chain.ts buildMicChain` - same
  dual-input fix, plus its mono DETECTION was dead code
  (`gain.channelCount === 1` is never true: GainNode channelCount defaults
  to 2 with mode "max"), so mono is now detected from the mic track
  `getSettings().channelCount` (enhanced mode is always mono via RNNoise).
  All TEMP-DEBUG(screen-audio) logging removed (screen.ts, StreamTile.tsx).
  Regression tests (tests/screen.test.ts, source-level): dual-input wiring
  in both files, splitter wiring, no bare `connect(merger);` statement, no
  GainNode.channelCount mono check, no TEMP-DEBUG leftovers. Verified
  locally: typecheck/lint clean, web 67 unit green, `vite build`; CI `ci` +
  `desktop` green (runs 35981495885/35981495849). Live two-ear check stays
  manual (docs/MANUAL_TESTS.md: centred mic + centred stream audio rows).
- [x] Post-6b feature - per-user/stream volume BOOST to 400% (commit 8bc23b1).
  HTMLMediaElement.volume and LiveKit participant.setVolume cap at 1.0, so
  boosting a quiet speaker/stream needs WebAudio: boost.ts lazily reroutes
  an element through createMediaElementSource -> GainNode(0..MAX_VOLUME=4)
  -> destination the FIRST time >100% is requested (<=100% stays on native
  element.volume - no AudioContext, no autoplay risk; a MediaElementSource
  cannot be reverted, so boosted elements stay gain-controlled with
  element.volume=1). Shared boost AudioContext resumes on pointerdown/
  keydown (same unlock pattern as the screen upmix context). Voice:
  remoteAudio.setRemoteAudioVolume(identity, v) replaces all
  participant.setVolume calls in room.ts (attach, applyUserVolume,
  applyAllVolumes); releaseElementVolume on detach/disconnect/teardown.
  Streams: screen.ts tracks tile audio elements per sharer identity
  (streamAudioElements map), applies the stored volume on attach and in
  setStreamVolume. UI: participant + stream sliders max 400 (percent shown
  in the participant menu). Regression tests (tests/boost.test.ts):
  clampVolume bounds, MAX_VOLUME=4, boost wiring pins in room/screen/
  remoteAudio, slider max pins. Verified locally: typecheck/lint clean,
  web unit green, `vite build`. Live loudness/distortion check stays manual
  (docs/MANUAL_TESTS.md volume-boost row).
- [x] Post-6b fix - the 400% volume BOOST was inaudible (commit fc7cf5a).
  Live debugging with temporary `[vol-debug]` logs (commits 378b6b2/fc37770)
  proved the wiring was fine: applyUserVolume -> setRemoteAudioVolume -> the
  hidden element carrying the matching `dataset.identity`, with boost gain
  nodes created while `ctx.state` was "running" - yet the sound never changed,
  while a manual `element.volume = 0` in DevTools still muted. Root cause was
  measured in a real Chromium (apps/desktop/scripts/audio-boost-probe.mjs:
  fake mic + RTCPeerConnection loopback + analyser peaks):
  `createMediaElementSource(element)` returns SILENCE (peak 0.00) when the
  element's srcObject is a MediaStream - every remote LiveKit track and every
  stream tile fed from the upmix destination - while the element keeps playing
  directly, so the 8bc23b1 gain node moved no audible samples at all. Fix
  (boost.ts): tap the MediaStream instead -
  `createMediaStreamSource(element.srcObject)` -> GainNode(0..MAX_VOLUME) ->
  MediaStreamAudioDestinationNode -> `element.srcObject` - deferring the swap
  until the context runs (a suspended context would hand the element a silent
  stream) and keeping the element as the final renderer so its sinkId (output
  device) and autoplay state stay intact; <=100% keeps the native
  element.volume path. The probe confirms the shipped path end-to-end through
  `element.captureStream()`: gain 1 -> 1.00, gain 2 -> 2.00, gain 0 -> 0.00
  (true mute), 11/11 PASS; run it via
  `pnpm --filter @vitality/desktop probe:audio-boost` (needs the system Edge
  channel + fake devices, so it is deliberately not part of CI). Tests: the
  boost wiring pin now forbids the element-source API and the new
  fake-AudioContext test in tests/volume-wiring.test.ts asserts the graph
  routing and the srcObject swap (web 77/77); lint/test/build/`-r typecheck`
  green locally. All TEMP `[vol-debug]` logging removed. Live loudness/mute
  check stays manual (docs/MANUAL_TESTS.md volume-boost row).
- [x] Post-6b fix - the volume slider stayed dead for listeners (commit
  1d75b16). Report: audio plays but dragging the per-user slider (0..100%)
  changes nothing. Reproduced against real Chromium/Edge 153 (headed AND
  headless, default autoplay policies, constant-tone WebRTC loopback so the
  fake-mic beep timing could not skew analyser peaks) - three ways the
  fc7cf5a path ends up half-wired: (1) a boost created while the
  AudioContext is suspended armed the gain but never swapped the element,
  and every later slider move wrote into an orphaned GainNode while the
  element kept playing its original stream at 100%; (2) Chromium stops
  delivering a WebRTC remote stream once NOTHING consumes it - the boost
  graph's own MediaStreamSourceNode does NOT count - so after the swap the
  graph input, the graph output and the element all went silent (measured:
  no consumer -> peak 0, second consumer -> peak 1); (3) a re-attached
  srcObject (LiveKit re-subscribe / stream-tile cleanup) silently detached
  the gain. Fix (boost.ts): every apply runs syncBoost, which re-taps a
  replaced stream and swaps the element back (drift), defers the swap with a
  `statechange` flush + resume retry when the context is suspended while
  native element.volume keeps carrying <=100%, and releases the graph
  entirely on a <=100% request to a never-activated node so the slider always
  moves the real volume; while a boost is active a muted hidden keeper
  element keeps the original stream fed. Probe gained a keeper phase
  (no-consumer peak 0 -> keeper 1/2/0), 14/14 PASS via
  `pnpm --filter @vitality/desktop probe:audio-boost`; new wiring pins in
  tests/boost.test.ts (web 78/78); lint/test/build/`-r typecheck` green.
  Live slider check stays manual (docs/MANUAL_TESTS.md volume-boost row).
## 8. Known issues / risks

- `@sapphi-red/web-noise-suppressor` 0.4.1 (MIT) verified with the Vite 8
  build (worklet + wasm ship in dist, asserted in CI); needs 48 kHz +
  AudioWorklet + WASM, otherwise auto-falls back to Standard with notice.
- Desktop packaging cannot be built on this Windows box:
  `pnpm --filter @vitality/desktop dist` stops in `@electron/rebuild` for
  `uiohook-napi` ("Could not find any Visual Studio installation to use"), so
  the NSIS installer, the exe version resource and the AppImage are CI-only
  (windows-latest/ubuntu-latest have the toolchains). Do not read a local
  `dist` failure as a config error.
- `executableName` must stay a plain file-safe name: the AppImage target
  validates `executableName`/`productFilename` with
  `validateCriticalPathString` (letters, digits, hyphens, underscores, dots,
  spaces) and rejects the scoped workspace name `@vitality/desktop` — that is
  what forced `executableName` in the first place (commit eda6710). It is now
  `vitality`, i.e. equal to `productName`.
- The Windows AppUserModelID can only be observed for the *current* process
  (`GetCurrentProcessExplicitAppUserModelID`); `GetApplicationUserModelId`
  (appmodel.h) reports `APPMODEL_ERROR_NO_APPLICATION` for every non-MSIX
  process (the docs' own sample prints "Desktop application" for it), so it is
  useless for verifying the shell AUMID. The Task Manager grouping check stays
  manual (docs/MANUAL_TESTS.md) on a machine with the packaged app installed.
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
- `ci` + `desktop` workflows GREEN on main (runs 35976612008/35976612056,
  2026-09-24, latest: 1d75b16 self-healing slider fix + 447742b docs,
  2026-09-25 runs 36142518415/36142518474; earlier 2026-09-25
  d7f5e2c/fc7cf5a runs 36135508994/36135508920 and 36135452908/36135452709):
  lint-typecheck-unit-build, integration (51/51), compose, e2e (3/3),
  stack-smoke full pass incl. native RTC join/publish/presence,
  backup/restore and restart-reconcile, NSIS + AppImage + Electron smoke.
  `e2e-voice` (experimental, continue-on-error) still red — real
  media/ICE in headless CI; MANUAL_TESTS.md stays the bar for voice.
- Local Postgres 17 installed on this Windows box (winget
  PostgreSQL.PostgreSQL.17, service postgresql-x64-17, db `vitality` /
  user `vitality` password `vitality`); integration + e2e now reproducible
  here. Local Chromium also installed (playwright). No Docker (needs
  WSL2+reboot) — compose/smoke still CI-only.
- Past incident, fixed: `docker compose down -v` hung 23 min in CI;
  smoke teardown now uses `--timeout 30` + explicit `process.exit`.
- Attachment downloads use short-lived HMAC-signed capability URLs
  (commit 9e77199, 2026-09-22): browsers cannot send an Authorization
  header on plain `<img src>`/`<a href>` loads, so the previously
  Bearer-only `GET /api/v1/attachments/:id` 401'd in the web client.
  Message/upload payloads now embed `?e=<exp>&s=<hmac>` URLs
  (`ATTACHMENT_URL_TTL_SECONDS`, default 3600; key derived from
  `JWT_ACCESS_SECRET`, so rotation kills outstanding URLs). Minting stays
  member-gated (history/broadcasts/upload response); the Bearer path keeps
  per-user checks (kicked members keep working URLs only until expiry —
  documented tradeoff). Tests: `tests/unit/signed-urls.test.ts` +
  two integration cases in `uploads.test.ts`.
- `tests/integration/voice.test.ts:360` (voice.state.update WS broadcast,
  fixed 800 ms wait) flaked once in CI (run 35725467497 attempt 1,
  2026-09-22); passed on rerun and locally. If it recurs, replace the
  fixed sleep with a poll-with-deadline assertion.
- Screen-share self-echo, fixed: the sharer heard their OWN screen audio
  because nothing compared the tile identity against the local participant
  (LiveKit never auto-subscribes a publisher, so any explicit watch/attach on
  the local identity is our bug). Guards: `isSelfIdentity()` in
  `apps/web/src/voice/screen.ts` short-circuits `watchStream`,
  `unwatchStream`, `attachStreamVideo` and `attachStreamAudio`; `StreamTile`
  takes `isSelf` (auto-detected via `isSelfIdentity`) and renders
  "You are sharing" with no Watch button; `MainView` now takes `myUserId`;
  `room.ts` `TrackSubscribed` bails on `participant.isLocal`. This also
  explains any "I hear my own system audio twice / echo" complaints, and the
  duplicate-subscription bandwidth cost. Regression test:
  `apps/web/tests/screen-self-echo.test.tsx` (9 cases: self audio never
  attached, watch/unwatch are no-ops, remote sharer still works, UI + wiring).
