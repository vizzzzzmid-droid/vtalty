import type { Track } from "livekit-client";
import { applyElementVolume, releaseElementVolume } from "./boost.js";
import { disposeUpmixedStream, upmixToStereo } from "./upmix.js";

/**
 * Hidden playback sink for remote microphone audio.
 *
 * livekit-client delivers subscribed tracks but plays nothing by itself:
 * every remote audio track must be attached to a real <audio> element in
 * the document (autoplay then follows browser policy; a blocked autoplay
 * surfaces through RoomEvent.AudioPlaybackStatusChanged and the existing
 * "click to enable audio" banner). Screen-share audio is deliberately
 * excluded — StreamTiles own those elements (volume/mute per stream).
 *
 * One shared container keeps the DOM tidy; elements are tagged with the
 * publisher identity so disconnect/unsubscribe can clean up exactly.
 */

export const REMOTE_AUDIO_CONTAINER_ID = "vitality-remote-audio";

/** Minimal surface used here (real livekit Track satisfies it). */
export interface AttachableAudioTrack {
  attachedElements: HTMLMediaElement[];
  attach: () => HTMLMediaElement;
  detach: (element?: HTMLMediaElement) => HTMLMediaElement[] | HTMLMediaElement;
  /** Present on real LiveKit tracks; absent on test doubles. */
  mediaStreamTrack?: MediaStreamTrack | null;
}

export function remoteAudioContainer(owner: Document = document): HTMLDivElement {
  const existing = owner.getElementById(REMOTE_AUDIO_CONTAINER_ID);
  if (existing instanceof HTMLDivElement) {
    return existing;
  }
  const container = owner.createElement("div");
  container.id = REMOTE_AUDIO_CONTAINER_ID;
  container.setAttribute("aria-hidden", "true");
  // Visually hidden but NOT display:none (some browsers suspend media in
  // display:none subtrees).
  container.style.cssText =
    "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden;";
  owner.body.appendChild(container);
  return container;
}

/** Attach a remote mic track to a hidden <audio> in the DOM (idempotent). */
export function attachRemoteAudio(
  track: Track | AttachableAudioTrack,
  identity: string,
  owner: Document = document,
): HTMLAudioElement | null {
  const container = remoteAudioContainer(owner);
  const present = track.attachedElements.find(
    (element): element is HTMLAudioElement =>
      element instanceof HTMLAudioElement && element.parentElement === container,
  );
  if (present !== undefined) {
    return present;
  }
  let element: HTMLMediaElement;
  try {
    element = track.attach();
  } catch {
    return null;
  }
  if (!(element instanceof HTMLAudioElement)) {
    return null;
  }
  // LiveKit hands subscribers a MONO opus stream (the SFU down-mixes for the
  // wire), and a mono track played directly into an <audio> element comes out
  // in one ear only on Chromium/Electron. Re-point the element at a stereo
  // up-mix of the same track; fall back to the direct attach when WebAudio is
  // unavailable (one ear, but audible) rather than dropping the participant.
  const mediaStreamTrack = track.mediaStreamTrack;
  if (mediaStreamTrack !== undefined && mediaStreamTrack !== null) {
    const upmixed = upmixToStereo(mediaStreamTrack);
    if (upmixed !== null) {
      element.srcObject = upmixed;
    }
  }
  element.dataset["identity"] = identity;
  container.appendChild(element);
  return element;
}

/** Apply the per-user listen volume (0..MAX_VOLUME) to a participant's
 * hidden elements. ≤100% uses native element.volume; past 100% the element
 * is rerouted through a WebAudio GainNode (see boost.ts).
 */
export function setRemoteAudioVolume(
  identity: string,
  volume: number,
  owner: Document = document,
): void {
  const container = owner.getElementById(REMOTE_AUDIO_CONTAINER_ID);
  if (!(container instanceof HTMLDivElement)) {
    return;
  }
  for (const element of container.querySelectorAll<HTMLAudioElement>("audio")) {
    if (element.dataset["identity"] === identity) {
      applyElementVolume(element, volume);
    }
  }
}

/** Detach a track's hidden elements (unsubscribe path). */
export function detachRemoteAudio(
  track: Track | AttachableAudioTrack,
  owner: Document = document,
): void {
  const container = owner.getElementById(REMOTE_AUDIO_CONTAINER_ID);
  if (!(container instanceof HTMLDivElement)) {
    return;
  }
  for (const element of track.attachedElements.filter(
    (candidate): candidate is HTMLAudioElement =>
      candidate instanceof HTMLAudioElement && candidate.parentElement === container,
  )) {
    try {
      track.detach(element);
    } catch {
      // Already detached elsewhere.
    }
    // An up-mixed stream is ours, not LiveKit's: stop it so the graph is
    // released (a bare detach would leave a live destination track behind).
    disposeUpmixedStream(
      element.srcObject instanceof MediaStream ? element.srcObject : null,
    );
    element.srcObject = null;
    releaseElementVolume(element);
    element.remove();
  }
}

/** Detach every hidden element of a participant (disconnect path). */
export function detachRemoteAudioFor(identity: string, owner: Document = document): void {
  const container = owner.getElementById(REMOTE_AUDIO_CONTAINER_ID);
  if (!(container instanceof HTMLDivElement)) {
    return;
  }
  for (const element of container.querySelectorAll<HTMLAudioElement>("audio")) {
    if (element.dataset["identity"] === identity) {
      element.removeAttribute("src");
      disposeUpmixedStream(
        element.srcObject instanceof MediaStream ? element.srcObject : null,
      );
      element.srcObject = null;
      releaseElementVolume(element);
      element.remove();
    }
  }
}

/** Drop the whole sink (leave/teardown path). */
export function clearRemoteAudio(owner: Document = document): void {
  const container = owner.getElementById(REMOTE_AUDIO_CONTAINER_ID);
  if (container instanceof HTMLDivElement) {
    for (const element of container.querySelectorAll<HTMLAudioElement>("audio")) {
      releaseElementVolume(element);
    }
    container.remove();
  }
}

/** How many hidden audio elements currently play (diagnostics/tests). */
export function remoteAudioCount(owner: Document = document): number {
  const container = owner.getElementById(REMOTE_AUDIO_CONTAINER_ID);
  return container instanceof HTMLDivElement
    ? container.querySelectorAll("audio").length
    : 0;
}
