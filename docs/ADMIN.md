# ADMIN.md — operating vitality in production

Audience: the person running the VPS. For the very first run, start with
`docs/FIRST_RUN.md`; come back here for reference.

## Environment variable reference

All values live in `.env` (created by `make init`; never commit it).
`UPLOAD_CLEANUP_*` and the `VOICE_*` tunables fall back to compiled
defaults when unset.

| Name | Default | Meaning |
|------|---------|---------|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `vitality` / *(random)* / `vitality` | Database credentials. `DATABASE_URL` is composed from them in compose. |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | API listen address inside the container. |
| `JWT_ACCESS_SECRET` | *(random, 64 chars)* | HMAC secret for access JWTs (min 32 chars). Rotating it logs everyone out. |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` | Access token lifetime (15 min). |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | Refresh family lifetime. |
| `COOKIE_SECURE` | `false` (compose forces `true`) | `Secure` flag on the refresh cookie. Must be `true` behind HTTPS. |
| `REGISTRATION_MODE` | `invite-only` | `invite-only` or `open`. First user always becomes owner. |
| `LIVEKIT_URL` | `http://livekit:7880` | Internal LiveKit API URL (server → SFU, docker network). |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | *(random)* | Must match `keys:` in `livekit.yaml` (checked by `make doctor`). |
| `LIVEKIT_PUBLIC_URL` | `wss://localhost/livekit` | Signalling URL handed to browsers. Prod: `wss://<domain>/livekit`. |
| `VOICE_MAX_PARTICIPANTS` | `15` | Token-time cap per voice channel. |
| `VOICE_MAX_SHARERS` | `3` | Simultaneous screen shares per channel (excess frozen). |
| `VOICE_RECONCILE_INTERVAL_SECONDS` | `60` | Presence heal loop period. |
| `UPLOAD_DIR` | `/data/uploads` | Upload volume mount (do not change without moving the volume). |
| `UPLOAD_MAX_BYTES` | `10485760` | Per-file upload cap (10 MiB). |
| `UPLOAD_CLEANUP_MAX_AGE_HOURS` | `24` | Orphaned (unclaimed) uploads older than this are purged. |
| `UPLOAD_CLEANUP_INTERVAL_SECONDS` | `3600` | Purge loop period. |
| `STORAGE_DRIVER` | `local` | Only `local` exists (S3 is a ROADMAP item). |
| `CADDY_DOMAIN` | `localhost` | Public domain; drives ACME issuance. |
| `PUBLIC_APP_URL` | `https://localhost` | Informational canonical URL. |
| `LOG_LEVEL` | `info` | pino level (`debug` for troubleshooting). |

## Sizing guide (one small VPS)

Baseline (chat + idle voice): 1 vCPU / 1 GB RAM is comfortable; Postgres
and the SFU idle near zero. Voice audio is Opus (~32 kbps/person) —
negligible. What costs money is **screen sharing**: the SFU forwards every
viewer their own copy (see `docs/VOICE.md` for the table). Rule of thumb:

- 1080p30 share × 3 viewers ≈ 6 Mbps sustained upstream.
- 1080p60 share × 10 viewers ≈ 30 Mbps sustained upstream.

Traffic-cap warning: 30 Mbit/s for one hour ≈ **13.5 GB** of transfer
(30 ÷ 8 × 3600 ÷ 1000). A 1 TB/month VPS cap evaporates in ~3 days of
that load. Keep the default 1080p30 preset, `VOICE_MAX_SHARERS=3`, and
viewer opt-in; downscale presets before upsizing the VPS.

CPU: RNNoise Enhanced mode runs per-speaker in browsers (not on the VPS),
so server CPU scales with rooms and API traffic, not with suppression.

## Upgrade procedure

1. `git pull` and read the release notes (breaking env/migration notes).
2. `make doctor` — catches secret/keys/DNS drift.
3. `make backup` — always before upgrading.
4. `make up` (rebuilds images; Drizzle migrations run automatically).
5. `curl -f https://<domain>/readyz` and spot-check login + voice.
6. Rollback: `git checkout <previous-tag> && make up`, then
   `make restore SQL=... UPLOADS=...` only if migrations changed data
   shapes (check the notes — restores wipe newer data).

## Backup and restore

- `make backup` → `backups/vitality-<ts>.sql` (0600, contains password
  hashes — treat as secret) + `backups/uploads-<ts>.tar.gz`.
- `make restore SQL=... UPLOADS=...` — DESTRUCTIVE (drops the schema and
  the uploads volume first); add `YES=1` only in automation.
- Cron example (daily 03:00, keep 7 days):
  ```cron
  0 3 * * * cd /opt/vitality && make backup >/var/log/vitality-backup.log 2>&1 && find backups -mtime +7 -delete
  ```
- Restore test procedure (quarterly): spin a scratch VPS (or second
  compose project), `make init`, copy one backup pair over, `make up`,
  `make restore`, verify login + one channel history + one attachment.

## Running behind an existing reverse proxy

The bundled Caddy can be replaced. Whatever terminates TLS must:

- Proxy `/api/*`, `/ws*` (WebSocket upgrade!), `/livekit/*` (WebSocket
  upgrade, path prefix preserved — the client appends `/rtc` itself) and
  `/` (static SPA with fallback to `index.html`) to the internal services.
- Preserve `Host`, `X-Forwarded-For`, `X-Forwarded-Proto`.
- Scrub the `ticket` and `access_token` query params from access logs.

Nginx sketch (inside your existing `server { listen 443 ssl; ... }`):

```nginx
location /api/ { proxy_pass http://127.0.0.1:3000; }
location /ws {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
}
location /livekit/ {
  proxy_pass http://127.0.0.1:7880/;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
}
```

Traefik: plain `Host()` routers to the same backends work; ensure the
`/livekit` router preserves the path prefix (no `stripPrefix`).

## Troubleshooting index

- First run: `docs/FIRST_RUN.md` §4 (10 most likely failures).
- Voice/media: `docs/VOICE.md` troubleshooting table + bandwidth math.
- Manual test matrix: `docs/MANUAL_TESTS.md`.
- Test coverage map: `docs/TEST_STATUS.md`.
- Security model and accepted risks: `docs/SECURITY_NOTES.md`.

## Security checklist (recurring)

- [ ] `.env` / `livekit.yaml` / `backups/*` are 0600, owned by you, never
      committed (`git status` clean of secrets).
- [ ] `COOKIE_SECURE=true` in production (compose default; verify).
- [ ] Firewall matches `docs/VOICE.md` (no stray open ports).
- [ ] `pnpm audit` clean on high/critical (CI gates this); Renovate PRs
      reviewed weekly (digest pins update base images).
- [ ] Backups exist, are recent, and a restore was tested this quarter.
- [ ] `:3000`/`:7880`/`:5432` are not published to the internet
      (`docker compose ps`, cloud security groups).
