import type {
  ConnectionState,
  Participant,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
  TrackPublication,
  LocalTrackPublication,
} from "livekit-client";
import { ApiError } from "../api/http.js";
import { requestVoiceToken } from "../api/resources.js";
import { sendVoiceFlags } from "../ws/socket.js";
import { buildMicChain, type MicChain } from "./chain.js";
import { EnhancedUnavailableError } from "./rnnoise.js";
import {
  attachRemoteAudio,
  clearRemoteAudio,
  detachRemoteAudio,
  detachRemoteAudioFor,
  setRemoteAudioVolume,
} from "./remoteAudio.js";
import type { VoiceQuality } from "./store.js";
import { useVoiceConnection } from "./store.js";
import { useVoiceSettings } from "./settings.js";
import { voiceSounds } from "./sounds.js";

type LiveKitModule = typeof import("livekit-client");

let livekitModule: LiveKitModule | null = null;

/** Lazily load livekit-client (split out of the initial bundle). */
async function livekit(): Promise<LiveKitModule> {
  if (livekitModule === null) {
    livekitModule = await import("livekit-client");
  }
  return livekitModule;
}

let room: Room | null = null;
let chain: MicChain | null = null;
let micPublication: LocalTrackPublication | null = null;
let intentionalDisconnect = false;
let qualityTimer: ReturnType<typeof setInterval> | null = null;
let lastAnnounced = "";
let suppressShareNotice = false;

/** Suppress the "stream stopped remotely" notice around our own stops. */
export function setSuppressShareNotice(value: boolean): void {
  suppressShareNotice = value;
}
const attached: [RoomEvent, (...args: never[]) => void][] = [];

function snapshot() {
  return useVoiceConnection.getState();
}

/** Audibility: deafened implies muted; PTT gates the mic when enabled. */
function isAudible(): boolean {
  const s = snapshot();
  const prefs = useVoiceSettings.getState();
  return !s.selfDeafened && !s.selfMuted && (!prefs.pttEnabled || s.pttActive);
}

function applyMicGate(): void {
  if (chain !== null) {
    chain.track.enabled = isAudible();
  }
}

function announce(): void {
  const s = snapshot();
  if (s.channelId === null) {
    return;
  }
  const key = `${String(!isAudible())}:${String(s.selfDeafened)}`;
  if (key === lastAnnounced) {
    return;
  }
  lastAnnounced = key;
  sendVoiceFlags(s.channelId, !isAudible(), s.selfDeafened);
}

function applyDeafenSubscriptions(deafened: boolean): void {
  if (room === null) {
    return;
  }
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.audioTrackPublications.values()) {
      (publication as RemoteTrackPublication).setSubscribed(!deafened);
    }
    // Deafen also silences screen-share audio (never the video).
    // String literal keeps livekit-client out of the initial chunk
    // (value matches Track.Source.ScreenShareAudio, verified in types).
    for (const publication of participant.trackPublications.values()) {
      if ((publication as { source?: unknown }).source === "screen_share_audio") {
        (publication as RemoteTrackPublication).setSubscribed(!deafened);
      }
    }
  }
}

function applyAllVolumes(): void {
  if (room === null) {
    return;
  }
  const volumes = useVoiceSettings.getState().userVolumes;
  for (const participant of room.remoteParticipants.values()) {
    const volume = volumes[participant.identity];
    if (volume !== undefined) {
      setRemoteAudioVolume(participant.identity, volume);
    }
  }
}

export function applyUserVolume(userId: string, volume: number): void {
  console.info("[vol-debug] applyUserVolume", userId, volume);
  setRemoteAudioVolume(userId, volume);
}

function sampleQuality(): void {
  if (room === null) {
    return;
  }
  snapshot().set({ connectionQuality: toVoiceQuality(room.localParticipant.connectionQuality) });
}

function toVoiceQuality(value: string): VoiceQuality {
  return value === "excellent" ||
    value === "good" ||
    value === "poor" ||
    value === "lost"
    ? value
    : "unknown";
}

function startQualityTimer(): void {
  stopQualityTimer();
  qualityTimer = setInterval(sampleQuality, 5000);
}

function stopQualityTimer(): void {
  if (qualityTimer !== null) {
    clearInterval(qualityTimer);
    qualityTimer = null;
  }
}

function on(target: Room, event: RoomEvent, handler: (...args: never[]) => void): void {
  // Room.on is strictly typed per event (typed-emitter); dynamic
  // registration for teardown goes through this narrow structural cast.
  const emitter = target as unknown as {
    on(event: RoomEvent, cb: (...args: never[]) => void): void;
    off(event: RoomEvent, cb: (...args: never[]) => void): void;
  };
  emitter.on(event, handler);
  attached.push([event, handler]);
}

function detachAll(target: Room): void {
  const emitter = target as unknown as {
    off(event: RoomEvent, cb: (...args: never[]) => void): void;
  };
  for (const [event, handler] of attached.splice(0)) {
    emitter.off(event, handler);
  }
}

function attachHandlers(next: Room, LK: LiveKitModule): void {
  on(next, LK.RoomEvent.ConnectionStateChanged, (connState: ConnectionState) => {
    const s = snapshot();
    if (connState === LK.ConnectionState.Connected) {
      s.set({ status: "connected", error: null });
      sampleQuality();
      announce();
    } else if (
      connState === LK.ConnectionState.Reconnecting ||
      connState === LK.ConnectionState.SignalReconnecting
    ) {
      s.set({ status: "reconnecting" });
    } else if (connState === LK.ConnectionState.Disconnected && !intentionalDisconnect) {
      s.set({ status: "failed", error: "Voice connection lost. Rejoin to try again." });
    }
  });
  on(next, LK.RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
    snapshot().set({ speakingIds: speakers.map((speaker) => speaker.identity) });
  });
  on(next, LK.RoomEvent.ParticipantConnected, () => {
    if (snapshot().status === "connected") {
      voiceSounds.join();
    }
  });
  on(next, LK.RoomEvent.ParticipantDisconnected, (participant: Participant) => {
    detachRemoteAudioFor(participant.identity);
    if (snapshot().status === "connected") {
      voiceSounds.leave();
    }
  });
  on(
    next,
    LK.RoomEvent.TrackSubscribed,
    (track: Track, _publication: unknown, participant: Participant) => {
      const publication = _publication as RemoteTrackPublication;
      const watching = snapshot().watching[participant.identity] !== undefined;
      const isScreenVideo =
        track.kind === LK.Track.Kind.Video &&
        publication.source === LK.Track.Source.ScreenShare;
      const isScreenAudio =
        track.kind === LK.Track.Kind.Audio &&
        publication.source === LK.Track.Source.ScreenShareAudio;
      // Screen tracks are opt-in: anything not actively watched is
      // unsubscribed immediately (saves VPS/client bandwidth).
      if ((isScreenVideo || isScreenAudio) && !watching) {
        publication.setSubscribed(false);
        return;
      }
      if (track.kind === LK.Track.Kind.Audio && snapshot().selfDeafened) {
        publication.setSubscribed(false);
        return;
      }
      // Microphone audio must reach a real <audio> element in the DOM or
      // nothing is audible (and per-user volume has nothing to act on).
      // Screen-share audio is tile-owned (StreamTile attaches on watch).
      if (
        track.kind === LK.Track.Kind.Audio &&
        publication.source === LK.Track.Source.Microphone
      ) {
        attachRemoteAudio(track, participant.identity);
      }
      const volume = useVoiceSettings.getState().userVolumes[participant.identity];
      if (volume !== undefined && !isScreenAudio) {
        setRemoteAudioVolume(participant.identity, volume);
      }
    },
  );
  on(next, LK.RoomEvent.AudioPlaybackStatusChanged, (playing: boolean) => {
    snapshot().set({ needsAudioGesture: !playing });
  });
  on(
    next,
    LK.RoomEvent.TrackUnsubscribed,
    (track: Track) => {
      detachRemoteAudio(track);
    },
  );
  on(
    next,
    LK.RoomEvent.TrackMuted,
    (track: Track, publication: TrackPublication, participant: Participant) => {
      void track;
      if (
        participant.isLocal &&
        publication.source === LK.Track.Source.ScreenShare &&
        !suppressShareNotice
      ) {
        snapshot().set({
          shareNotice:
            "Your stream was stopped (sharer limit or moderator). Re-share to try again.",
        });
      }
    },
  );
}

function chainOptionsFromPrefs(): Parameters<typeof buildMicChain>[0] {
  const prefs = useVoiceSettings.getState();
  return {
    deviceId: prefs.inputDeviceId,
    noiseMode: prefs.noiseMode,
    noiseSuppression: prefs.noiseSuppression,
    echoCancellation: prefs.echoCancellation,
    autoGainControl: prefs.autoGainControl,
    inputVolume: prefs.inputVolume,
    gateEnabled: prefs.gateEnabled,
    gateThresholdDb: prefs.gateThresholdDb,
    loopback: prefs.hearMyself,
  };
}

/** Build the configured chain, falling back Standard on Enhanced failure. */
async function buildMicChainWithFallback(): Promise<MicChain> {
  const prefs = useVoiceSettings.getState();
  try {
    return await buildMicChain(chainOptionsFromPrefs());
  } catch (err) {
    if (prefs.noiseMode === "enhanced" && err instanceof EnhancedUnavailableError) {
      prefs.set({ noiseMode: "standard" });
      snapshot().set({
        audioNotice:
          "Enhanced suppression is unavailable here (needs 48 kHz audio + WebAudio worklets + WASM); fell back to Standard.",
      });
      return buildMicChain(chainOptionsFromPrefs());
    }
    throw err;
  }
}

function describeJoinError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "CHANNEL_FULL") {
      return "This voice channel is full.";
    }
    if (err.status === 403) {
      return "You don't have permission to join this voice channel.";
    }
    if (err.status === 404) {
      return "This voice channel no longer exists.";
    }
    return err.message;
  }
  if (err instanceof DOMException) {
    switch (err.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Microphone access was blocked. Allow it in the browser address bar and retry.";
      case "NotFoundError":
      case "OverconstrainedError":
        return "No microphone found. Plug one in or pick another input in Settings.";
      case "NotReadableError":
        return "The microphone is already in use by another app.";
      case "AbortError":
        return "Join cancelled. Try again.";
      default:
        break;
    }
  }
  return "Could not join voice (network?). Check your connection and retry.";
}

async function teardownRoom(): Promise<void> {
  intentionalDisconnect = true;
  stopQualityTimer();
  clearRemoteAudio();
  const current = room;
  room = null;
  micPublication = null;
  snapshot().set({ sharing: null, shareNotice: null });
  if (current !== null) {
    detachAll(current);
    try {
      await current.disconnect();
    } catch {
      // Already gone; presence converges via webhook.
    }
  }
  if (chain !== null) {
    chain.cleanup();
    chain = null;
  }
}

export function isVoiceConnected(): boolean {
  return room !== null && snapshot().status === "connected";
}

/** Raw room access for the screen-share module (null when disconnected). */
export function getRoom(): Room | null {
  return room;
}

export function currentVoiceChannel(): string | null {
  return snapshot().channelId;
}

export async function joinVoiceChannel(channelId: string): Promise<void> {
  const s = snapshot();
  if (
    s.status === "connecting" ||
    (s.status === "connected" && s.channelId === channelId)
  ) {
    return;
  }
  if (room !== null) {
    await teardownRoom();
  }
  s.set({ status: "connecting", channelId, error: null, speakingIds: [] });
  intentionalDisconnect = false;
  lastAnnounced = "";
  try {
    const invitation = await requestVoiceToken(channelId);
    // Build the mic chain BEFORE connecting: device errors then fail fast
    // without a ghost join. Enhanced mode falls back to Standard when the
    // browser cannot do 48 kHz / AudioWorklet / WASM.
    const mic = await buildMicChainWithFallback();
    chain = mic;
    const sdk = await livekit();
    const next = new sdk.Room({ adaptiveStream: true, dynacast: true });
    room = next;
    attachHandlers(next, sdk);
    await next.connect(invitation.url, invitation.token);
    try {
      micPublication = await next.localParticipant.publishTrack(mic.track, {
        source: sdk.Track.Source.Microphone,
      });
    } catch {
      // Listen-only grants (or revoked speak): stay connected, listen only.
      snapshot().set({ error: "Connected listen-only: publishing was refused." });
    }
    const outputId = useVoiceSettings.getState().outputDeviceId;
    if (outputId !== null) {
      await next.switchActiveDevice("audiooutput", outputId).catch(() => false);
    }
    applyAllVolumes();
    applyDeafenSubscriptions(snapshot().selfDeafened);
    applyMicGate();
    announce();
    snapshot().set({ status: "connected", error: snapshot().error });
    sampleQuality();
    startQualityTimer();
    voiceSounds.join();
  } catch (err) {
    await teardownRoom();
    snapshot().set({ status: "failed", channelId, error: describeJoinError(err) });
  }
}

export async function leaveVoiceChannel(): Promise<void> {
  await teardownRoom();
  snapshot().set({
    status: "idle",
    channelId: null,
    error: null,
    speakingIds: [],
    pttActive: false,
    watching: {},
  });
  voiceSounds.leave();
}

export async function setSelfMuted(muted: boolean): Promise<void> {
  const s = snapshot();
  if (s.selfMuted === muted) {
    return;
  }
  s.set({ selfMuted: muted });
  if (muted) {
    voiceSounds.mute();
  } else {
    voiceSounds.unmute();
  }
  applyMicGate();
  announce();
}

export async function setSelfDeafened(deafened: boolean): Promise<void> {
  const s = snapshot();
  if (s.selfDeafened === deafened) {
    return;
  }
  if (deafened) {
    s.set({ selfDeafened: true, preDeafenMuted: s.selfMuted });
    voiceSounds.deafen();
  } else {
    s.set({ selfDeafened: false, selfMuted: s.preDeafenMuted });
    voiceSounds.undeafen();
  }
  applyDeafenSubscriptions(deafened);
  applyMicGate();
  announce();
}

export function setPttActive(active: boolean): void {
  const s = snapshot();
  if (s.pttActive === active) {
    return;
  }
  s.set({ pttActive: active });
  applyMicGate();
  announce();
}

export async function setInputVolume(volume: number): Promise<void> {
  useVoiceSettings.getState().set({ inputVolume: volume });
  chain?.setVolume(volume);
}

/** Rebuild the mic chain (device/mode change) without leaving the room. */
export async function rebuildMicChain(): Promise<void> {
  if (room === null || chain === null) {
    return;
  }
  // Mute state lives on the MediaStreamTrack; the new chain starts enabled
  // and applyMicGate() below restores the current gate afterwards.
  const fresh = await buildMicChainWithFallback();
  const previous = chain;
  const previousPublication = micPublication;
  chain = fresh;
  try {
    micPublication = await room.localParticipant.publishTrack(fresh.track, {
      source: (await livekit()).Track.Source.Microphone,
    });
  } catch (err) {
    chain = previous;
    fresh.cleanup();
    throw err;
  }
  if (previousPublication !== null) {
    try {
      await room.localParticipant.unpublishTrack(previous.track, true);
    } catch {
      // Old track already gone; the new one is live.
    }
  }
  previous.cleanup();
  applyMicGate();
}

export async function setOutputDevice(deviceId: string | null): Promise<boolean> {
  useVoiceSettings.getState().set({ outputDeviceId: deviceId });
  if (room === null || deviceId === null) {
    return true;
  }
  return room.switchActiveDevice("audiooutput", deviceId);
}

export async function listInputDevices(): Promise<MediaDeviceInfo[]> {
  const sdk = await livekit();
  return sdk.Room.getLocalDevices("audioinput");
}

export async function listOutputDevices(): Promise<MediaDeviceInfo[]> {
  const sdk = await livekit();
  return sdk.Room.getLocalDevices("audiooutput");
}

export async function startAudioPlayback(): Promise<void> {
  if (room !== null) {
    await room.startAudio();
  }
}

let unloadArmed = false;

/** Best-effort leave on tab close (the server converges via webhook). */
export function armUnloadCleanup(): void {
  if (unloadArmed) {
    return;
  }
  unloadArmed = true;
  window.addEventListener("beforeunload", () => {
    try {
      void room?.disconnect();
    } catch {
      // Unloading anyway.
    }
    chain?.cleanup();
  });
}
