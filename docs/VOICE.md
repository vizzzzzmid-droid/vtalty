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
Audio (Opus ~64 kbps/person) is noise next to video. A 1080p60 share with
10 viewers (~30 Mbps sustained upstream) alone can saturate a budget VPS.

## Voice audio quality profile (Opus)

A real-usage report ("muffled/dull, crackling, occasional stutter, worse than
Discord") traced to a **stereo-published voice track**, not to the
noise-suppression chain. The profile is pinned in one place,
`MIC_PUBLISH_OPTIONS` in `apps/web/src/voice/settings.ts`, and applied at both
publish sites in `voice/room.ts` (initial join and rebuild-on-change).

| Setting | Value | Why |
|---------|-------|-----|
| `audioPreset.maxBitrate` | `64000` | LiveKit's `publishDefaults` use `AudioPresets.music` (48 kbps). Discord voice runs 64–96 kbps; 64 kbps is its floor. At 15 speakers this is ~1 Mbps aggregate, fine for a small VPS. Published as a literal object rather than `AudioPresets.music` so a future SDK default bump cannot silently change our voice quality. |
| Capture rate | `sampleRate: 48000` | Opus encodes at 48 kHz; capturing anything else forces a resample on the way in. |
| Capture channels | `channelCount: 1` | A voice track is mono. This is the fix for the reported symptoms — see below. |
| `forceStereo` | `false` | Pins mono even if a device hands us 2 channels. |
| `dtx` | `true` | Saves uplink during silence. Passed explicitly (see below). |
| `red` | `true` | RFC 2198 redundant audio — the packet-loss concealment that repairs the "occasional stutter". Passed explicitly. |
| Post-gain | `DynamicsCompressor` limiter, threshold −6 dB, ratio 12:1 | The input slider reaches 200%, so gain can exceed full scale; `MediaStreamDestination` hard-clips to 16-bit PCM, which is audible as crackling. Transparent below −6 dBFS, so normal speech is untouched. |

### Why a stereo track caused all three symptoms

`livekit-client` 2.22.3, in `LocalParticipant.publishTrack()`:

```js
const isStereo = opts.forceStereo ?? (track.getSettings().channelCount === 2 …);
if (isStereo) {
  if (opts.dtx === undefined) { log.debug("Opus DTX will be disabled for stereo tracks by default…"); }
  if (opts.red === undefined) { log.debug("Opus RED will be disabled for stereo tracks by default…"); }
  opts.dtx ??= false;
  opts.red ??= false;
}
```

Our chain built a `ChannelMergerNode(2)` for **local loopback centring** and
connected *it* to the `MediaStreamDestination`. That made the published track
stereo, and then:

- **muffled / missing highs** — the music preset's bitrate is split across two
  channels, so each channel got roughly half the bits;
- **stutter** — DTX *and* RED were force-disabled, so nothing concealed lost
  packets (RED is not Opus-internal FEC; it is the redundancy layer);
- **crackling** — unrelated to Opus, from the 200% gain clipping (above).

`chain.ts` now publishes the **mono** gain node and uses the merger only as a
monitoring tap for `hearMyself`. Receivers already centre mono playback
(`remoteAudio.ts` merges mono into both channels), so nothing is lost.

### Receiver-side centring (`upmix.ts`) — the real "left ear only" cause

RNNoise/DeepFilterNet make the published track **mono**, and LiveKit delivers
mono to subscribers. A mono track played straight into an `<audio>` element is
rendered in **one ear only** on the Chromium/Electron renderers we ship, which
is why the symptom appeared *only* when a noise suppressor was enabled.

The publisher-side merger in `chain.ts` cannot fix this: the SFU down-mixes to
mono for the wire, so **every subscriber receives mono regardless**. The fix has
to be on the receiving side, so all playback sinks route through one helper,
`upmixToStereo()` in `apps/web/src/voice/upmix.ts`:

- a mono track is fed into **both** `ChannelMergerNode` inputs — a bare
  `connect(merger)` maps to input 0 = **LEFT only**, which was the original bug;
- a genuine stereo track goes through a `ChannelSplitter` so L and R stay
  separated (wiring stereo straight into a merger input would down-mix it);
- both remote mic elements (`remoteAudio.ts`) **and** stream-tile elements
  (`screen.ts`) use the same helper, so the two sinks cannot drift apart;
- one shared 48 kHz `AudioContext`, resumed explicitly — Chromium starts a
  context created outside a user gesture *suspended*, and a suspended
  `MediaStreamDestination` carries **silence** even though the element reports as
  playing;
- if WebAudio is unavailable the helper returns `null` and callers fall back to a
  direct attach (one ear, but audible) rather than dropping the participant;
- on detach the up-mixed track is stopped, otherwise the graph leaks.

`dtx`/`red` are still passed explicitly: it documents intent, and it survives
the `??= false` branch above if a stereo track ever slips through.

### Not changed, and why

- **FEC is not exposed by LiveKit** — for Opus the loss-concealment knob is RED
  plus the SFU's own jitter buffer; there is no `opusFec` publish option.
- **Noise suppression is not implicated.** RNNoise/DeepFilterNet process at
  48 kHz mono with a 128-frame ring buffer; changing them does not affect
  highs or packet loss. Try Deep vs Enhanced vs Off to confirm on your own mic.
- **96 kbps** is left on the table deliberately: inaudible for speech above
  ~64 kbps, and it costs uplink and encode CPU for everyone in the room.

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
| Voice muffled, crackles, stutters | Voice track published as stereo, or input gain clipping | Fixed: mono publish + limiter, see "Voice audio quality profile (Opus)" above. Confirm with `chrome://webrtc-internals` → the audio sender's `channels` must read `1` |
