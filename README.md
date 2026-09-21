# vitality — self-hosted voice & text for friends

Phase 5: screen sharing (presets, opt-in watching, moderation) and noise
suppression (Off/Standard/RNNoise Enhanced + gate + loopback test) with
per-user Voice & Audio settings synced across devices. See `docs/VOICE.md`
for networking and `docs/FIRST_RUN.md` for the first-run checklist.

## Quick start (full stack)

Requirements: Docker + Docker Compose v2.

```bash
cp .env.example .env
cp livekit.example.yaml livekit.yaml
# Edit .env and livekit.yaml secrets (JWT_ACCESS_SECRET, LIVEKIT_API_SECRET, POSTGRES_PASSWORD)
make up
```

Open `https://localhost` (Caddy serves localhost over HTTPS with an internal
CA — accept the browser warning in dev). Health: `https://localhost/api/health`,
readiness: `https://localhost/api/ready` (proxied to the server).

Production (`vitality.kirskiy.shop`): point DNS at the VPS, set
`CADDY_DOMAIN=vitality.kirskiy.shop` in `.env`, ensure ports 80/443 are
reachable so Caddy can issue ACME certificates.

## First run (accounts and invites)

Registration is invite-only by default (`REGISTRATION_MODE` in `.env`):

1. Register the first user in the web UI — they become the server owner,
   no invite needed, and a seeded server (`Text/#general`, `Voice/General`)
   is created automatically.
2. As owner, open Settings → Invites → Create invite, and share the code.
3. Friends register with the invite code and land in the server as members.

Sessions use a short-lived access JWT (15 min) plus a rotating refresh
cookie; reused refresh tokens revoke the whole session family.

## Host development

```bash
cp .env.example .env
cp livekit.example.yaml livekit.yaml
make dev
pnpm install
# Terminal 1 (DATABASE_URL=postgres://vitality:<pw>@127.0.0.1:5432/vitality):
pnpm --filter @vitality/server dev
# Terminal 2:
pnpm --filter @vitality/web dev   # http://127.0.0.1:5173, /api proxied to :3000
```

## Ports and firewall

| Port(s)    | Proto  | Exposed to | Purpose                                |
|------------|--------|------------|----------------------------------------|
| 80         | TCP    | world      | ACME HTTP-01 + redirect to HTTPS       |
| 443        | TCP    | world      | HTTPS (app, API, WS, LiveKit signalling) |
| 443        | UDP    | world      | HTTP/3 (Caddy, optional)               |
| 7881       | TCP    | world      | WebRTC ICE over TCP (fallback)         |
| 7882       | UDP    | world      | WebRTC media (UDP mux, single port)    |
| 3478       | UDP    | world      | TURN/UDP (+STUN)                       |
| 5349       | TCP    | world      | TURN/TLS                               |
| 3000/7880/5432 | —  | never public (docker network only) | Internal services |

On Linux production hosts prefer `network_mode: host` for the `livekit`
service (better media performance); the default bridge mode works everywhere
including dev. `rtc.use_external_ip: true` is required in `livekit.yaml`
behind NAT/Docker.

## WebRTC troubleshooting (short version)

- Works on LAN/localhost but not via domain: check `use_external_ip`,
  firewall UDP 7882/3478, and that the site loads over valid HTTPS
  (microphone/screen capture require a secure context).
- Drops on corporate VPNs: traffic should fall back to ICE/TCP 7881, then
  TURN/TLS 5349 — keep both open. Debug with `chrome://webrtc-internals`
  and `docker compose logs livekit`.
- Full checklist: `docs/ARCHITECTURE.md` section 12.

## Repo layout

```text
apps/server      # Fastify REST + WS gateway (Phase 1: health/readiness + migrations)
apps/web         # React status page (Phase 1; Discord-like shell in Phase 2)
packages/shared  # zod schemas, versioned WS event types, constants
livekit.example.yaml / Caddyfile / docker-compose.yml / docker-compose.dev.yml
docs/ARCHITECTURE.md  docs/ROADMAP.md  docs/MANUAL_TESTS.md
```

## Backup / restore (summary)

- Database: `docker compose exec postgres pg_dump -U vitality vitality > backup.sql`
  (full pg_dump runbook lands in Phase 6 docs).
- Uploads volume: snapshot the `vitality-uploads` Docker volume alongside the dump.

## Docs

- `docs/ARCHITECTURE.md` — build contract for Phases 1–6.
- `docs/ROADMAP.md` — deferred / non-MVP items.
- `AGENTS.md` — conventions for continuing AI agents.
