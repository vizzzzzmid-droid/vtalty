/**
 * Volume BOOST for remote voice participants and screen-share audio.
 *
 * HTMLMediaElement.volume (and LiveKit's participant.setVolume) top out at
 * 1.0 = 100%. To let users push a quiet speaker or stream up to MAX_VOLUME
 * (400%), the element's MediaStream is rerouted through a WebAudio GainNode:
 * createMediaStreamSource(element.srcObject) → GainNode(0..MAX_VOLUME) →
 * MediaStreamAudioDestinationNode → element.srcObject.
 *
 * Why not createMediaElementSource (the first attempt, commit 8bc23b1)? It was
 * measured in Chromium 153 (fake mic + RTCPeerConnection loopback): an element
 * whose srcObject is a MediaStream — i.e. every remote LiveKit track and every
 * stream-tile element fed from an upmix destination — delivers SILENCE through
 * MediaElementAudioSourceNode while the element keeps playing directly. The
 * gain therefore moved no audible samples at all and the 0..400% slider did
 * nothing. Tapping the MediaStream itself yields full-level samples, and the
 * graph output is handed back to the element so its own renderer keeps the
 * user's chosen output device and its autoplay state.
 *
 * The reroute is LAZY: elements at ≤100% keep the native element.volume path
 * (no AudioContext needed, no autoplay-policy risk). Once a boost past 100% is
 * requested the element becomes gain-controlled: element.volume is fixed at 1
 * and the GainNode carries the 0..MAX_VOLUME value.
 *
 * The shared AudioContext resumes on the first user gesture (pointerdown /
 * keydown). A suspended context would make a rerouted element play silence, so
 * the srcObject swap waits until the context actually runs.
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
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  /** The element's original stream, restored when the boost is released. */
  input: MediaStream;
  /** Graph output handed to the element while the boost is active. */
  output: MediaStream;
}

const boosts = new WeakMap<HTMLMediaElement, BoostNode>();

/** Kick playback after the element has been switched onto the boost graph. */
function tryPlay(element: HTMLMediaElement): void {
  try {
    void element.play().catch(() => undefined);
  } catch {
    // Autoplay blocked; the unlock listeners retry on the next gesture.
  }
}

/** Apply a 0..MAX_VOLUME listen volume to a media element (lazy WebAudio). */
export function applyElementVolume(element: HTMLMediaElement, volume: number): void {
  const clamped = clampVolume(volume);
  const existing = boosts.get(element);
  if (existing !== undefined) {
    existing.gain.gain.value = clamped;
    return;
  }
  if (clamped <= 1) {
    // Native path: never-boosted elements need no AudioContext at all.
    element.volume = clamped;
    return;
  }
  const ctx = playbackContext();
  if (ctx === null) {
    // No WebAudio available: fall back to full native volume (100%).
    element.volume = 1;
    return;
  }
  const input = element.srcObject;
  if (!(input instanceof MediaStream)) {
    // Nothing to tap (plain src= media): 100% is the best we can do.
    element.volume = 1;
    return;
  }
  try {
    const source = ctx.createMediaStreamSource(input);
    const gain = ctx.createGain();
    gain.gain.value = clamped;
    const dest = ctx.createMediaStreamDestination();
    source.connect(gain);
    gain.connect(dest);
    boosts.set(element, { source, gain, input, output: dest.stream });
    // Hand the graph output back to the element. Only do it while the context
    // runs: a suspended context would feed the element a silent stream.
    const activate = (): void => {
      const node = boosts.get(element);
      if (node === undefined || node.gain !== gain) {
        return; // Released (detached) meanwhile.
      }
      // The GainNode carries the volume from now on.
      element.volume = 1;
      element.srcObject = dest.stream;
      tryPlay(element);
    };
    if (ctx.state === "running") {
      activate();
    } else {
      void ctx.resume().then(activate, () => undefined);
    }
  } catch {
    element.volume = 1;
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
  // Put the element back on its own stream when it outlives the boost node.
  if (element.srcObject === node.output) {
    element.srcObject = node.input;
  }
  element.volume = 1;
}
