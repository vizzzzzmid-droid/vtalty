import WebSocket from "ws";
import { AudioSource, LocalAudioTrack, Room, TrackPublishOptions, TrackSource } from "@livekit/rtc-node";

const API = "http://127.0.0.1:3000";

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function main() {
  const suffix = Date.now().toString(36);
  const reg = await api("POST", "/api/v1/auth/register", {
    body: { username: `muter${suffix}`, password: "password-123" },
  });
  console.log("register:", reg.status);
  const token = reg.json.accessToken;
  const servers = (await api("GET", "/api/v1/servers", { token })).json;
  const serverId = servers[0].id;
  const state = (await api("GET", `/api/v1/servers/${serverId}/state`, { token })).json;
  const voiceId = state.channels.find((c) => c.type === "voice").id;

  // WS connect via ticket.
  const ticket = (await api("POST", "/api/v1/ws-ticket", { token })).json.ticket;
  const socket = new WebSocket(`ws://127.0.0.1:3000/ws?ticket=${encodeURIComponent(ticket)}`);
  const events = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no open in 5s")), 5000);
    socket.on("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.on("error", reject);
  });
  socket.on("message", (data) => {
    try {
      events.push(JSON.parse(String(data)));
    } catch { /* ignore */ }
  });
  socket.send(JSON.stringify({ type: "client.hello", lastSeq: 0 }));

  // LiveKit join (makes us a participant for flag intents).
  const vt = (await api("POST", `/api/v1/channels/${voiceId}/voice-token`, { token })).json;
  const room = new Room();
  await room.connect("ws://127.0.0.1:7880", vt.token, { autoSubscribe: true, dynacast: true });
  const source = new AudioSource(16000, 1);
  const track = LocalAudioTrack.createAudioTrack("audio", source);
  const options = new TrackPublishOptions();
  options.source = TrackSource.SOURCE_MICROPHONE;
  await room.localParticipant.publishTrack(track, options);
  await new Promise((r) => setTimeout(r, 3000));

  // Send mute intent like the web client does.
  socket.send(JSON.stringify({ type: "voice.state.update", channelId: voiceId, muted: true, deafened: false }));
  await new Promise((r) => setTimeout(r, 2000));
  const voiceEvents = events.filter((e) => e.type === "voice.state");
  console.log("voice.state events:", JSON.stringify(voiceEvents).slice(0, 600));
  const last = voiceEvents[voiceEvents.length - 1];
  const me = last?.data?.participants?.find((p) => p.userId === reg.json.user.id);
  console.log("my seat:", JSON.stringify(me));
  await room.disconnect();
  socket.close();
  process.exit(0);
}

main().catch((err) => {
  console.log("FAILED:", err);
  process.exit(1);
});
