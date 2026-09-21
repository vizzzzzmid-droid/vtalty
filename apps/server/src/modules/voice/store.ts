import type { VoiceParticipant } from "@vitality/shared";

export interface VoiceSeat extends VoiceParticipant {
  channelId: string;
  joinedAt: number;
}

export interface VoiceFlags {
  muted?: boolean;
  deafened?: boolean;
  sharingScreen?: boolean;
  serverMuted?: boolean;
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

  /** Join; evicts the user from any other channel (one session per user). */
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
      channel.set(userId, { ...existing, ...(flags ?? {}) });
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
   * Update flags. A server-mute cannot be lifted by the client: unmuting
   * while serverMuted stays forced to muted (the flag, not the request).
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
    if (next.serverMuted && flags.muted === false) {
      next.muted = true;
    }
    channel?.set(userId, next);
    return next;
  }

  get(channelId: string, userId: string): VoiceSeat | null {
    return this.seats.get(channelId)?.get(userId) ?? null;
  }

  channelParticipants(channelId: string): VoiceSeat[] {
    return [...(this.seats.get(channelId)?.values() ?? [])];
  }

  userChannelOf(userId: string): string | null {
    return this.userChannel.get(userId) ?? null;
  }

  count(channelId: string): number {
    return this.seats.get(channelId)?.size ?? 0;
  }

  channelIds(): string[] {
    return [...this.seats.keys()];
  }

  reset(): void {
    this.seats.clear();
    this.userChannel.clear();
  }
}

export const voiceStore = new VoiceStore();

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
