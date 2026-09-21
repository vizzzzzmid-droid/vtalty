# MANUAL_TESTS — real-device voice checklist (Phase 4)

Automated coverage (unit, integration, chat e2e) cannot hear audio. Work
through this list on real hardware before calling voice "done". The
experimental CI `e2e-voice` job covers presence/mute/deafen propagation
only — everything below needs ears. Screen-share and noise-suppression rows
are marked; they become pass/fail gates in Phase 5.

Setup: two users (A on one network, B on another — e.g. phone hotspot vs
home Wi-Fi), both logged in, both in the same voice channel.

## Core call matrix

- [ ] A and B join: both sidebars list both participants within ~2s.
- [ ] Audio both ways: A talks, B hears; B talks, A hears. No echo with
      headphones; acceptable echo cancellation on speakers.
- [ ] Speaking ring follows the talker on both screens.
- [ ] A mutes (user panel): B sees the red muted icon; B hears nothing;
      A unmutes: audio resumes without rejoin.
- [ ] A deafens: A hears nothing (incoming silenced), B sees the deafened
      icon AND A appears muted (deafen implies mute). A undeafens: previous
      mute state returns (was unmuted → talks immediately).
- [ ] A third user C (same server, never joins) sees A+B in the sidebar.
- [ ] Join/leave sounds play for local joins and remote join/leave.
- [ ] Per-user volume: B lowers A to 0 → silence; restores to 100 → audio.
      Reload the page: the volume persists.
- [ ] Device switching: A changes input mid-call (Settings → Voice & Audio)
      → audio continues from the new mic. Same for output device.
- [ ] Mic test meter moves while talking in Settings.
- [ ] Push-to-talk: A enables PTT, sets a key, mutes via toggle, holds the
      key → B hears; release → silence. Works only with the tab focused
      (web limitation, stated in the UI).
- [ ] Reconnect: A toggles Wi-Fi off for 10s → banner shows "Reconnecting";
      Wi-Fi back → rejoins automatically, sidebar converges, no duplicates.
- [ ] Kicked user: admin disconnects B from the participant menu → B drops
      out of the room immediately with no ghost in the sidebar.
- [ ] Server-mute: admin server-mutes B → B cannot unmute (icon stays);
      admin lifts → B can unmute.
- [ ] Restart the `server` container mid-call → participants reappear within
      ~60s (reconcile), no duplicates, no ghosts after everyone leaves.
- [ ] Two tabs, one user: second tab joining the same channel evicts the
      first (one session per user); no double presence.

## Network matrix

- [ ] Same LAN: connects in <3s, UDP direct (check `chrome://webrtc-internals`
      candidate pair is `udp/host` or `udp/srflx`).
- [ ] Different networks/NAT: connects via TURN or ICE/TCP fallback; audio
      both ways. Note which path `webrtc-internals` shows.
- [ ] Corporate VPN/firewall: documents whether TURN/TLS 5349 was needed.

## Phase 5 previews (not gates yet)

- [ ] Screen share button visible only in Phase 5 (currently absent).
- [ ] Noise modes Off/Standard behave; Enhanced arrives in Phase 5.

## Chromium fake-media flags (for automated UI states)

```bash
chromium --use-fake-device-for-media-stream --use-fake-ui-for-media-stream
```
Used by the CI `e2e-voice` job. Fake devices grant "microphone" without
 Prompts; they do NOT produce speech-like levels, so speaking-indicator
assertions are manual-only.
