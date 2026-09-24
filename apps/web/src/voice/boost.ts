/**
 * Volume BOOST for remote voice participants and screen-share audio.
 *
 * HTMLMediaElement.volume (and LiveKit's participant.setVolume) top out at
 * 1.0 = 100%. To let users push a quiet speaker or stream up to MAX_VOLUME
 * (400%), the element is rerouted through a WebAudio GainNode:
 * createMediaElementSource(element) → GainNode(0..MAX_VOLUME) → destination.
 *
 * The reroute is LAZY: elements at ≤100% keep the native element.volume
 * path (no AudioContext needed, no autoplay-policy risk). Once a boost past
 * 100% is requested, the element becomes permanently gain-controlled (a
 * MediaElementSource cannot be reverted to direct output): element.volume is
 * fixed at 1 and the GainNode carries the 0..MAX_VOLUME value.
 *
 * The shared AudioContext resumes on the first user gesture (pointerdown /
 * keydown) — the same autoplay dance as the screen-share upmix context.
 */

/** Maximum listen-volume multiplier (400%). */
export const MAX_VOLUME = 4;

/** Clamp a stored/requested volume into the supported 0..MAX_VOLUME range. */
export function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) {
    return 1;
  }
  return Math.min(MAX_VOLUME, Math.max(0, volume));
}

let sharedContext: AudioContext | null = null;
let unlockListenersInstalled = false;

function playbackContext(): AudioContext | null {
  if (typeof AudioContext === "undefined") {
    return null;
  }
  if (sharedContext === null) {
    try {
      sharedContext = new AudioContext();
    } catch {
      return null;
    }
  }
  installUnlockListeners();
  if (sharedContext.state === "suspended") {
    void sharedContext.resume();
  }
  console.info("[vol-debug] boost ctx state:", sharedContext.state);
  return sharedContext;
}

function installUnlockListeners(): void {
  if (unlockListenersInstalled || typeof document === "undefined") {
    return;
  }
  unlockListenersInstalled = true;
  const unlock = (): void => {
    if (sharedContext !== null && sharedContext.state === "suspended") {
      void sharedContext.resume();
    }
  };
  document.addEventListener("pointerdown", unlock);
  document.addEventListener("keydown", unlock);
}

interface BoostNode {
  source: MediaElementAudioSourceNode;
  gain: GainNode;
}

const boosts = new WeakMap<HTMLMediaElement, BoostNode>();

/** Apply a 0..MAX_VOLUME listen volume to a media element (lazy WebAudio). */
export function applyElementVolume(element: HTMLMediaElement, volume: number): void {
  const clamped = clampVolume(volume);
  const existing = boosts.get(element);
  if (existing !== undefined) {
    existing.gain.gain.value = clamped;
    console.info(
      "[vol-debug] boost: existing gain =", clamped,
      "ctx.state:", existing.gain.context.state,
    );
    return;
  }
  if (clamped <= 1) {
    // Native path: never-boosted elements need no AudioContext at all.
    element.volume = clamped;
    console.info("[vol-debug] boost: native element.volume =", clamped);
    return;
  }
  const ctx = playbackContext();
  if (ctx === null) {
    // No WebAudio available: fall back to full native volume (100%).
    element.volume = 1;
    console.info("[vol-debug] boost: NO AudioContext -> fallback element.volume = 1");
    return;
  }
  try {
    const source = ctx.createMediaElementSource(element);
    const gain = ctx.createGain();
    gain.gain.value = clamped;
    source.connect(gain);
    gain.connect(ctx.destination);
    boosts.set(element, { source, gain });
    // The GainNode carries the volume from now on.
    element.volume = 1;
    console.info(
      "[vol-debug] boost: CREATED gain =", clamped,
      "ctx.state:", ctx.state,
      "srcObject:", element.srcObject !== null,
      "paused:", element.paused,
      "muted:", element.muted,
    );
  } catch (err) {
    element.volume = 1;
    console.info("[vol-debug] boost: createMediaElementSource FAILED:", err);
  }
}

/** Disconnect a boost node (element detach/teardown path). */
export function releaseElementVolume(element: HTMLMediaElement): void {
  const node = boosts.get(element);
  if (node === undefined) {
    return;
  }
  boosts.delete(element);
  try {
    node.source.disconnect();
    node.gain.disconnect();
  } catch {
    // Context already gone.
  }
  element.volume = 1;
}
