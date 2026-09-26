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

A real-usage report ("voice only in the left ear", plus "muffled/dull,
crackling, occasional stutter, worse than Discord") traced to the **published
channel layout**, not to the noise-suppression chain. The profile is pinned in
one place, `MIC_PUBLISH_OPTIONS` in `apps/web/src/voice/settings.ts`, and
applied at both publish sites in `voice/room.ts` (initial join and
rebuild-on-change).

| Setting | Value | Why |
|---------|-------|-----|
| `audioPreset.maxBitrate` | `64000` | LiveKit's `publishDefaults` use `AudioPresets.music` (48 kbps). Discord voice runs 64–96 kbps; 64 kbps is its floor. At 15 speakers this is ~1 Mbps aggregate, fine for a small VPS. Published as a literal object rather than `AudioPresets.music` so a future SDK default bump cannot silently change our voice quality. |
| Capture rate | `sampleRate: 48000` | Opus encodes at 48 kHz; capturing anything else forces a resample on the way in. |
| `forceStereo` | `true` | **The fix for the one-ear symptom.** See below. |
| `dtx` | `true` | Saves uplink during silence. Passed explicitly (see below). |
| `red` | `true` | RFC 2198 redundant audio — the packet-loss concealment that repairs the "occasional stutter". Passed explicitly. |
| Post-gain | `DynamicsCompressor` limiter, threshold −6 dB, ratio 12:1 | The input slider reaches 200%, so gain can exceed full scale; `MediaStreamDestination` hard-clips to 16-bit PCM, which is audible as crackling. Transparent below −6 dBFS, so normal speech is untouched. |

### Why mono publication caused every symptom

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

With `forceStereo: false` the SFU negotiates **mono** Opus, and every
subscriber therefore receives a mono track. A mono track in an `<audio>`
element feeds channel 0 only, so the speaker's voice is audible in the **left
ear only**. The other two reported symptoms follow from the same block:

- **muffled / missing highs** — at mono the whole 64 kbps budget goes to the
  single voice channel, but the *music* preset's encoder tuning still assumes
  a wider band, so speech sounds dull compared to Discord's speech-tuned
  stream;
- **stutter** — DTX *and* RED are force-disabled whenever the track is
  considered stereo and the flags are left undefined. We pass both explicitly,
  so RED conceals lost packets (RED is the redundancy layer, not Opus-internal
  FEC) — this is what repairs the occasional break-up on lossy links;
- **crackling** — unrelated to Opus, from the 200% input gain clipping
  (handled by the limiter above).

### Why centring is done by publishing stereo, not by a receive-side graph

Earlier revisions tried to fix the one-ear symptom on the **receiving** side
(`upmix.ts`: a `ChannelMergerNode` fed from both inputs, driven by the shared
playback `AudioContext`). That approach is inherently unreliable and was
rolled back once after it muted the entire room:

- a `MediaStreamAudioSourceNode` only works if `channelCount === 1` is actually
  reported, and a freshly attached WebRTC track usually reports **no**
  `channelCount` at all — so the graph was skipped and the voice stayed in one
  ear for the whole call;
- routing a remote track through an `AudioContext` created outside a user
  gesture produces a **suspended** context, whose `MediaStreamDestination`
  outputs silence while the element still reports itself as playing — the
  "no sound at all" regression;
- Chromium stops delivering a WebRTC stream that nothing consumes, so the
  original stream needs a muted keeper element (same trap as the volume
  boost in `boost.ts`).

`forceStereo: true` removes the whole class of problem: the browser encodes
real stereo Opus, the SFU forwards it, and the subscriber plays **both ears
natively** — no WebAudio graph, no keeper element, no dependency on gesture
timing. Mono microphones are up-mixed by the encoder itself. The publisher-side
`ChannelMergerNode` in `chain.ts` remains for the local *loopback* ("hear
myself") path only.

`chain.ts` now publishes the **mono** gain node and uses the merger only as a
monitoring tap for `hearMyself`. Note that this means a mono published track
reaches the receiver, and Chromium/Electron render a mono `<audio>` source in
**one ear only** — see the "left ear only" section below for the open issue.

`dtx`/`red` are still passed explicitly: it documents intent, and it survives
the `??= false` branch above if a stereo track ever slips through.

### Mono playback centring (fixed)

RNNoise/DeepFilterNet (and the mono publish above) produce a **mono** track.
LiveKit delivers mono to subscribers, and a mono `MediaStream` attached straight
to an `<audio>` element is rendered in a single channel on the Chromium/Electron
renderers we ship, so the symptom appears *only* with a suppressor enabled.

The publisher-side `ChannelMergerNode` in `chain.ts` cannot fix it: the SFU
down-mixes to mono for the wire, so **every subscriber receives mono
regardless**. A receiver-side up-mix (`src/voice/upmix.ts`) is therefore the only
correct place. It is built defensively, because a suspended `AudioContext`
degrades a sink to silence and "no sound at all" is strictly worse than one ear:

- feed the mono source into **both** `ChannelMergerNode` inputs — a bare
  `connect(merger)` maps to input 0 = **LEFT only**, which is the original bug;
- treat a track whose `channelCount` is **not reported yet** as mono
  (`isMonoTrack`) instead of leaving it alone. A freshly attached WebRTC track
  usually reports no `channelCount` at all, so the stricter check silently kept
  the voice in one ear for the whole call. Only a track that positively reports
  2+ channels (`isStereoTrack`) is left completely alone. Folding a genuinely
  stereo source to a centred mono stays audible, whereas never centring the
  common mono case is the bug itself — the failure modes are not symmetric;
- **defer, never give up**: attaching happens after the async LiveKit connect, so
  the context is still `suspended` at that moment. The first attempt is made
  immediately and, if it is not possible yet, retried via
  `onPlaybackRunning` (`boost.ts`) when the context actually starts. Falling back
  permanently on the first miss is what made the bug permanent;
- reuse the **shared playback context from `boost.ts`**, which is already
  `running` in production and is unlocked on the first user gesture. A context
  created at join time starts `suspended`, and a suspended
  `MediaStreamDestination` delivers silence while the element still reports as
  playing — no error anywhere;
- return `null` whenever the context is not `running`, and fall back to the
  direct attach (pre-fix behaviour: audible, maybe in one ear, never silent);
- the element always keeps playing the **directly attached track** meanwhile, so
  the graph is only ever swapped in on top of an already-playing element;
- hold a muted **keeper** element on the original stream, because Chromium stops
  delivering a WebRTC stream that nothing consumes;
- release the graph, the keeper and the up-mixed track on detach/clear.

A previous attempt (commits `9bc781c`/`d11bd1e`) routed every sink through one
shared up-mix helper built on a context created outside a gesture, and muted the
whole room; it was reverted in `6274538`. The rules above exist because of that
regression — do not relax them without listening in a real call with Enhanced/Deep
enabled, not only running the unit tests.

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
