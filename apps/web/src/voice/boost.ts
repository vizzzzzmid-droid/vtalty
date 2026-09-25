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
 * Three follow-up failure modes were measured against real Chromium/Edge 153
 * and are defended against here (they all surfaced as "the volume slider does
 * nothing" in production):
 *
 * 1. A boost created while the AudioContext is still suspended (created
 *    outside a user gesture — see also the stream-tile unlock note in
 *    screen.ts) used to leave the element half-wired: the gain existed but
 *    the element kept playing its original stream, so EVERY later slider move
 *    hit the gain of a graph the element was never attached to. The swap now
 *    waits for `statechange`/resume, re-runs on every apply, and until it
 *    happens ≤100% keeps working through the native element.volume path —
 *    a ≤100% request on a never-activated node releases the graph entirely.
 * 2. Once the boosted element leaves the original stream, Chromium stops
 *    delivering a WebRTC remote stream when nothing consumes it — the graph's
 *    own MediaStreamSourceNode does NOT count: both the graph output and the
 *    element went silent. A muted hidden "keeper" element keeps the original
 *    stream alive for the lifetime of the boost.
 * 3. Drift: anything that re-attaches the element (LiveKit re-subscribe,
 *    stream-tile cleanup) replaces srcObject and silently detaches the gain.
 *    Every apply re-checks the wiring, re-taps a replaced stream and swaps
 *    the element back onto the graph output.
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
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  /** The element's stream at tap time; follows re-attachments (see syncBoost). */
  input: MediaStream;
  /** Graph output handed to the element while the boost is active. */
  output: MediaStream;
  /** Muted element keeping `input` alive while the boosted element plays the
   *  graph output (Chromium drops WebRTC streams nothing consumes). */
  keeper: HTMLAudioElement | null;
}

const boosts = new WeakMap<HTMLMediaElement, BoostNode>();
/** Elements whose swap is waiting for the AudioContext to reach "running". */
const pendingActivations = new Set<HTMLMediaElement>();
const stateListened = new WeakSet<AudioContext>();

/** Kick playback after the element has been switched onto the boost graph. */
function tryPlay(element: HTMLMediaElement): void {
  try {
    void element.play().catch(() => undefined);
  } catch {
    // Autoplay blocked; the unlock listeners retry on the next gesture.
  }
}

/** Muted consumer for the original stream; header failure mode 2. */
function attachKeeper(node: BoostNode): void {
  if (node.keeper !== null || typeof document === "undefined") {
    return;
  }
  const keeper = document.createElement("audio");
  keeper.muted = true;
  keeper.autoplay = true;
  keeper.srcObject = node.input;
  keeper.setAttribute("aria-hidden", "true");
  // Visually hidden but NOT display:none (some browsers suspend media there).
  keeper.style.cssText =
    "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;";
  document.body.appendChild(keeper);
  tryPlay(keeper);
  node.keeper = keeper;
}

/** Move the element onto the graph output (context must be running). */
function swapOntoGraph(element: HTMLMediaElement, node: BoostNode): void {
  attachKeeper(node);
  // The GainNode carries the volume from now on.
  element.volume = 1;
  element.srcObject = node.output;
  tryPlay(element);
  pendingActivations.delete(element);
}

/** Re-tap a replaced stream so the gain keeps following the live source. */
function retapInput(node: BoostNode, stream: MediaStream): void {
  try {
    node.source.disconnect();
  } catch {
    // Context already gone.
  }
  node.source = node.ctx.createMediaStreamSource(stream);
  node.source.connect(node.gain);
  node.input = stream;
  if (node.keeper !== null) {
    node.keeper.srcObject = stream;
  }
}

/** Retry every waiting swap once the context reaches "running". */
function flushPendingActivations(): void {
  for (const element of [...pendingActivations]) {
    const node = boosts.get(element);
    if (node === undefined) {
      pendingActivations.delete(element);
    } else if (node.ctx.state === "running") {
      swapOntoGraph(element, node);
    }
  }
}

/** Make sure the boost is actually wired: heal drift, wait out a suspended
 *  context, and keep ≤100% audible through the native path meanwhile. */
function syncBoost(element: HTMLMediaElement, node: BoostNode): void {
  const current = element.srcObject;
  if (current === node.output) {
    element.volume = 1;
    pendingActivations.delete(element);
    return;
  }
  if (!(current instanceof MediaStream)) {
    // No stream to tap: native ≤100% is the best we can do.
    element.volume = Math.min(1, node.gain.gain.value);
    return;
  }
  if (current !== node.input) {
    retapInput(node, current);
  }
  if (node.ctx.state === "running") {
    swapOntoGraph(element, node);
    return;
  }
  // Suspended context: native volume carries ≤100% until the swap can run.
  element.volume = Math.min(1, node.gain.gain.value);
  pendingActivations.add(element);
  if (!stateListened.has(node.ctx)) {
    stateListened.add(node.ctx);
    node.ctx.addEventListener("statechange", () => {
      if (node.ctx.state === "running") {
        flushPendingActivations();
      }
    });
  }
  void node.ctx.resume().then(flushPendingActivations, () => undefined);
}

/** Apply a 0..MAX_VOLUME listen volume to a media element (lazy WebAudio). */
export function applyElementVolume(element: HTMLMediaElement, volume: number): void {
  const clamped = clampVolume(volume);
  const existing = boosts.get(element);
  if (existing !== undefined) {
    if (clamped > 1) {
      existing.gain.gain.value = clamped;
      // Re-check the wiring: heal drift and finish a deferred swap.
      syncBoost(element, existing);
      return;
    }
    if (element.srcObject === existing.output) {
      // Gain-routed already: the GainNode carries sub-100% values too.
      existing.gain.gain.value = clamped;
      return;
    }
    // The node was never activated (or the element drifted off the graph):
    // hand the element back to the native path so 0..100% always moves the
    // real volume instead of an orphaned GainNode.
    releaseElementVolume(element);
    element.volume = clamped;
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
    const node: BoostNode = {
      ctx,
      source,
      gain,
      input,
      output: dest.stream,
      keeper: null,
    };
    boosts.set(element, node);
    // Swap the element onto the graph now if the context runs; otherwise this
    // waits for `statechange`/resume while ≤100% stays natively controllable.
    syncBoost(element, node);
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
  pendingActivations.delete(element);
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
  if (node.keeper !== null) {
    // The boosted element consumes `input` again, so the keeper can go now.
    node.keeper.srcObject = null;
    try {
      node.keeper.pause();
    } catch {
      // Already detached.
    }
    node.keeper.remove();
    node.keeper = null;
  }
}
