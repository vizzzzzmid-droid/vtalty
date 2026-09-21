# FIRST_RUN.md — from zero to a working vitality stack

> Nothing here has ever been executed on a real machine: every command below
> is written for a first run. Follow the Ubuntu VPS track for production or
> the WSL2 track for local development. Phase 4 state: text chat is fully
> working; voice needs the `livekit` service up and UDP/TCP media ports
> reachable (see `docs/VOICE.md`).

## 0. Prerequisites

- Ubuntu 22.04+ (VPS with a public IP) **or** Windows 10/11 with WSL2
  (Ubuntu distro) for local runs.
- A domain pointing at the VPS for production (e.g.
  `vitality.kirskiy.shop` with an `A` record). Localhost runs need no DNS.
- Docker Engine 24+ and Docker Compose v2 (`docker compose version`).
- Git, and ports 80/443 reachable from the internet (VPS only, for ACME).

## 1. Ubuntu VPS — full stack

```bash
# 1. Install Docker (once)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# log out and back in so the docker group applies

# 2. Open firewall ports (UFW example)
sudo ufw allow 80,443/tcp
sudo ufw allow 7881/tcp
sudo ufw allow 7882/udp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw enable

# 3. Get the code and configure secrets
git clone <your-repo-url> vitality
cd vitality
cp .env.example .env
cp livekit.example.yaml livekit.yaml
nano .env            # set POSTGRES_PASSWORD, JWT_ACCESS_SECRET, LIVEKIT_API_SECRET
nano livekit.yaml    # same LIVEKIT_API_SECRET under keys:, plus CADDY_DOMAIN in .env
```

Expected: no output from the `cp` commands; `nano` edits persist.

```bash
# 4. Start everything
make up              # == docker compose up --build
```

Expected: five services start; `server` runs migrations (`migrations
applied` in `make logs`); `caddy` issues an ACME certificate within a
minute (check `docker compose logs caddy` for `certificate obtained`).

```bash
# 5. Verify
curl -f https://vitality.kirskiy.shop/healthz        # {"status":"ok",...}
curl -f https://vitality.kirskiy.shop/api/v1/health  # same, via proxy
```

Expected: both return `200` with a JSON status body. Then open the domain
in a browser, register the first user (becomes owner, no invite needed),
create an invite in Settings → Invites, and have a friend join.

## 2. WSL2 — local development

```bash
# Inside the Ubuntu WSL2 distro:
sudo apt update && sudo apt install -y docker.io docker-compose-plugin nodejs npm
# (Or Docker Desktop with WSL2 integration — either works.)
cd /mnt/c/Users/<you>/Documents/vitality   # or wherever the repo lives
cp .env.example .env
cp livekit.example.yaml livekit.yaml
make dev
pnpm install
# Terminal 1:
DATABASE_URL=postgres://vitality:<pw>@127.0.0.1:5432/vitality pnpm --filter @vitality/server dev
# Terminal 2:
pnpm --filter @vitality/web dev   # http://127.0.0.1:5173, /api proxied to :3000
```

Expected: `make dev` reports postgres `:5432` and LiveKit `:7880` healthy;
the server logs `migrations applied` and listens on `:3000`; the web UI
loads and the login page appears. Note: WSL2 has no systemd Docker by
default — `sudo service docker start` if the daemon is down.

## 3. Voice smoke (both tracks)

1. Open two browsers (or normal + incognito), log in as two users.
2. Click the same voice channel → allow the microphone → both sidebars
   list both participants.
3. Mute/deafen/disconnect and watch the icons follow.
4. If audio fails, work through `docs/VOICE.md` troubleshooting.

## 4. The 10 most likely failures

1. **`docker: permission denied`** — user is not in the `docker` group
   yet. Log out/in (VPS) or start the daemon (`sudo service docker start`
   in WSL2).
2. **Caddy never issues a certificate** — ports 80/443 are firewalled, or
   DNS does not point at the VPS. Check `docker compose logs caddy` and
   `curl -v http://<domain>/.well-known/acme-challenge/x`.
3. **Browsers warn about HTTPS on localhost** — expected: Caddy uses an
   internal CA for `localhost`. Accept the exception (dev only).
4. **Server exits with `DATABASE_URL` / secret errors** — `.env` was not
   created or a `?set ... in .env` variable is empty. Compare with
   `.env.example`.
5. **`migrations applied` never appears / `/readyz` returns 503** —
   Postgres is still starting or credentials mismatch. `docker compose logs
   postgres`; verify `POSTGRES_*` match `DATABASE_URL`.
6. **Voice stuck on "connecting"** — media ports blocked or wrong
   `LIVEKIT_PUBLIC_URL`. Re-check firewall section 0 and
   `docs/VOICE.md`; confirm `wss://<domain>/livekit` answers.
7. **No audio one/both ways** — mic permission denied in the browser, or no
   ICE path. See `chrome://webrtc-internals`; try another network.
8. **`CHANNEL_FULL` on an empty channel** — ghost presence after a crash.
   Wait ≤60s for the reconcile loop, or restart `server` (reconciles at
   boot).
9. **Sidebar shows nobody after joining voice** — LiveKit cannot reach the
   webhook (`http://server:3000/webhooks/livekit` must resolve inside the
   compose network). Check server logs for `WEBHOOK_INVALID`.
10. **`pnpm install` fails on Node < 22** — the repo pins Node 22
    (`.nvmrc`, Docker images). Run `nvm use` / install Node 22.
