#!/usr/bin/env node
/**
 * Opt-in audio probe: which WebAudio mechanism actually carries remote voice
 * audio, and does the shipped boost really move samples?
 *
 * Background: vitality boosts per-user/per-stream listen volume up to 400%
 * (apps/web/src/voice/boost.ts). Commit 8bc23b1 first built that boost on
 * createMediaElementSource(element) and the slider was completely inaudible in
 * production. This probe reproduces both mechanisms against a real Chromium
 * (system Edge channel) with a fake microphone and a loopback
 * RTCPeerConnection pair, measuring signal peaks with an AnalyserNode.
 *
 * Measured on Chromium 153 (2026-09-25) — the numbers the assertions below
 * enforce:
 *   control oscillator                      peak 0.30  (harness is alive)
 *   createMediaElementSource(remote el)     peak 0.00  ← the production bug:
 *     MediaElementAudioSourceNode delivers SILENCE for elements whose srcObject
 *     is a MediaStream, while the element keeps playing directly.
 *   createMediaStreamSource(remoteStream)   peak 1.00  ← what we ship now
 *   rendered (element.captureStream) with the graph handed to srcObject:
 *     gain 1 -> 1.00, gain 2 -> 2.00, gain 0 -> 0.00 (true mute)
 *
 * Usage (from apps/desktop, needs @playwright/test + the system Edge channel):
 *   node scripts/audio-boost-probe.mjs
 * Exits 0 when every expectation holds, 1 otherwise. Not part of CI: it needs a
 * browser channel and fake media devices.
 */
import { createServer } from "node:http";
import { chromium } from "@playwright/test";

const PAGE = "<!doctype html><html><body><pre id=out></pre></body></html>";

const PROBE = async () => {
  const out = {};
  const log = (...a) => console.log("STEP", ...a);
  const peak = (analyser, ms) =>
    new Promise((resolve) => {
      const buf = new Float32Array(analyser.fftSize);
      let max = 0;
      let elapsed = 0;
      const step = 40;
      const iv = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        for (let i = 0; i < buf.length; i += 1) {
          const v = Math.abs(buf[i]);
          if (v > max) max = v;
        }
        elapsed += step;
        if (elapsed >= ms) {
          clearInterval(iv);
          resolve(Number(max.toFixed(4)));
        }
      }, step);
    });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tap = async (stream, ms) => {
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const a = ctx.createAnalyser();
    a.fftSize = 2048;
    src.connect(a);
    return peak(a, ms);
  };

  // 0. control
  log("control");
  {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    g.gain.value = 0.3;
    const a = ctx.createAnalyser();
    osc.connect(g);
    g.connect(a);
    osc.start();
    out.control_peak = await peak(a, 300);
    out.control_state = ctx.state;
  }
  log("control-done", out.control_peak, out.control_state);

  // 1. fake mic -> RTCPeerConnection loopback -> REMOTE stream
  log("rtc-setup");
  const local = await navigator.mediaDevices.getUserMedia({ audio: true });
  const pc1 = new RTCPeerConnection();
  const pc2 = new RTCPeerConnection();
  pc1.onicecandidate = (e) => {
    if (e.candidate) void pc2.addIceCandidate(e.candidate);
  };
  pc2.onicecandidate = (e) => {
    if (e.candidate) void pc1.addIceCandidate(e.candidate);
  };
  const remote = await new Promise(async (resolve) => {
    pc2.ontrack = (e) => resolve(e.streams[0]);
    for (const t of local.getTracks()) pc1.addTrack(t, local);
    const offer = await pc1.createOffer();
    await pc1.setLocalDescription(offer);
    await pc2.setRemoteDescription(offer);
    const answer = await pc2.createAnswer();
    await pc2.setLocalDescription(answer);
    await pc1.setRemoteDescription(answer);
  });
  out.remote_tracks = remote.getAudioTracks().length;
  log("rtc-done", out.remote_tracks);

  // element exactly like livekit-client's track.attach()
  const el = document.createElement("audio");
  el.autoplay = true;
  el.srcObject = remote;
  document.body.appendChild(el);
  await el.play();
  await sleep(600);
  out.element_playing = !el.paused;
  log("element-ready", out.element_playing);

  // 2. the mechanism we REMOVED: silent for srcObject elements
  log("removed-mechanism");
  {
    const ctx = new AudioContext();
    const src = ctx.createMediaElementSource(el);
    const a = ctx.createAnalyser();
    a.fftSize = 2048;
    src.connect(a);
    a.connect(ctx.destination);
    out.removed_MediaElementSource_peak = await peak(a, 400);
    out.removed_MediaElementSource_state = ctx.state;
  }
  log("removed-mechanism-done", out.removed_MediaElementSource_peak, out.removed_MediaElementSource_state);

  // 3. the SHIPPED mechanism: tap -> gain -> MSAD -> element.srcObject
  log("shipped-mechanism");
  const el2 = document.createElement("audio");
  el2.autoplay = true;
  el2.srcObject = remote;
  document.body.appendChild(el2);
  await el2.play();
  await sleep(500);

  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(remote);
  const gain = ctx.createGain();
  const dest = ctx.createMediaStreamDestination();
  src.connect(gain);
  gain.connect(dest);
  out.boost_ctx_state = ctx.state;

  const measureGraph = async (value, ms) => {
    gain.gain.value = value;
    await sleep(300);
    return tap(dest.stream, ms);
  };
  // Same beep-period requirement as the render measurements below.
  out.graph_gain1 = await measureGraph(1, 1200);
  out.graph_gain2 = await measureGraph(2, 1200);
  out.graph_gain0 = await measureGraph(0, 1200);
  log("graph-done", out.graph_gain1, out.graph_gain2, out.graph_gain0);

  // 4. last hop: hand the graph output to the element and measure what the
  //    ELEMENT renders (captureStream = the element's own output).
  el2.srcObject = dest.stream;
  await el2.play();
  await sleep(500);
  out.element_swapped = el2.srcObject === dest.stream;
  out.element_playing_after_swap = !el2.paused;

  const rendered = el2.captureStream();
  out.rendered_tracks = rendered.getAudioTracks().length;
  const measureElement = async (value, ms) => {
    gain.gain.value = value;
    await sleep(300);
    return tap(rendered, ms);
  };
  // The fake audio device emits a periodic beep (~1 s period), so the render
  // windows must span at least one full period to be comparable.
  out.rendered_gain1 = await measureElement(1, 1200);
  out.rendered_gain2 = await measureElement(2, 1200);
  out.rendered_gain0 = await measureElement(0, 1200);
  out.rendered_ratio =
    out.rendered_gain1 > 0
      ? Number((out.rendered_gain2 / out.rendered_gain1).toFixed(2))
      : null;
  log("element-render-done", out.rendered_gain1, out.rendered_gain2, out.rendered_gain0);

  return out;
};

// ---------------------------------------------------------------------------
// Driver: serve a local page (a secure context is required for getUserMedia),
// run PROBE in a real Chromium, then assert the measured behaviour.
// ---------------------------------------------------------------------------

console.log("PROBE: starting local page server");
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

// Never hang silently: the probe is a diagnostic, it must always report.
const watchdog = setTimeout(() => {
  console.error("PROBE TIMEOUT after 90s");
  process.exit(2);
}, 90000);

console.log("PROBE: launching chromium (system Edge channel, headless, fake mic)");
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--no-sandbox",
  ],
});

let out = null;
try {
  const page = await browser.newPage();
  page.on("console", (m) => console.log("[page]", m.text()));
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  console.log("PROBE: page loaded, running in-page probe");
  out = await page.evaluate(PROBE);
  console.log("PROBE: in-page probe finished");
} finally {
  await browser.close();
  server.close();
}

const near = (actual, expected, tolerance) => Math.abs(actual - expected) <= tolerance;
const checks = [
  ["control oscillator produces signal", out.control_peak > 0.05, out.control_peak],
  ["audio context is running", out.control_state === "running", out.control_state],
  [
    "REMOVED mechanism (createMediaElementSource) is silent",
    out.removed_MediaElementSource_peak === 0,
    `${out.removed_MediaElementSource_peak} (ctx ${out.removed_MediaElementSource_state})`,
  ],
  ["audio element plays the remote stream", out.element_playing === true, out.element_playing],
  ["stream tap carries audio", out.graph_gain1 > 0.05, out.graph_gain1],
  ["gain 200% doubles the graph signal", near(out.graph_gain2, 2 * out.graph_gain1, 0.4), out.graph_gain2],
  ["gain 0% mutes the graph", out.graph_gain0 === 0, out.graph_gain0],
  ["element keeps playing after the srcObject swap", out.element_playing_after_swap === true, out.element_swapped],
  ["element renders the graph output", out.rendered_gain1 > 0.05, `${out.rendered_gain1} (${out.rendered_tracks} track)`],
  ["element render scales with the boost", out.rendered_ratio !== null && near(out.rendered_ratio, 2, 0.6), out.rendered_ratio],
  ["element render at 0% is silent", out.rendered_gain0 === 0, out.rendered_gain0],
];

console.log(JSON.stringify(out, null, 2));
let failed = 0;
for (const [label, ok, detail] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  [${String(detail)}]`);
}
console.log(failed === 0 ? "\nAUDIO BOOST PROBE: PASS" : `\nAUDIO BOOST PROBE: ${failed} FAILED`);
clearTimeout(watchdog);
process.exit(failed === 0 ? 0 : 1);

