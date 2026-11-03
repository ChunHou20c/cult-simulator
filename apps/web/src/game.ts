// Game flow: hello, lobby, joining a compound, and turning match messages
// into store updates. No game rules live here; the server decides.
import { OP, PROTOCOL, CLIENT_VERSION, UI_VERSION, login, rpc, joinMatch, leaveMatch, send, setHandlers } from "./net";
import { loadPack, type PackInfo } from "./packs";
import { S, useStore, type Avatar, type World } from "./store";
import type { Input } from "./minigame/core";

let seq = 0;
let lobbyTimer: number | undefined;

export async function start() {
  const set = S().set;
  try {
    await login();
    const h = await rpc<any>("hello", { protocol: PROTOCOL, client: CLIENT_VERSION, ui: UI_VERSION });
    if (h.updateNeeded) {
      set({ error: "A new version is available. Reload to update." });
      return;
    }
    set({ name: h.name, userId: h.userId, engine: h.engine, shared: h.sharedActions ?? [], packInfo: h.packs });
    await Promise.all((h.packs as PackInfo[]).map(async (p) => {
      const pack = await loadPack(p);
      S().set({ packs: { ...S().packs, [p.id]: pack } });
    }));
    setHandlers(onMessage, onDisconnect);
    await refreshDay();
    const { player, world } = S();
    if (player && world?.phase === "live") await enterCompound();
    else set({ screen: world?.phase === "concluded" && player ? "end" : "lobby" });
    pollLobby();
  } catch (e: any) {
    set({ error: e?.message || "Could not reach the server." });
  }
}

export async function refreshDay() {
  const r = await rpc<{ world: World; player?: any }>("get_day");
  const prev = S().world;
  S().set({ world: r.world, player: r.player, clockSkew: r.world.serverTime * 1000 - Date.now() });
  if (r.player) S().set({ energy: r.player.energy, energyAt: r.player.energyAt });
  if (prev && prev.dayId !== r.world.dayId && S().screen !== "end" && S().screen !== "summary") {
    // A new Day opened: everyone picks again.
    S().set({ screen: "lobby", dayEnded: undefined });
  }
}

function pollLobby() {
  window.clearInterval(lobbyTimer);
  // The compound gets WORLD pushes; the lobby polls the cheap snapshot RPC.
  lobbyTimer = window.setInterval(() => {
    const sc = S().screen;
    if (sc === "lobby" || sc === "end" || sc === "summary" || sc === "archive" || sc === "codex") refreshDay().catch(() => {});
  }, 5000);
}

export async function pickCult(cultId: string) {
  const r = await rpc<any>("join_cult", { cultId });
  S().set({ player: r.player, energy: r.player.energy, energyAt: r.player.energyAt });
  await enterRoom(r.matchId);
}

export async function enterCompound() {
  const r = await rpc<any>("join_room");
  S().set({ player: r.player });
  await enterRoom(r.matchId);
}

async function enterRoom(matchId: string) {
  S().set({ avatars: {}, pending: [], screen: "compound" });
  await joinMatch(matchId);
}

export async function backToLobby() {
  await leaveMatch();
  S().set({ screen: "lobby" });
  await refreshDay();
}

export function act(actionId: string, defector = false) {
  const s = ++seq;
  S().set({ pending: [...S().pending, { seq: s, action: actionId }] });
  send(defector ? OP.DEFECT_ACT : OP.ACT, { actionId, clientSeq: s });
  // If the server never answers (socket dropped), clear the spinner.
  window.setTimeout(() => S().set({ pending: S().pending.filter((p) => p.seq !== s) }), 8000);
}

/** Starts an action's mini game round; the server answers with ACT_CHALLENGE. */
export function actStart(actionId: string) {
  const s = ++seq;
  S().set({ pending: [...S().pending, { seq: s, action: actionId }] });
  send(OP.ACT_START, { actionId, clientSeq: s });
  // No challenge and no result (socket dropped): clear the spinner. A round
  // in play keeps its spinner until the result arrives.
  window.setTimeout(() => {
    if (S().round?.seq !== s) S().set({ pending: S().pending.filter((p) => p.seq !== s) });
  }, 8000);
}

/** Sends a round's raw inputs (or a skip). The server scores them. */
export function finishRound(inputs: Input[], skip = false) {
  const r = S().round;
  if (!r) return;
  S().set({ round: undefined });
  send(OP.ACT_FINISH, { nonce: r.nonce, inputs: skip ? [] : inputs, skip });
  const s = r.seq;
  window.setTimeout(() => S().set({ pending: S().pending.filter((p) => p.seq !== s) }), 8000);
}

export function walkTo(x: number, y: number) {
  const st = S();
  const me = st.you && st.avatars[st.you];
  if (me) {
    // Local prediction; the server's WALK or CORRECTION settles it.
    const now = Date.now() + st.clockSkew;
    const [cx, cy] = avatarPos(me, now);
    st.set({ avatars: { ...st.avatars, [me.id]: { ...me, fx: cx, fy: cy, tx: x, ty: y, t0: now, pose: "stand", mat: undefined } } });
  }
  send(OP.MOVE, { x, y });
}

export function kneel(mat: string) { send(OP.KNEEL, { mat }); }
export function rise() { send(OP.RISE, {}); }
export function ritual(id: string) { send(OP.RITUAL, { ritual: id }); }

export async function defect() {
  const pd = await rpc<any>("defect");
  S().set({ player: { ...S().player!, ...pd } });
}

export async function switchCult(cultId: string) {
  await rpc<any>("switch_cult", { cultId });
  // The old room kicks us; join the new cult's room.
  await leaveMatch();
  await enterCompound();
}

export const WALK_SPEED = 140; // px/s, same as the server

export function avatarPos(a: Avatar, nowMs: number): [number, number] {
  const d = Math.hypot(a.tx - a.fx, a.ty - a.fy);
  if (d === 0) return [a.tx, a.ty];
  // Clamp to the start: the local clock can lag the server's by the network
  // delay, so a fresh WALK's t0 may still be "in the future" here. Without
  // the clamp, f goes negative and the avatar is drawn behind its start point,
  // i.e. it jumps the opposite way before walking back.
  const f = Math.max(0, ((nowMs - a.t0) / 1000) * WALK_SPEED / d);
  if (f >= 1) return [a.tx, a.ty];
  return [a.fx + (a.tx - a.fx) * f, a.fy + (a.ty - a.fy) * f];
}

function toAvatar(v: any): Avatar {
  return { id: v.id, name: v.name, fx: v.x, fy: v.y, tx: v.tx ?? v.x, ty: v.ty ?? v.y, t0: v.t0 ?? 0, pose: v.pose || "stand", mat: v.mat || undefined, defected: v.defected };
}

function onMessage(op: number, d: any) {
  const st = useStore.getState();
  const set = st.set;
  switch (op) {
    case OP.SNAPSHOT: {
      const avatars: Record<string, Avatar> = {};
      for (const p of d.players ?? []) avatars[p.id] = toAvatar(p);
      avatars[d.you] = toAvatar(d.self);
      const layout = { width: d.width, height: d.height, mats: d.mats, spawn: [] as [number, number][] };
      set({ you: d.you, avatars, layout, energy: d.energy, energyAt: d.energyAt, cooldowns: d.cooldowns ?? {}, player: d.player, clockSkew: d.serverTime - Date.now() });
      break;
    }
    case OP.JOINED:
      set({ avatars: { ...st.avatars, [d.id]: toAvatar(d) } });
      break;
    case OP.LEFT: {
      const { [d.id]: _gone, ...rest } = st.avatars;
      set({ avatars: rest });
      break;
    }
    case OP.WALK: {
      const a = st.avatars[d.id];
      // Our own move echoed back: we already predicted it locally, so keep
      // the prediction rather than restart the walk from the server's view.
      if (a && d.id === st.you && Math.abs(a.tx - d.tx) < 0.5 && Math.abs(a.ty - d.ty) < 0.5) break;
      if (a) set({ avatars: { ...st.avatars, [d.id]: { ...a, fx: d.fx, fy: d.fy, tx: d.tx, ty: d.ty, t0: d.t0, pose: "stand", mat: undefined } } });
      break;
    }
    case OP.POSE: {
      const a = st.avatars[d.id];
      if (a) {
        const at = d.x !== undefined ? { fx: d.x, fy: d.y, tx: d.x, ty: d.y, t0: 0 } : {};
        set({ avatars: { ...st.avatars, [d.id]: { ...a, ...at, pose: d.pose, mat: d.mat || undefined } } });
      }
      break;
    }
    case OP.CORRECTION: {
      const a = st.you && st.avatars[st.you];
      if (a) set({ avatars: { ...st.avatars, [a.id]: { ...a, fx: d.x, fy: d.y, tx: d.x, ty: d.y, t0: 0, pose: d.pose, mat: d.mat || undefined } } });
      break;
    }
    case OP.RITUAL_SEEN: {
      const a = st.avatars[d.id];
      if (a) set({ avatars: { ...st.avatars, [d.id]: { ...a, ritual: { id: d.ritual, at: Date.now() } } } });
      break;
    }
    case OP.ACT_SEEN: {
      const a = st.avatars[d.id];
      if (a) set({ avatars: { ...st.avatars, [d.id]: { ...a, act: { id: d.action, at: Date.now() } } } });
      break;
    }
    case OP.ACT_CHALLENGE:
      set({ round: { seq: d.clientSeq, nonce: d.nonce, seed: d.seed, game: d.game, action: d.action, at: performance.now() } });
      break;
    case OP.CONVERGENCE:
      set({ convergence: { key: d.key, at: Date.now() } });
      break;
    case OP.ACT_RESULT: {
      const p = st.pending.find((x) => x.seq === d.clientSeq);
      const player = st.player ? { ...st.player, evidence: d.evidence, actions: d.actions, contribution: d.contribution } : st.player;
      if (d.reason === "defected" && player) player.defected = true;
      set({
        pending: st.pending.filter((x) => x.seq !== d.clientSeq),
        energy: d.energy, energyAt: d.energyAt, cooldowns: d.cooldowns ?? {}, player,
        lastResult: p ? { action: p.action, ok: d.ok, reason: d.reason, deltas: d.deltas, quality: d.quality, grades: d.grades, at: Date.now() } : st.lastResult,
      });
      break;
    }
    case OP.WORLD:
      // WORLD's serverTime is whole seconds; the compound SNAPSHOT already set
      // a millisecond clock skew, so don't overwrite it with a coarser one.
      set({ world: d });
      break;
    case OP.DAY_ENDED:
      set({ dayEnded: d });
      if (d.reset) {
        // The next Day has opened; show the old Day's end card first.
        set({ screen: "end" });
        refreshDay().catch(() => {});
      } else {
        set({ screen: "end" });
      }
      break;
  }
}

async function onDisconnect() {
  // Rejoin automatically if we were in a compound.
  if (S().screen !== "compound") return;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000 * Math.min(8, 2 ** i)));
    try {
      await refreshDay();
      if (S().player && S().world?.phase === "live") await enterCompound();
      return;
    } catch {
      /* keep trying */
    }
  }
}
