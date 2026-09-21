# SECURITY_NOTES — attacker-model review (Phase 2.5)

Threat model: a friends/community instance (2–50 users) on one VPS. Attackers
are untrusted registered users and network observers; server admins and the
VPS host are trusted. This note records what was attacked, fixed, and what
is knowingly accepted.

## Token and secret handling (verified)

- Access JWT lives only in web memory (zustand store, never persisted).
  Verified: `localStorage` is used solely in `apps/web/src/store/ui.ts`
  for UI choices (selected server/channel, collapsed categories).
- Refresh token lives only in an HttpOnly cookie (`vitality_refresh`,
  `SameSite=Lax`, path `/api/v1/auth`, `Secure` in prod compose). The web
  client never reads its value (`document.cookie` unused).
- WS tickets are single-use, ~30s TTL, sha256-hashed at rest, bound to the
  user and their refresh family (logout/reuse-revocation kills them).
- Logs: pino redacts `authorization` headers, `ticket`/`token` query params,
  `password`/`inviteCode` bodies and `set-cookie` headers
  (`apps/server/src/lib/logger.ts`, covered by `tests/unit/redact.test.ts`).
  Caddy scrubs the `ticket` query param (`Caddyfile` log filter) and redacts
  Cookie/Authorization headers by default.

## Findings fixed in Phase 2.5 (with regression tests)

| # | Severity | Location | Finding | Fix |
|---|----------|----------|---------|-----|
| 1 | High | `apps/server/src/modules/invites/service.ts` (`consumeInvite`) | Invite `maxUses` enforced with read-modify-write: concurrent registrations over-redeem single-use invites. | Atomic conditional `UPDATE … WHERE usable RETURNING`; concurrent-redeem integration test (`tests/integration/auth.test.ts`). |
| 2 | Medium | `apps/server/src/modules/members/service.ts` (`kickMember`) | Any admin could kick another admin (only owner/strict rules were checked for role edits). | Only the owner may kick admins; test in `tests/integration/team.test.ts`. |
| 3 | Low | `apps/server/src/modules/servers/service.ts` (`getServerState`) | 403-for-non-members vs 404-for-missing gave a server-existence oracle. | Non-members get 404 either way; test in `tests/integration/team.test.ts`. |
| 4 | Medium | `apps/server/src/ws/gateway.ts` (typing relay) | No throttle: a client could trigger a broadcast storm to all server members. | 3s per-socket per-channel cooldown; test in `tests/integration/ws.test.ts`. |
| 5 | Low | `apps/server/src/ws/gateway.ts` (plugin options) | Unbounded inbound frames (ws default 100 MiB). | `maxPayload: 64 KiB`, oversized frames close with 1009; test in `tests/integration/ws.test.ts`. |
| 6 | Medium | `apps/server/src/ws/gateway.ts`, `Caddyfile` | Long-lived JWT in `/ws?token=` leaks into proxy/server logs. | One-time tickets (`POST /api/v1/ws-ticket`, ~30s TTL, session-bound); `?token=` removed; reuse/expiry/revocation tests. |
| 7 | Low | `apps/server/src/lib/password.ts` | argon2 parameters implicit (upgrade could silently weaken hashing). | Pinned `memoryCost: 65536, timeCost: 3, parallelism: 4` (argon2id). |
| 8 | Medium | `docker-compose.yml` (livekit healthcheck) | Probe relied on GNU wget exit code 8; busybox returns 1 for any HTTP error, so the service would never become healthy and `--wait` would hang. | Healthcheck removed with a documented reason; server deliberately does not gate on LiveKit at boot (Phase 4 adds a server-side `/readyz` check). |
| 9 | Low | `Caddyfile` | `/healthz` and `/readyz` fell through to the web static server, so smoke probes could not reach the API. | Explicit handles proxying both to `server:3000`. |

## Phase 5 screen-share / noise findings (adversarial review)

| # | Severity | Location | Finding | Fix |
|---|----------|----------|---------|-----|
| S1 | High | `apps/server/src/modules/voice/service.ts` (track_published) | Concurrent screen publishes could both slip under the sharer cap (check-then-act across awaits). | Per-channel promise mutex around the permission + limit check (`withChannelLock`); single-process assumption documented (matches the in-memory store). |
| S2 | Medium | same | Redelivered `track_published` for an already-flagged share re-ran the limit check and froze the victim's own live stream. | Replay short-circuit: already-sharing seats return unchanged without touching LiveKit. |
| S3 | Medium | `enforceServerVoiceAccess` | `stopUserShare` throwing (LiveKit down) aborted role updates after the DB commit. | Best-effort try/catch in enforce (matches `removeFromVoice`); flag stays honest, re-saving retries. |
| S4 | Info | token grants | A client without `share_screen` cannot publish screen tracks anyway: the SFU enforces `canPublishSources` server-side; our webhook additionally mutes + withholds the flag (tested). | Defense in depth, no change. |
| S5 | Info | viewers | Subscribing to another channel's streams needs that room's token (member-only mint) and presence comes only from member-only broadcasts. | No change. |
| S6 | Low | `Caddyfile` / helmet | WASM needs `wasm-unsafe-eval`; a missing directive fails closed (no audio processing, visible fallback) rather than open. | Policy set minimally on both layers, pinned by unit test + CI smoke header check + CI dist asset check. |
| S7 | Low | settings endpoint | Device ids persist server-side; they are local hardware selectors, not secrets, and are only applied when the device exists. | Documented in schema comment; no change. |

## Phase 4 voice findings (adversarial review)

| # | Severity | Location | Finding | Fix |
|---|----------|----------|---------|-----|
| V1 | Low | `apps/server/src/modules/voice/service.ts` (`moderateMute`) | `listParticipants` failures threw a raw 500 while track-mute failures mapped to 502 — inconsistent, and the 500 leaked nothing but hid the cause. | Central `publishedAudioSid` helper mapping all LiveKit outages to 502 `LIVEKIT_ERROR`. |
| V2 | Info | `apps/server/src/modules/voice/service.ts` (`mintVoiceToken`) | Channel existence is revealed by 404-vs-403 before the membership check. | Accepted: channel ids are unguessable UUIDs, consistent with the rest of the channels API. |
| V3 | Low | `apps/server/src/modules/voice/service.ts` (`mintVoiceToken`) | `VOICE_MAX_PARTICIPANTS` is check-then-act: a same-millisecond race can overfill by the race window (LiveKit rooms auto-create without caps). | Accepted for a friends instance; the cap is enforced again on every mint. |
| V4 | Low | `apps/server/src/modules/voice/service.ts` (`receiveWebhook`) | A replayed valid webhook body (requires the API secret or internal-network access — i.e. full compromise already) could resurrect a left participant until reconcile. Out-of-order redelivery converges the same way. | Accepted; handlers are idempotent and the 60s reconcile heals drift. |
| V5 | Info | `apps/server/src/modules/voice/service.ts` (track events) | Phase 4 tokens never grant screen-share publish (SFU-enforced), so `sharingScreen` cannot be set yet — the badge path is future-proofing for Phase 5. | No action. |
| V6 | Low | one-session eviction | If the force-drop `removeParticipant` fails (LiveKit down), the store says "left" while LiveKit still lists the user; reconcile re-adds them (membership-gated) until the client actually leaves. | Accepted degradation while LiveKit is down (voice is unusable then anyway). |
| V7 | Info | `Caddyfile`, `apps/web` | LiveKit `access_token` travels as an `/rtc` query param (verified in livekit-client source) and would land in access logs. | Caddy `format filter` now replaces both `ticket` and `access_token`; voice-token responses (JSON bodies) are never logged by pino. |

## Knowingly accepted (revisit if the threat model changes)

- **A1** Username enumeration via `USERNAME_TAKEN` on register (low; standard).
- **A2** `GET /users/:id` visible to any authenticated user (low; UUIDs are
  unguessable; needed for member UI).
- **A3** No per-connection rate limit on WS handshakes beyond frame caps
  (low at this scale; the box sits behind Caddy on a private VPS).
- **A4** Category-delete emptiness check is not atomic with the delete
  (low; worst case is an FK error, never silent corruption).
- **A5** Parallel refresh requests race: only the first rotation wins, the
  losers must log in again (low; documented in `apps/web/src/api/http.ts`).
- **A6** Caddy log filter, admin `:2019` healthcheck and localhost HTTPS are
  unverified on this dev machine (no Docker); covered by the CI
  `compose-smoke` job and must be re-verified on the Ubuntu VPS.
- **A7** `COOKIE_SECURE=false` in `.env.example` is intentional for host-run
  HTTP dev; production compose forces `true`.
- **A8** CORS reflects origins for host dev (`Vite :5173 → server :3000`);
  production is same-origin through Caddy and the server port is never
  published. Add an explicit allowlist before exposing `:3000` directly.
- **A9** Expired WS tickets are cleaned opportunistically on mint; the table
  stays tiny at a 30s TTL. Add a scheduled purge if it ever grows.
- **A10** No account lockout beyond per-route rate limits (10/min auth,
  30/min refresh/ticket); acceptable for an invite-only friends instance.
