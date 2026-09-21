import {
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  WS_PATH,
  wsEnvelopeSchema,
  wsServerEventSchema,
} from "@vitality/shared";
import { queryClient } from "../api/queryClient.js";
import { requestWsTicket } from "../api/resources.js";
import { usePresenceStore } from "../store/presence.js";

let socket: WebSocket | null = null;
let lastSeq = 0;
let attempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;

function delay(): number {
  const backoff = Math.min(
    RECONNECT_BASE_DELAY_MS * 2 ** attempts,
    RECONNECT_MAX_DELAY_MS,
  );
  return backoff + Math.random() * 500;
}

function scheduleReconnect(): void {
  if (!running) {
    return;
  }
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
  }
  attempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void openSocket();
  }, delay());
}

function handleFrame(raw: string): void {
  const envelope = wsEnvelopeSchema.safeParse(unknownJson(raw));
  if (!envelope.success) {
    return;
  }
  if (envelope.data.seq > lastSeq) {
    lastSeq = envelope.data.seq;
  }
  const event = wsServerEventSchema.safeParse(envelope.data);
  if (!event.success) {
    return;
  }
  const { applyPresence, applyTyping } = usePresenceStore.getState();
  switch (event.data.type) {
    case "server.ready":
      break;
    case "presence.update":
      applyPresence(event.data.data.userId, event.data.data.status);
      break;
    case "typing.start":
      applyTyping(event.data.data.channelId, event.data.data.userId);
      break;
    default:
      // Channel/member/category/voice/message events: refetch snapshots.
      // Server-level fan-out is cheap at this scale and always consistent.
      void queryClient.invalidateQueries({ queryKey: ["state"] });
      void queryClient.invalidateQueries({ queryKey: ["servers"] });
      break;
  }
}

function unknownJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

async function openSocket(): Promise<void> {
  if (!running) {
    return;
  }
  // Fresh single-use ticket per (re)connect; the access JWT never appears
  // in the URL. requestWsTicket refreshes the session transparently.
  let ticket: string;
  try {
    ticket = await requestWsTicket();
  } catch {
    scheduleReconnect();
    return;
  }
  if (!running) {
    return;
  }
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const url = `${protocol}://${window.location.host}${WS_PATH}?ticket=${encodeURIComponent(ticket)}`;
  const next = new WebSocket(url);
  socket = next;

  next.onopen = () => {
    attempts = 0;
    next.send(JSON.stringify({ type: "client.hello", lastSeq }));
    // Refetch missed state on every (re)connect; live events apply after.
    void queryClient.invalidateQueries({ queryKey: ["state"] });
    void queryClient.invalidateQueries({ queryKey: ["servers"] });
  };
  next.onmessage = (msg) => {
    if (typeof msg.data === "string") {
      handleFrame(msg.data);
    }
  };
  next.onclose = () => {
    if (socket === next) {
      socket = null;
      scheduleReconnect();
    }
  };
  next.onerror = () => {
    next.close();
  };
}

/** Connect the gateway (call after login/boot; uses the stored session). */
export function connectSocket(): void {
  running = true;
  attempts = 0;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket !== null) {
    const old = socket;
    socket = null;
    old.close();
  }
  void openSocket();
}

export function disconnectSocket(): void {
  running = false;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket !== null) {
    const old = socket;
    socket = null;
    old.close();
  }
  usePresenceStore.getState().reset();
}
