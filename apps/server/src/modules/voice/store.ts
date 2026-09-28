import type { VoiceParticipant } from "@vitality/shared";

export interface VoiceSeat extends VoiceParticipant {
  channelId: string;
  joinedAt: number;
  /**
   * The LiveKit participant sid of the session that seated this user. LiveKit
   * does not guarantee webhook order across sessions (a reconnect seats a
   * NEW sid, and the old session's `participant_left` can land after the new
   * session's `participant_joined`), so the sid is what tells a stale leave
   * apart from the real one. Null when the seat came from reconcile (which
   * does not see sids) — such seats accept any leave, matching the old
   * behavior.
   */
  participantSid: string | null;
  /**
   * A minted token reserves this seat until the corresponding
   * `participant_joined` webhook clears it. Pending seats count toward the
   * channel capacity (a minted token occupies a slot) but never appear in
   * presence: nobody has joined yet.
   */
  pending: boolean;
  reservedAt: number | null;
}

export interface VoiceFlags {
  muted?: boolean;
  deafened?: boolean;
  sharingScreen?: boolean;
  serverMuted?: boolean;
  /** Cleared by the participant_joined webhook (see VoiceSeat.pending). */
  pending?: boolean;
  reservedAt?: number;
  /** Set by the participant_joined webhook (see VoiceSeat.participantSid). */
  participantSid?: string | null;
}

function defaultSeat(channelId: string, userId: string): VoiceSeat {
  return {
    userId,
    channelId,
    muted: false,
    deafened: false,
    sharingScreen: false,
    serverMuted: false,
    joinedAt: Date.now(),
    participantSid: null,
    pending: false,
    reservedAt: null,
  };
}

/**
 * In-memory voice presence. LiveKit room membership is the source of truth;
 * this store mirrors it (webhooks + reconcile) so the API/WS layer can serve
 * presence without a LiveKit round-trip. All operations are idempotent and
 * order-tolerant: duplicates and out-of-order webhook deliveries converge.
 */
class VoiceStore {
  private readonly seats = new Map<string, Map<string, VoiceSeat>>();
  private readonly userChannel = new Map<string, string>();

  /**
   * Join; evicts the user from any other channel (one session per user).
   * Passing `pending: false` (the webhook path) clears a reservation: the
   * participant is really in the room now.
   */
  join(
    channelId: string,
    userId: string,
    flags?: VoiceFlags,
  ): { evictedFrom: string | null } {
    const current = this.userChannel.get(userId);
    let evictedFrom: string | null = null;
    if (current !== undefined && current !== channelId) {
      this.remove(userId);
      evictedFrom = current;
    }
    let channel = this.seats.get(channelId);
    if (channel === undefined) {
      channel = new Map();
      this.seats.set(channelId, channel);
    }
    const existing = channel.get(userId);
    if (existing === undefined) {
      channel.set(userId, { ...defaultSeat(channelId, userId), ...(flags ?? {}) });
    } else {
      // A live join clears any pending reservation for this seat.
      channel.set(userId, { ...existing, ...flags, pending: false });
    }
    this.userChannel.set(userId, channelId);
    return { evictedFrom };
  }

  /** Remove wherever the user sits. Returns the channel or null (no-op). */
  remove(userId: string): { channelId: string } | null {
    const channelId = this.userChannel.get(userId);
    if (channelId === undefined) {
      return null;
    }
    this.userChannel.delete(userId);
    const channel = this.seats.get(channelId);
    if (channel !== undefined) {
      channel.delete(userId);
      if (channel.size === 0) {
        this.seats.delete(channelId);
      }
    }
    return { channelId };
  }

  /** Drop a whole channel (room_finished / channel deleted). */
  clearChannel(channelId: string): string[] {
    const channel = this.seats.get(channelId);
    if (channel === undefined) {
      return [];
    }
    const users = [...channel.keys()];
    for (const userId of users) {
      this.userChannel.delete(userId);
    }
    this.seats.delete(channelId);
    return users;
  }

  /**
   * Update flags. `muted`/`deafened` are the participant's OWN state as
   * announced by their client; `serverMuted` is the moderator's lock and is
   * kept separate. The two invariants this layer enforces:
   *
   *   deafened === true  =>  muted === true
   *
   * (deafening someone while their mic is live is a contradiction — they
   * cannot hear anyone, so they cannot hold a conversation), and a server
   * mute is never liftable by the client — that one is enforced at the
   * projection boundary (`toVoiceParticipant` publishes `muted ||
   * serverMuted`), so lifting a server mute restores the participant's own
   * state exactly instead of leaving them stuck "muted".
   */
  setFlags(userId: string, flags: VoiceFlags): VoiceSeat | null {
    const channelId = this.userChannel.get(userId);
    if (channelId === undefined) {
      return null;
    }
    const channel = this.seats.get(channelId);
    const seat = channel?.get(userId);
    if (seat === undefined) {
      return null;
    }
    const next: VoiceSeat = { ...seat, ...flags };
    if (next.deafened && !next.muted) {
      next.muted = true;
    }
    channel?.set(userId, next);
    return next;
  }

  get(channelId: string, userId: string): VoiceSeat | null {
    return this.seats.get(channelId)?.get(userId) ?? null;
  }

  /**
   * Read a seat, but only when the user sits in THIS channel. Callers that
   * validated a channel before awaiting (webhooks, moderation) must use this
   * or the scoped writers below: `setFlags`/`remove` key off the user's
   * CURRENT channel, so a channel switch landing in the await window would
   * otherwise move the mutation to a channel the caller never checked.
   */
  getInChannel(channelId: string, userId: string): VoiceSeat | null {
    if (this.userChannel.get(userId) !== channelId) {
      return null;
    }
    return this.seats.get(channelId)?.get(userId) ?? null;
  }

  /**
   * Update flags, but only when the user still sits in THIS channel; null
   * when they moved (the caller's channel check went stale across an await).
   * Used by the webhook and moderation paths, where the channel was verified
   * before a LiveKit round-trip and a `participant_joined` for another
   * channel may have re-seated the user since.
   */
  setFlagsInChannel(
    channelId: string,
    userId: string,
    flags: VoiceFlags,
  ): VoiceSeat | null {
    if (this.userChannel.get(userId) !== channelId) {
      return null;
    }
    return this.setFlags(userId, flags);
  }

  /**
   * Remove the user, but only from THIS channel; null when they already
   * moved elsewhere (their live seat in the other channel must survive a
   * disconnect/mute aimed at the channel they just left).
   */
  removeFromChannel(
    channelId: string,
    userId: string,
  ): { channelId: string } | null {
    if (this.userChannel.get(userId) !== channelId) {
      return null;
    }
    return this.remove(userId);
  }

  /**
   * Seats published as presence. Pending reservations are excluded by
   * default: their owner has a token but has not joined the room yet, so
   * advertising them would show ghost participants. Callers that need the
   * raw occupancy (reconcile diffing, role enforcement) pass
   * `includePending`.
   */
  channelParticipants(
    channelId: string,
    options: { includePending?: boolean } = {},
  ): VoiceSeat[] {
    const channel = this.seats.get(channelId);
    if (channel === undefined) {
      return [];
    }
    if (options.includePending !== true) {
      return [...channel.values()].filter((seat) => !seat.pending);
    }
    return [...channel.values()];
  }

  userChannelOf(userId: string): string | null {
    return this.userChannel.get(userId) ?? null;
  }

  count(channelId: string): number {
    // Includes pending reservations: a minted token occupies a slot.
    return this.seats.get(channelId)?.size ?? 0;
  }

  channelIds(): string[] {
    return [...this.seats.keys()];
  }

  /**
   * Drop pending reservations whose token has outlived its TTL without a
   * `participant_joined` (client minted a token and never connected).
   * Returns the channel ids whose occupancy changed, so callers can
   * re-broadcast presence.
   */
  sweepReservations(ttlMs: number, now: number = Date.now()): string[] {
    const changed: string[] = [];
    for (const [channelId, channel] of this.seats) {
      let touched = false;
      for (const [userId, seat] of channel) {
        if (
          seat.pending &&
          seat.reservedAt !== null &&
          seat.reservedAt + ttlMs < now
        ) {
          channel.delete(userId);
          this.userChannel.delete(userId);
          touched = true;
        }
      }
      if (touched) {
        if (channel.size === 0) {
          this.seats.delete(channelId);
        }
        changed.push(channelId);
      }
    }
    return changed;
  }

  /**
   * Atomic admission for one voice channel (called under the per-channel
   * lock from mintVoiceToken).
   *
   * Returns `admitted: false` when the channel is full. A successful admit
   * RESERVES a seat (pending) so a concurrent token request observes it in
   * `count` and can no longer slip under the cap — this is what closes the
   * check-then-act race two concurrent `GET voice-token` requests had.
   *
   * A re-mint by a user who already holds a seat in this channel (token
   * refresh, reconnect) never counts twice.
   */
  admit(
    channelId: string,
    userId: string,
    max: number,
    now: number = Date.now(),
  ): { admitted: boolean; evictedFrom: string | null } {
    const channel = this.seats.get(channelId);
    if (channel !== undefined) {
      const existing = channel.get(userId);
      if (existing !== undefined) {
        // Already holds a seat here (pending reservation or a live
        // re-mint): refresh the reservation, never double-count.
        if (existing.pending) {
          existing.reservedAt = now;
        }
        return { admitted: true, evictedFrom: null };
      }
    }
    if (this.count(channelId) >= max) {
      return { admitted: false, evictedFrom: null };
    }
    const evictedFrom =
      this.join(channelId, userId, {
        pending: true,
        reservedAt: now,
      }).evictedFrom ?? null;
    return { admitted: true, evictedFrom };
  }

  reset(): void {
    this.seats.clear();
    this.userChannel.clear();
  }
}

export const voiceStore = new VoiceStore();

/**
 * Publish a seat as presence. The effective mute is the participant's own
 * flag OR the moderator's lock: a server-muted participant must read as
 * muted to everyone else even though their own flag is untouched (so that
 * lifting the lock restores it verbatim).
 */
export function toVoiceParticipant(seat: VoiceSeat): VoiceParticipant {
  return {
    userId: seat.userId,
    muted: seat.muted || seat.serverMuted,
    deafened: seat.deafened,
    sharingScreen: seat.sharingScreen,
    serverMuted: seat.serverMuted,
  };
}

/** Pure diff for reconcile: live ids vs stored ids. Unit-tested. */
export function diffVoicePresence(
  liveIds: readonly string[],
  storedIds: readonly string[],
): { ghosts: string[]; missing: string[] } {
  const live = new Set(liveIds);
  const stored = new Set(storedIds);
  return {
    ghosts: storedIds.filter((id) => !live.has(id)),
    missing: liveIds.filter((id) => !stored.has(id)),
  };
}
