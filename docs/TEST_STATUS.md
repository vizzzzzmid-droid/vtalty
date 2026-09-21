# TEST_STATUS.md — what is covered, how, and what only humans can do

Legend: ✅ automated & green in CI · 🧪 automated but experimental/flaky ·
🔍 manual only.

## Unit tests (`pnpm test`, hermetic, run everywhere)

| Area | File(s) | Notes |
|------|---------|-------|
| WS protocol contract | `packages/shared/tests/events.test.ts` | Envelope, version, event map, snapshot schema |
| Env validation | `apps/server/tests/unit/env.test.ts` | Defaults, required secrets, cookie flag parsing |
| Passwords / JWT | `password.test.ts`, `jwt.test.ts` | argon2 round-trip, sub+sid claims, expiry |
| Invite codes | `invite-code.test.ts` | Format, uniqueness sample |
| Presence hub | `hub.test.ts` | Fan-out isolation, prune, online/offline |
| Log redaction | `redact.test.ts` | Secrets never reach logs |
| CSP | `csp.test.ts` | Pins `wasm-unsafe-eval` for RNNoise |
| Upload magic bytes | `magic.test.ts` | PNG/JPEG/GIF/WebP/PDF/ZIP/MP4; SVG/HTML rejected |
| Rate limiter / mentions | `chat-utils.test.ts` | Window reset, key isolation, @parse |
| Storage paths | `storage.test.ts` | Round-trip, traversal refusal |
| Voice store/grants | `voice.test.ts` | Join/evict/mute-lock, grants per role, diff |
| HTTP client | `apps/web/tests/http.test.ts` | Bearer send, 401→refresh→retry |
| Formatting/membership | `format.test.ts`, `membership.test.ts` | Initials, role access |
| Markdown/XSS | `markdown.test.tsx` | Render + sanitization + mention contexts |
| Voice stores | `voice.test.ts` (web) | Toggles, quality dots, no-token persist |

## Integration tests (real Postgres in CI + `make test-integration`)

| Area | File | Notes |
|------|------|-------|
| Auth flow | `tests/integration/auth.test.ts` | First-user owner+seed, invite gate, login, rotation, reuse kill, logout, concurrent single-use redeem |
| Team | `team.test.ts` | Invites, promotions, kick rules, owner protection, server CRUD, role flags, state-404 oracle |
| Channels | `channels.test.ts` | CRUD perms, non-empty guard |
| WS gateway | `ws.test.ts` | Ticket handshake, presence, typing relay + throttle, oversized frames |
| Messages | `messages.test.ts` | Pagination edges, perms, edit/delete rules, mentions, read/unread, fan-out isolation |
| Uploads | `uploads.test.ts` | Magic validation, 413/415, claim-once, serve perms, orphan purge |
| Voice | `voice.test.ts` | Token grants/TTL, webhook presence, flags, eviction, max cap, reconcile |
| Voice moderation | `voice-moderation.test.ts` | Server-mute lock, perms, 502s, disconnect, kick/channel hooks, isolation |
| Screen share | `voice-share.test.ts` | Screen grants, sharer cap + freeze, stop-share, share loss, kick cleanup, replay safety |
| Settings | `settings.test.ts` | Defaults, merge, bounds validation |

## Scripts (`node --test`, zero-dep)

`scripts/init.test.mjs` — secret generation, env/yaml templating, parsers.

## Playwright e2e

| Suite | Job | Status |
|-------|-----|--------|
| Chat (register → channel → send → edit → delete → upload) + a11y (axe serious/critical on login/shell/settings) | `e2e` (API + web + Chromium, no LiveKit) | ✅ required |
| Voice (2 users + lurker: join, presence, mute/deafen icons, leave) + screen share (badge → watch → video → stop) + noise-mode switch | `e2e-voice` (adds LiveKit service + fake media flags) | 🧪 experimental (`continue-on-error`) — ICE/media in CI runners was never debugged locally |

## Compose / infra (CI)

- `compose` job: `docker compose config` (all three files) + full image builds. ✅
- `stack-smoke` job (BLOCKING): `scripts/smoke-stack.mjs` drives the
  production compose stack (+ localhost-only `:7880` overlay) through the
  public `https://localhost` entrypoint: register/login/seed state, WS
  handshake, message send/read-back, PNG upload/download (validates the
  non-root read-only server + volume perms), voice-token, Caddy `/livekit`
  path probe, real LiveKit join+publish via `@livekit/rtc-node` with
  presence asserted in snapshot AND `voice.state`, leave-removal,
  `make backup` → volume destroy → `make restore` → survival,
  server restart → reconcile resurrection + no ghosts, CSP-header
  assertion. Dumps `ps` + service logs on failure. ✅
- Production-build asset check: both worklet files + both RNNoise WASMs present in `dist/assets` (catches `?url`-inlining regressions). ✅

## Manual only (🔍 `docs/MANUAL_TESTS.md`)

Real audio/video quality, echo, device switching on hardware, PTT feel,
reconnect on real networks, TURN-behind-NAT across networks, multi-sharer
load, Enhanced mode on weak laptops, kick-disconnect timing, first-run on
Ubuntu + WSL2. (Backup/restore and restart-reconcile are ALSO covered
automatically by `stack-smoke`; ghost healing after container restarts is
covered there too.)
