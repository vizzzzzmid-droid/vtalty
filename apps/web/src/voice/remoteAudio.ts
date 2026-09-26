import type { Track } from "livekit-client";
import { applyElementVolume, releaseElementVolume } from "./boost.js";
import { centerMonoTrack, type CenteredStream } from "./upmix.js";

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
  /** Underlying track, used to decide whether centring is needed. */
  mediaStreamTrack?: MediaStreamTrack;
}

/**
 * Centring graphs attached per element. WeakMap so a forgotten teardown can
 * never keep a graph (or its keeper element) alive.
 */
const centered = new WeakMap<HTMLAudioElement, CenteredStream>();

/**
 * Route a mono track through the shared playback context so the voice is
 * centred in BOTH ears. Any failure falls back to a direct attach, which is
 * the pre-fix behaviour: audible in one ear rather than silent.
 */
function centerElement(element: HTMLAudioElement, mediaTrack: MediaStreamTrack | undefined): void {
  if (mediaTrack === undefined || centered.has(element)) {
    return;
  }
  const graph = centerMonoTrack(mediaTrack);
  if (graph === null) {
    return;
  }
  centered.set(element, graph);
  element.srcObject = graph.stream;
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
  element.dataset["identity"] = identity;
  container.appendChild(element);
  centerElement(element, track.mediaStreamTrack);
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

/** Drop a centring graph and hand the element back to its original stream. */
function releaseCentering(element: HTMLAudioElement): void {
  const graph = centered.get(element);
  if (graph === undefined) {
    return;
  }
  centered.delete(element);
  element.srcObject = graph.input;
  graph.release();
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
    // Restore the original stream BEFORE detaching, so the element is never
    // left pointing at a torn-down graph output.
    releaseCentering(element);
    try {
      track.detach(element);
    } catch {
      // Already detached elsewhere.
    }
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
      releaseCentering(element);
      element.removeAttribute("src");
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
      releaseCentering(element);
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
