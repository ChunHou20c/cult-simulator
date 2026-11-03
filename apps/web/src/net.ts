// Networking: device login, RPCs, one WebSocket, MessagePack match messages.
// The client only ever sends ids and tap targets, never amounts.
import { Client, Session, type Socket, type MatchData } from "@heroiclabs/nakama-js";
import { encode, decode } from "@msgpack/msgpack";

export const PROTOCOL = 1;
export const CLIENT_VERSION = "1.0.0";
export const UI_VERSION = 1;

export const OP = {
  MOVE: 1, KNEEL: 2, RISE: 3, RITUAL: 4, ACT: 10, DEFECT_ACT: 11, HEARTBEAT: 12,
  SNAPSHOT: 20, JOINED: 21, LEFT: 22, WALK: 23, POSE: 24, RITUAL_SEEN: 25, CONVERGENCE: 26, ACT_SEEN: 27,
  ACT_RESULT: 30, WORLD: 31, EVENT: 32, DAY_ENDED: 33, CORRECTION: 40,
} as const;

// Runtime config (public/config.js, rewritten by the web container at start)
// wins over build-time VITE_* values, so one image works for any server.
type RuntimeConfig = { nakamaHost?: string; nakamaPort?: string; nakamaSsl?: string; nakamaKey?: string };
const rt: RuntimeConfig = (globalThis as { __CS_CONFIG__?: RuntimeConfig }).__CS_CONFIG__ ?? {};
const env = import.meta.env;
const ssl = rt.nakamaSsl || env.VITE_NAKAMA_SSL;
const secure = ssl ? ssl === "true" : location.protocol === "https:";
const host = rt.nakamaHost || env.VITE_NAKAMA_HOST || location.hostname;
const port = rt.nakamaPort || env.VITE_NAKAMA_PORT || (secure ? "443" : "7350");
const serverKey = rt.nakamaKey || env.VITE_NAKAMA_KEY || "defaultkey";

export const client = new Client(serverKey, host, port, secure);

function store(key: string, value?: string): string | null {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key);
  } catch {
    return value ?? null;
  }
}

function deviceId(): string {
  let id = store("cs.device");
  if (!id) id = store("cs.device", crypto.randomUUID()) ?? crypto.randomUUID();
  return id;
}

let session: Session | null = null;
let socket: Socket | null = null;
let heartbeat: number | undefined;
let currentMatch: string | null = null;

export async function login(): Promise<Session> {
  const saved = store("cs.session");
  const refresh = store("cs.refresh");
  if (saved && refresh) {
    const s = Session.restore(saved, refresh);
    const now = Date.now() / 1000;
    if (!s.isexpired(now + 60)) return (session = s);
    if (!s.isrefreshexpired(now + 60)) {
      try {
        const r = await client.sessionRefresh(s);
        store("cs.session", r.token);
        store("cs.refresh", r.refresh_token);
        return (session = r);
      } catch {
        /* fall through to a fresh login */
      }
    }
  }
  const s = await client.authenticateDevice(deviceId(), true);
  store("cs.session", s.token);
  store("cs.refresh", s.refresh_token);
  return (session = s);
}

export async function rpc<T = any>(id: string, body: object = {}): Promise<T> {
  if (!session) await login();
  try {
    const r = await client.rpc(session!, id, body);
    return r.payload as T;
  } catch (e: any) {
    // nakama-js rejects with the fetch Response; surface the server message.
    if (e && typeof e.json === "function") {
      const j = await e.json().catch(() => null);
      throw new Error(j?.message || `rpc ${id} failed`);
    }
    throw e;
  }
}

export type Handler = (op: number, data: any) => void;
let handler: Handler = () => {};
let onDisconnect: () => void = () => {};

export function setHandlers(h: Handler, disconnected: () => void) {
  handler = h;
  onDisconnect = disconnected;
}

export async function connect(): Promise<Socket> {
  if (socket) return socket;
  if (!session) await login();
  const s = client.createSocket(secure, false);
  s.onmatchdata = (m: MatchData) => {
    const data = m.data && m.data.length ? decode(m.data) : null;
    handler(m.op_code, data);
  };
  s.ondisconnect = () => {
    socket = null;
    currentMatch = null;
    window.clearInterval(heartbeat);
    onDisconnect();
  };
  await s.connect(session!, true);
  // Cloudflare drops idle WebSockets after ~100 s.
  heartbeat = window.setInterval(() => send(OP.HEARTBEAT, {}), 30_000);
  return (socket = s);
}

export async function joinMatch(matchId: string) {
  const s = await connect();
  if (currentMatch && currentMatch !== matchId) {
    await s.leaveMatch(currentMatch).catch(() => {});
  }
  await s.joinMatch(matchId);
  currentMatch = matchId;
}

export async function leaveMatch() {
  if (socket && currentMatch) await socket.leaveMatch(currentMatch).catch(() => {});
  currentMatch = null;
}

export function send(op: number, data: object) {
  if (!socket || !currentMatch) return;
  socket.sendMatchState(currentMatch, op, encode(data)).catch(() => {});
}
