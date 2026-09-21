import {
  AccessToken,
  RoomServiceClient,
  TrackSource,
  WebhookReceiver,
  type VideoGrant,
} from "livekit-server-sdk";
import type { Env } from "../env.js";

export interface LiveParticipantInfo {
  identity: string;
  audioTrackSid: string | null;
  screenTrackSids: string[];
}

/**
 * Minimal LiveKit admin surface the server needs. Real implementation talks
 * to LiveKit over HTTP; tests inject a fake. Kept narrow on purpose so the
 * voice service never depends on the full SDK surface.
 */
export interface LiveKitAdmin {
  listParticipants(room: string): Promise<LiveParticipantInfo[]>;
  removeParticipant(room: string, identity: string): Promise<void>;
  mutePublishedTrack(
    room: string,
    identity: string,
    trackSid: string,
    muted: boolean,
  ): Promise<void>;
}

export class LiveKitService implements LiveKitAdmin {
  private readonly rooms: RoomServiceClient;

  constructor(env: Env) {
    this.rooms = new RoomServiceClient(
      env.LIVEKIT_URL,
      env.LIVEKIT_API_KEY,
      env.LIVEKIT_API_SECRET,
    );
  }

  async listParticipants(room: string): Promise<LiveParticipantInfo[]> {
    const participants = await this.rooms.listParticipants(room);
    return participants.map((participant) => ({
      identity: participant.identity,
      audioTrackSid:
        participant.tracks.find(
          (track) => track.source === TrackSource.MICROPHONE,
        )?.sid ?? null,
      screenTrackSids: participant.tracks
        .filter(
          (track) =>
            track.source === TrackSource.SCREEN_SHARE ||
            track.source === TrackSource.SCREEN_SHARE_AUDIO,
        )
        .map((track) => track.sid),
    }));
  }

  async removeParticipant(room: string, identity: string): Promise<void> {
    await this.rooms.removeParticipant(room, identity);
  }

  async mutePublishedTrack(
    room: string,
    identity: string,
    trackSid: string,
    muted: boolean,
  ): Promise<void> {
    await this.rooms.mutePublishedTrack(room, identity, trackSid, muted);
  }
}

export function createLiveKit(env: Env): LiveKitAdmin {
  return new LiveKitService(env);
}

declare module "fastify" {
  interface FastifyInstance {
    livekit: LiveKitAdmin;
  }
}

export { AccessToken, TrackSource, WebhookReceiver, type VideoGrant };
