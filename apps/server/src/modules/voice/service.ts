import { and, eq } from "drizzle-orm";
import {
  voiceTokenResponseSchema,
  type VoiceTokenResponse,
} from "@vitality/shared";
import type { Db } from "../../db/client.js";
import { channels, users } from "../../db/schema.js";
import type { Env } from "../../env.js";
import { HttpError, badRequest, notFound } from "../../lib/errors.js";
import {
  AccessToken,
  TrackSource,
  WebhookReceiver,
  type LiveKitAdmin,
  type VideoGrant,
} from "../../lib/livekit.js";
import { getMembership, requirePermission } from "../../lib/permissions.js";
import { checkUserRateLimit } from "../../lib/rate-limit.js";
import { broadcastToServers } from "../../ws/hub.js";
import { diffVoicePresence, voiceStore } from "./store.js";

const VOICE_TOKEN_TTL_SECONDS = 600;

export interface VoiceGrantFlags {
  speak: boolean;
  shareScreen: boolean;
}

/**
 * Token grants per role (pure, unit-tested). Speakers may publish the
 * microphone, plus screen_share / screen_share_audio only with the
 * `share_screen` flag (LiveKit enforces `canPublishSources` server-side).
 */
export function voiceGrantsFor(flags: VoiceGrantFlags): Omit<VideoGrant, "room"> {
  if (flags.speak) {
    return {
      roomJoin: true,
      canSubscribe: true,
      canPublishSources: flags.shareScreen
        ? [TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO]
        : [TrackSource.MICROPHONE],
      canPublishData: false,
    };
  }
  return {
    roomJoin: true,
    canPublish: false,
    canSubscribe: true,
    canPublishData: false,
  };
}

async function findVoiceChannel(db: Db, channelId: string) {
  const rows = await db
    .select()
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  const channel = rows[0];
  if (channel === undefined) {
    throw notFound("Channel not found");
  }
  if (channel.type !== "voice") {
    throw badRequest("NOT_VOICE_CHANNEL", "Voice tokens require a voice channel");
  }
  return channel;
}

async function broadcastVoice(db: Db, channelId: string): Promise<void> {
  const channel = await findVoiceChannel(db, channelId);
  const participants = voiceStore.channelParticipants(channelId).map((seat) => ({
    userId: seat.userId,
    muted: seat.muted,
    deafened: seat.deafened,
    sharingScreen: seat.sharingScreen,
    serverMuted: seat.serverMuted,
  }));
  broadcastToServers([channel.serverId], "voice.state", {
    channelId,
    participants,
  });
}

/**
 * Mint a LiveKit join token. Identity is always the authenticated user id,
 * never client-supplied. Room name is the voice channel id.
 */
export async function mintVoiceToken(
  db: Db,
  livekit: LiveKitAdmin,
  env: Env,
  userId: string,
  channelId: string,
): Promise<VoiceTokenResponse> {
  checkUserRateLimit(`voice-token:${userId}`, 30, 60_000);
  const channel = await findVoiceChannel(db, channelId);
  const membership = await requirePermission(db, userId, channel.serverId, "connect");
  if (voiceStore.count(channelId) >= env.VOICE_MAX_PARTICIPANTS) {
    throw new HttpError(403, "CHANNEL_FULL", "Voice channel is full");
  }

  // One session per user: evict from any other channel first. The client
  // leaves the old LiveKit room on token receipt; the removal call below
  // force-drops stragglers (best effort — webhooks/reconcile converge).
  const previous = voiceStore.userChannelOf(userId);
  if (previous !== null && previous !== channelId) {
    voiceStore.remove(userId);
    await broadcastVoiceSafe(db, previous);
    try {
      await livekit.removeParticipant(previous, userId);
    } catch {
      // Converges via webhook/reconcile; membership change already applied.
    }
  }

  const speak = membership.flags.speak;
  const grant = voiceGrantsFor({
    speak,
    shareScreen: membership.flags.share_screen,
  });
  const userRows = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: userId,
    ttl: VOICE_TOKEN_TTL_SECONDS,
    name: userRows[0]?.displayName ?? "user",
  });
  token.addGrant({ ...grant, room: channelId });
  return voiceTokenResponseSchema.parse({
    token: await token.toJwt(),
    url: env.LIVEKIT_PUBLIC_URL,
    room: channelId,
  });
}

async function broadcastVoiceSafe(db: Db, channelId: string): Promise<void> {
  try {
    await broadcastVoice(db, channelId);
  } catch {
    // Channel may have been deleted concurrently; store state already converged.
  }
}

export interface WebhookSummary {
  event: string;
  channelId: string | null;
  changed: boolean;
}

/**
 * Handle a verified LiveKit webhook. Handlers are idempotent set operations:
 * duplicates and out-of-order deliveries converge (periodic reconcile heals
 * anything stranger).
 */
export async function handleWebhookEvent(
  db: Db,
  livekit: LiveKitAdmin,
  env: Env,
  eventName: string,
  roomName: string | null,
  identity: string | null,
  screenSource: boolean,
  trackSid: string | null = null,
): Promise<WebhookSummary> {
  void livekit;
  void env;
  if (roomName === null) {
    return { event: eventName, channelId: null, changed: false };
  }
  const channelRows = await db
    .select({ id: channels.id, serverId: channels.serverId })
    .from(channels)
    .where(eq(channels.id, roomName))
    .limit(1);
  const channel = channelRows[0];
  if (channel === undefined || identity === null) {
    return { event: eventName, channelId: roomName, changed: false };
  }

  switch (eventName) {
    case "participant_joined": {
      // Defense in depth: only server members may appear in presence
      // (joining already required our signed token, but webhooks are the
      // trust boundary for presence).
      const membership = await getMembership(db, identity, channel.serverId);
      if (membership === null) {
        return { event: eventName, channelId: channel.id, changed: false };
      }
      const { evictedFrom } = voiceStore.join(channel.id, identity);
      if (evictedFrom !== null) {
        await broadcastVoiceSafe(db, evictedFrom);
      }
      await broadcastVoice(db, channel.id);
      return { event: eventName, channelId: channel.id, changed: true };
    }
    case "participant_left": {
      const removed = voiceStore.remove(identity);
      if (removed === null) {
        return { event: eventName, channelId: channel.id, changed: false };
      }
      await broadcastVoice(db, removed.channelId);
      return { event: eventName, channelId: removed.channelId, changed: true };
    }
    case "room_finished": {
      const cleared = voiceStore.clearChannel(channel.id);
      if (cleared.length === 0) {
        return { event: eventName, channelId: channel.id, changed: false };
      }
      await broadcastVoice(db, channel.id);
      return { event: eventName, channelId: channel.id, changed: true };
    }
    case "track_published":
    case "track_unpublished": {
      if (!screenSource) {
        return { event: eventName, channelId: channel.id, changed: false };
      }
      if (eventName === "track_unpublished") {
        const seat = voiceStore.setFlags(identity, { sharingScreen: false });
        if (seat === null) {
          return { event: eventName, channelId: channel.id, changed: false };
        }
        await broadcastVoice(db, channel.id);
        return { event: eventName, channelId: channel.id, changed: true };
      }
      // New screen share: serialize the permission + limit checks so
      // concurrent publishes cannot both slip under the cap.
      return withChannelLock(channel.id, async () => {
        const membership = await getMembership(db, identity, channel.serverId);
        if (membership === null || !membership.flags.share_screen) {
          // No permission (token grants should already prevent this):
          // freeze the rogue track instead of advertising it.
          if (trackSid !== null) {
            try {
              await livekit.mutePublishedTrack(channel.id, identity, trackSid, true);
            } catch {
              // Best effort; the flag below stays false either way.
            }
          }
          return { event: eventName, channelId: channel.id, changed: false };
        }
        const sharers = voiceStore
          .channelParticipants(channel.id)
          .filter((seat) => seat.sharingScreen).length;
        if (sharers >= env.VOICE_MAX_SHARERS) {
          if (trackSid !== null) {
            try {
              await livekit.mutePublishedTrack(channel.id, identity, trackSid, true);
            } catch {
              // Best effort; the flag below stays false either way.
            }
          }
          return { event: eventName, channelId: channel.id, changed: false };
        }
        const seat = voiceStore.setFlags(identity, { sharingScreen: true });
        if (seat === null) {
          return { event: eventName, channelId: channel.id, changed: false };
        }
        await broadcastVoice(db, channel.id);
        return { event: eventName, channelId: channel.id, changed: true };
      });
    }
    default:
      return { event: eventName, channelId: channel.id, changed: false };
  }
}

const SCREEN_SOURCES = new Set([3, 4]); // TrackSource.SCREEN_SHARE/_AUDIO

/** Single-process per-channel mutex (the store is in-memory too). */
const channelLocks = new Map<string, Promise<void>>();

function withChannelLock<T>(channelId: string, task: () => Promise<T>): Promise<T> {
  const previous = channelLocks.get(channelId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  channelLocks.set(channelId, current);
  return previous
    .catch(() => undefined)
    .then(task)
    .finally(() => {
      if (channelLocks.get(channelId) === current) {
        channelLocks.delete(channelId);
      }
      release();
    });
}

/** Verify signature (raw body) and dispatch. Throws 401 on bad signature. */
export async function receiveWebhook(
  db: Db,
  livekit: LiveKitAdmin,
  env: Env,
  rawBody: string,
  authHeader: string | undefined,
): Promise<WebhookSummary> {
  const receiver = new WebhookReceiver(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  let event;
  try {
    event = await receiver.receive(rawBody, authHeader);
  } catch {
    throw new HttpError(401, "WEBHOOK_INVALID", "Invalid webhook signature");
  }
  const screenSource =
    event.track !== undefined && SCREEN_SOURCES.has(event.track.source);
  return handleWebhookEvent(
    db,
    livekit,
    env,
    event.event,
    event.room?.name ?? null,
    event.participant?.identity ?? null,
    screenSource,
    event.track?.sid ?? null,
  );
}

/** Client flag update: accepted only for current participants. */
export async function setMyVoiceFlags(
  db: Db,
  userId: string,
  channelId: string,
  flags: { muted: boolean; deafened: boolean },
): Promise<boolean> {
  const seat = voiceStore.setFlags(userId, flags);
  if (seat === null || seat.channelId !== channelId) {
    return false;
  }
  await broadcastVoice(db, channelId);
  return true;
}

/** Admin server-mute/unmute (persists as serverMuted + LiveKit track mute). */
export async function moderateMute(
  db: Db,
  livekit: LiveKitAdmin,
  actorId: string,
  channelId: string,
  targetUserId: string,
  muted: boolean,
): Promise<void> {
  const channel = await findVoiceChannel(db, channelId);
  await requirePermission(db, actorId, channel.serverId, "manage_members");
  const seat = voiceStore.get(channelId, targetUserId);
  if (seat === null) {
    throw notFound("Participant is not in this voice channel");
  }
  if (muted) {
    const audioSid = await publishedAudioSid(livekit, channelId, targetUserId);
    if (audioSid !== null) {
      try {
        await livekit.mutePublishedTrack(channelId, targetUserId, audioSid, true);
      } catch {
        throw new HttpError(502, "LIVEKIT_ERROR", "LiveKit mute failed");
      }
    }
    voiceStore.setFlags(targetUserId, { serverMuted: true, muted: true });
  } else {
    const audioSid = await publishedAudioSid(livekit, channelId, targetUserId);
    if (audioSid !== null) {
      try {
        await livekit.mutePublishedTrack(channelId, targetUserId, audioSid, false);
      } catch {
        throw new HttpError(502, "LIVEKIT_ERROR", "LiveKit unmute failed");
      }
    }
    voiceStore.setFlags(targetUserId, { serverMuted: false });
  }
  await broadcastVoice(db, channelId);
}

async function publishedAudioSid(
  livekit: LiveKitAdmin,
  room: string,
  identity: string,
): Promise<string | null> {
  let participants: { identity: string; audioTrackSid: string | null }[];
  try {
    participants = await livekit.listParticipants(room);
  } catch {
    throw new HttpError(502, "LIVEKIT_ERROR", "LiveKit is unreachable");
  }
  return (
    participants.find((participant) => participant.identity === identity)
      ?.audioTrackSid ?? null
  );
}

/** Admin disconnect (force-drop from the LiveKit room + presence). */
export async function moderateDisconnect(
  db: Db,
  livekit: LiveKitAdmin,
  actorId: string,
  channelId: string,
  targetUserId: string,
): Promise<void> {
  const channel = await findVoiceChannel(db, channelId);
  await requirePermission(db, actorId, channel.serverId, "manage_members");
  const seat = voiceStore.get(channelId, targetUserId);
  if (seat === null) {
    throw notFound("Participant is not in this voice channel");
  }
  try {
    await livekit.removeParticipant(channelId, targetUserId);
  } catch {
    throw new HttpError(502, "LIVEKIT_ERROR", "LiveKit disconnect failed");
  }
  voiceStore.remove(targetUserId);
  await broadcastVoice(db, channelId);
}

/**
 * Best-effort voice eviction used by kick/leave/channel-delete/role-change.
 * Never throws on LiveKit failure: membership changes win, and the periodic
 * reconcile (which checks membership before re-adding) heals any ghost.
 */
export async function removeFromVoice(
  db: Db,
  livekit: LiveKitAdmin,
  serverId: string,
  userId: string,
): Promise<void> {
  const channelId = voiceStore.userChannelOf(userId);
  if (channelId === null) {
    return;
  }
  const channelRows = await db
    .select({ serverId: channels.serverId })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  if (channelRows[0]?.serverId !== serverId) {
    return;
  }
  try {
    await livekit.removeParticipant(channelId, userId);
  } catch {
    // Healed by reconcile; see note above.
  }
  voiceStore.remove(userId);
  await broadcastVoiceSafe(db, channelId);
}

export interface ReconcileSummary {
  channels: number;
  ghostsRemoved: number;
  resurrected: number;
  roguesDropped: number;
  errors: number;
}

/**
 * Stop one user's screen share without dropping their voice: freeze the
 * screen tracks server-side and clear the flag. Used by moderation, the
 * sharer cap, and share-permission loss.
 */
export async function stopUserShare(
  db: Db,
  livekit: LiveKitAdmin,
  channelId: string,
  targetUserId: string,
): Promise<boolean> {
  const seat = voiceStore.get(channelId, targetUserId);
  if (seat === null || !seat.sharingScreen) {
    return false;
  }
  let screenSids: string[];
  try {
    const participants = await livekit.listParticipants(channelId);
    screenSids =
      participants.find((participant) => participant.identity === targetUserId)
        ?.screenTrackSids ?? [];
  } catch {
    throw new HttpError(502, "LIVEKIT_ERROR", "LiveKit is unreachable");
  }
  for (const trackSid of screenSids) {
    try {
      await livekit.mutePublishedTrack(channelId, targetUserId, trackSid, true);
    } catch {
      throw new HttpError(502, "LIVEKIT_ERROR", "LiveKit stop-share failed");
    }
  }
  voiceStore.setFlags(targetUserId, { sharingScreen: false });
  await broadcastVoice(db, channelId);
  return true;
}

/** Admin "stop this user's stream" (requires manage_members). */
export async function moderateStopShare(
  db: Db,
  livekit: LiveKitAdmin,
  actorId: string,
  channelId: string,
  targetUserId: string,
): Promise<void> {
  const channel = await findVoiceChannel(db, channelId);
  await requirePermission(db, actorId, channel.serverId, "manage_members");
  const stopped = await stopUserShare(db, livekit, channelId, targetUserId);
  if (!stopped) {
    throw notFound("Participant is not sharing in this voice channel");
  }
}

/**
 * Evict every voice participant of a server who lost `connect` (role
 * changes, flag edits), and stop shares whose owner lost `share_screen`.
 * Called after role updates; no-op when all is well.
 */
export async function enforceServerVoiceAccess(
  db: Db,
  livekit: LiveKitAdmin,
  serverId: string,
): Promise<void> {
  const voiceChannels = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.serverId, serverId), eq(channels.type, "voice")));
  for (const channel of voiceChannels) {
    for (const seat of voiceStore.channelParticipants(channel.id)) {
      const membership = await getMembership(db, seat.userId, serverId);
      if (membership === null || !membership.flags.connect) {
        await removeFromVoice(db, livekit, serverId, seat.userId);
      } else if (seat.sharingScreen && !membership.flags.share_screen) {
        await stopUserShare(db, livekit, channel.id, seat.userId);
      }
    }
  }
}

/**
 * Reconcile store against LiveKit (startup + periodic). LiveKit membership
 * wins, except re-adding requires a live server membership with `connect` —
 * otherwise the participant is force-dropped (kicked users stay out).
 */
export async function reconcileVoice(
  db: Db,
  livekit: LiveKitAdmin,
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    channels: 0,
    ghostsRemoved: 0,
    resurrected: 0,
    roguesDropped: 0,
    errors: 0,
  };
  const voiceChannels = await db
    .select({ id: channels.id, serverId: channels.serverId })
    .from(channels)
    .where(eq(channels.type, "voice"));
  for (const channel of voiceChannels) {
    summary.channels += 1;
    let live: { identity: string }[];
    try {
      live = await livekit.listParticipants(channel.id);
    } catch {
      summary.errors += 1;
      continue;
    }
    const stored = voiceStore.channelParticipants(channel.id).map((seat) => seat.userId);
    const { ghosts, missing } = diffVoicePresence(
      live.map((participant) => participant.identity),
      stored,
    );
    for (const userId of ghosts) {
      voiceStore.remove(userId);
      summary.ghostsRemoved += 1;
    }
    for (const userId of missing) {
      const membership = await getMembership(db, userId, channel.serverId);
      if (membership !== null && membership.flags.connect) {
        voiceStore.join(channel.id, userId);
        summary.resurrected += 1;
      } else {
        try {
          await livekit.removeParticipant(channel.id, userId);
          summary.roguesDropped += 1;
        } catch {
          summary.errors += 1;
        }
      }
    }
    if (ghosts.length > 0 || missing.length > 0) {
      await broadcastVoiceSafe(db, channel.id);
    }
  }
  return summary;
}

export async function voiceChannelParticipants(
  channelIds: readonly string[],
): Promise<{ channelId: string; participants: ReturnType<typeof voiceStore.channelParticipants> }[]> {
  return channelIds.map((channelId) => ({
    channelId,
    participants: voiceStore.channelParticipants(channelId),
  }));
}

export function userVoiceChannel(userId: string): string | null {
  return voiceStore.userChannelOf(userId);
}

export { voiceStore };
