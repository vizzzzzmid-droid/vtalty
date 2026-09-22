# VOICE.md — LiveKit voice: networking, testing, troubleshooting

Voice runs on a self-hosted LiveKit SFU (single room per voice channel,
room name = channel id). Clients never talk to LiveKit directly over plain
HTTP: signalling goes through Caddy (`wss://<domain>/livekit` → LiveKit
`:7880`; the client SDK appends `/rtc` itself — verified in
livekit-client source).

## Required ports and firewall rules

| Port(s)   | Proto | Exposed to | Purpose                              |
|-----------|-------|------------|--------------------------------------|
| 80        | TCP   | world      | ACME HTTP-01 + redirect to HTTPS     |
| 443       | TCP   | world      | HTTPS/WSS (app, API, WS, signalling) |
| 7881      | TCP   | world      | WebRTC ICE over TCP (fallback)       |
| 7882      | UDP   | world      | WebRTC media (UDP mux, single port)  |
| 3478      | UDP   | world      | TURN/UDP (+STUN)                     |
| 5349      | TCP   | world      | TURN/TLS                             |
| 3000/7880/5432 | — | never public (docker network only) | Internal services |

UFW example (Ubuntu):
```bash
sudo ufw allow 80,443/tcp
sudo ufw allow 7881/tcp
sudo ufw allow 7882/udp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
```

## NAT / TURN in one paragraph

WebRTC media prefers direct UDP (port 7882). When a client sits behind a
strict NAT or firewall, direct UDP fails and LiveKit falls back in order:
ICE/TCP on 7881, then the embedded TURN server (UDP 3478, or TLS 5349 which
looks like HTTPS). `rtc.use_external_ip: true` lets the container discover
the host's public IP to advertise. If even TURN/TLS cannot pass, there is no
audio — that network simply blocks WebRTC.

## Host networking vs published ports

- **Linux VPS (recommended):** `network_mode: host` for the `livekit`
  service. Best media performance, no Docker NAT hairpin, `use_external_ip`
  discovery is trivial. Downside: the service shares the host network
  namespace (no port remapping).
- **Published ports / bridge (default in compose):** works everywhere,
  including Docker Desktop and dev machines, at the cost of one NAT layer.
  Media still flows; TURN keeps symmetric-NAT clients working.

## TURN/TLS certificates

TURN/TLS on 5349 is opt-in (commented out in `livekit.example.yaml`):
LiveKit v1.13 refuses to boot with `tls_port` set but no `turn.domain`
("TURN domain required" crash loop — caught by the CI smoke). To enable
it, set `turn.domain` to the public hostname plus `turn.cert_file` /
`turn.key_file` (Caddy-managed certs can be bind-mounted read-only).
Without TURN/TLS, affected clients fall back to TURN/UDP or fail —
everything else keeps working.

## How voice presence works

1. Client clicks a voice channel → `POST /api/v1/channels/:id/voice-token`
   (member + `connect` permission, max 15 participants) → short-lived
   LiveKit JWT (identity = user id, mic-only publish grant).
2. Client joins the LiveKit room; LiveKit POSTs signed webhooks to
   `http://server:3000/webhooks/livekit` (`participant_joined/left`,
   `room_finished`, screen-share track events).
3. Webhooks update the server voice store, which fans out `voice.state`
   over our WebSocket and fills the `voice` section of the state snapshot —
   so everyone sees who is where without joining.
4. A reconcile loop (startup + every 60s) diffs the store against LiveKit
   and heals ghosts; kicked/disconnected users are force-dropped via
   `removeParticipant`.

## Screen-share bandwidth math (read before raising limits)

LiveKit is an SFU: it forwards, never transcodes. Each viewer receives
their OWN downstream copy of every watched stream, so VPS upstream for one
1080p60 share with N viewers ≈ N × stream bitrate. Typical screen
bitrates (VP8/H264, LiveKit screen presets):

| Preset | Resolution/fps | ~Bitrate | 3 viewers upstream | 10 viewers upstream |
|--------|----------------|-----------|--------------------|---------------------|
| 720p30 | 1280×720@30 | ~1.0 Mbps | ~3 Mbps | ~10 Mbps |
| 1080p30 (default) | 1920×1080@30 | ~1.9 Mbps | ~6 Mbps | ~19 Mbps |
| 1080p60 | 1920×1080@60 | ~3.0 Mbps | ~9 Mbps | ~30 Mbps |
| Source | native | up to ~4+ Mbps | varies | varies |

Recommendations for one small VPS: keep the default preset at 1080p30,
`VOICE_MAX_SHARERS=3`, and viewer opt-in ("Watch stream") always on —
unwatched streams cost the VPS nothing because viewers never subscribe.
Audio (Opus ~32 kbps/person) is noise next to video. A 1080p60 share with
10 viewers (~30 Mbps sustained upstream) alone can saturate a budget VPS.

## How to test (quick)
1. Two browsers (or a normal + an incognito window) on the same server.
2. Both click the same voice channel and allow the microphone.
3. Each sidebar shows both participants; the speaking ring follows the talker.
4. A mutes → B sees the muted icon. A deafens → icon changes, A hears nothing.
5. A disconnects → B's list updates within a second or two.
6. Restart the `server` container mid-call → participants reappear after the
   reconcile (≤60s) with no duplicates; restart `livekit` → clients show
   the reconnect banner and rejoin.

## Troubleshooting

| Symptom | Likely cause | Check |
|---------|--------------|-------|
| Stuck on "connecting" | UDP 7882 / TCP 7881 blocked, or wrong `LIVEKIT_PUBLIC_URL` | Firewall rules; `wss://…/livekit` reachable; `docker compose logs livekit` |
| No audio either way | Browser blocked mic, or no ICE path | Mic permission prompt; `chrome://webrtc-internals` shows selected candidate pair |
| One-way audio | Asymmetric NAT without working TURN | TURN ports open; try another network; embedded TURN logs |
| Works on LAN, fails over internet | `use_external_ip: false` or missing NAT mapping | `livekit.yaml` sets `use_external_ip: true`; host networking on Linux |
| "Channel full" though empty | Ghost presence after crash | Wait ≤60s for reconcile, or restart `server` (reconciles at boot) |
| Join works, sidebar empty | Webhook URL unreachable from LiveKit | `livekit.yaml` webhook URL must resolve to the `server` container; check server logs for `WEBHOOK_INVALID` |
| Echo/robot voice | Two tabs joined, or speakers feeding the mic | Close duplicate tabs; wear headphones |
| `access_token` in Caddy logs | Misconfigured log filter | `Caddyfile` must keep the `access_token REDACTED` query filter |
| Share button missing | Not connected, or role lacks `share_screen` | Join voice first; owner checks Members → role |
| Stream frozen for viewers | Stopped by sharer cap or moderator | Sharer sees a notice; re-share (or ask for the cap/role) |
| No system audio in a share | Browser/OS limitation | Chrome offers a tab-audio checkbox in the picker; Firefox/Safari may share video only |
| Enhanced mode falls back to Standard | No 48 kHz audio, no AudioWorklet, or WASM blocked | Read the in-app notice; check browser console; verify the CSP allows `wasm-unsafe-eval` |
