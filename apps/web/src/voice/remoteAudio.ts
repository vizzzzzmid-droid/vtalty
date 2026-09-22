import type { Track } from "livekit-client";

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
  return element;
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
      element.srcObject = null;
      element.remove();
    }
  }
}

/** Drop the whole sink (leave/teardown path). */
export function clearRemoteAudio(owner: Document = document): void {
  owner.getElementById(REMOTE_AUDIO_CONTAINER_ID)?.remove();
}

/** How many hidden audio elements currently play (diagnostics/tests). */
export function remoteAudioCount(owner: Document = document): number {
  const container = owner.getElementById(REMOTE_AUDIO_CONTAINER_ID);
  return container instanceof HTMLDivElement
    ? container.querySelectorAll("audio").length
    : 0;
}
