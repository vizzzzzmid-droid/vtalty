# AI_AUDIT_STATE.md

## server — final verification (2026-09-28)

- `pnpm --filter @vitality/server typecheck` — PASS (`tsc --noEmit -p tsconfig.tests.json`, clean)
- `pnpm --filter @vitality/server test` — PASS (14 files, 73 tests, 2.84 s)

Fix restored, regression test confirmed. No new audit performed.

## server — LiveKit lifecycle audit (2026-09-29)

Scope: join/leave, reconnect, disconnect, cleanup, webhooks, duplicate and
out-of-order events, kick / server mute, channel switching, reconcile.

### Confirmed bugs (all in `apps/server/src/modules/voice`)

One defect class: flag mutations that were validated for channel A were
applied to the participant's *current* seat, so a channel switch landing
during an `await` (a `participant_joined` webhook, or the client's own
re-mint) moved the mutation to a channel the caller never checked. The same
class was already fixed for `participant_left` and `setMyVoiceFlags`; four
paths still used the unscoped store API.

1. **`track_unpublished` wiped a live screen share in the wrong channel.**
   A stale unpublish for the channel a sharer just left cleared
   `sharingScreen` on their seat in the channel they moved to — the share
   kept flowing at the SFU while presence said it stopped. Fix: `store.ts`
   `setFlagsInChannel`; `service.ts` uses it.
2. **`track_published` could raise the share flag in a channel the webhook
   was not verified for** (same unscoped setter after the membership check).
   Fix: `setFlagsInChannel` in the locked publish path.
3. **`moderateMute` server-mute lock followed the participant across a
   channel switch** (TOCTOU across the `listParticipants` round-trip). The
   moderator's lock for channel A landed on the live seat in channel B.
   Fix: `setFlagsInChannel` in both mute/unmute branches.
4. **`moderateDisconnect` dropped the participant from wherever they sat.**
   A switch during the `removeParticipant` await wiped the live seat in the
   new channel — presence gone, mic still flowing. Fix: new
   `store.removeFromChannel`, used by `moderateDisconnect` and
   `stopUserShare`.

Store API added: `getInChannel`, `setFlagsInChannel`, `removeFromChannel`
(`voice/store.ts`). All key off the user's *current* channel, matching the
existing `participant_left` guard.

### Regression tests (each confirmed to fail on pre-fix code)

Unit `tests/unit/voice.test.ts` (+3): scoped flag updates, scoped share flag,
scoped read after a channel move.

Integration `tests/integration/voice-moderation.test.ts` (+3):
- stale screen-share unpublish from the previous channel leaves the live
  share intact;
- server mute does not leak into a channel the moderator did not name
  (switch interleaved via a new `FakeLiveKitAdmin.onListParticipants` hook);
- disconnect only empties the channel the call named (switch interleaved via
  `onRemoveParticipant`).

The two TOCTOU tests needed the fake hooks because routes capture the
LiveKit client at registration time — swapping `app.livekit` later has no
effect. Hooks fire at the start of the awaited admin call, so the store
switch lands inside the moderation request the way a real webhook would.

### Verification (local Postgres 17)

- `pnpm --filter @vitality/server typecheck` — PASS
- `pnpm --filter @vitality/server lint` — PASS
- `pnpm --filter @vitality/server test` — PASS (14 files, 76 tests)
- `pnpm --filter @vitality/server test:integration` — PASS
  (12 files, 75 tests; voice 17, voice-moderation 10, voice-share 5)

### Audited and clean (no changes)

join/leave idempotency, duplicate joins, out-of-order `participant_left`
across sessions (sid guard), room_finished, channel/server deletion
eviction, kick/leave voice eviction, role-change enforcement, reconcile
ghost/rogue/resurrect + reservation sweep, capacity reservation locking,
screen-share cap, webhook signature verification, WS flag throttle with
newest-wins flush. All already covered by the existing suite, which still
passes unchanged.
