// End-to-end check against a running Nakama with the plugin loaded.
//   NAKAMA_HOST=127.0.0.1 NAKAMA_PORT=7350 node scripts/e2e.mjs
// Bots log in, pick cults, join compounds, act, defect, and (with
// WAIT_RESET=1 and a short DAY_SECONDS) wait for the Day to end and reset.
import { Client } from "@heroiclabs/nakama-js";
import { encode, decode } from "@msgpack/msgpack";
import { layout } from "../apps/web/src/minigame/core.ts";

const host = process.env.NAKAMA_HOST || "127.0.0.1";
const port = process.env.NAKAMA_PORT || "7350";
const key = process.env.NAKAMA_SERVER_KEY || "defaultkey";
const BOTS = Number(process.env.BOTS || 6);
const waitReset = process.env.WAIT_RESET === "1";

const OP = { MOVE: 1, KNEEL: 2, RISE: 3, RITUAL: 4, ACT: 10, DEFECT_ACT: 11, ACT_START: 13, ACT_FINISH: 14, SNAPSHOT: 20, JOINED: 21, WALK: 23, POSE: 24, CONVERGENCE: 26, ACT_RESULT: 30, WORLD: 31, DAY_ENDED: 33, ACT_CHALLENGE: 34 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };

async function rpc(client, session, id, body = {}) {
  const r = await client.rpc(session, id, body);
  return r.payload;
}

async function bot(i, cultIds) {
  const client = new Client(key, host, port, false);
  const session = await client.authenticateDevice(`e2e-device-${Date.now()}-${i}`, true);
  const hello = await rpc(client, session, "hello", { protocol: 1, client: "1.0.0", ui: 1 });
  const socket = client.createSocket(false, false);
  await socket.connect(session, true);
  const b = { i, client, session, socket, hello, msgs: {}, results: [], world: null, ended: null };
  socket.onmatchdata = (m) => {
    const data = m.data && m.data.length ? decode(m.data) : null;
    b.msgs[m.op_code] = (b.msgs[m.op_code] || 0) + 1;
    if (m.op_code === OP.ACT_RESULT) b.results.push(data);
    if (m.op_code === OP.WORLD) b.world = data;
    if (m.op_code === OP.SNAPSHOT) b.snapshot = data;
    if (m.op_code === OP.DAY_ENDED) b.ended = data;
    if (m.op_code === OP.ACT_CHALLENGE) b.challenge = data;
  };
  b.cult = cultIds[i % cultIds.length];
  return b;
}

async function main() {
  const probe = new Client(key, host, port, false);
  const s0 = await probe.authenticateDevice(`e2e-probe-${Date.now()}`, true);
  const h = await rpc(probe, s0, "hello", { protocol: 1, client: "1.0.0", ui: 1 });
  check(h.packs?.length === 3, `hello lists ${h.packs?.length} packs, day ${h.dayId}, name "${h.name}"`);
  const pack = await rpc(probe, s0, "get_pack", { id: h.packs[0].id });
  check(pack.manifest?.id === h.packs[0].id && pack.strings?.name, `get_pack returns ${pack.strings?.name}`);
  const day = await rpc(probe, s0, "get_day");
  check(day.world?.cults?.length === 3 && day.world.phase === "live", `get_day: ${day.world?.cults?.map((c) => c.id).join(", ")}`);

  const ids = h.packs.map((p) => p.id);
  const bots = await Promise.all(Array.from({ length: BOTS }, (_, i) => bot(i, ids)));
  for (const b of bots) {
    const j = await rpc(b.client, b.session, "join_cult", { cultId: b.cult });
    b.match = await b.socket.joinMatch(j.matchId);
    b.matchId = j.matchId;
  }
  check(new Set(bots.map((b) => b.matchId)).size === ids.length, "bots of the same cult share a room");
  try {
    await rpc(bots[0].client, bots[0].session, "join_cult", { cultId: ids[1] });
    check(false, "second pick should be refused");
  } catch (e) {
    check(true, "second pick of a different cult is refused (pick locked)");
  }
  await sleep(1500);
  check(bots.every((b) => b.snapshot && b.world), "every bot got SNAPSHOT and WORLD");

  // Walk and kneel.
  const b0 = bots[0];
  const mat = b0.snapshot.mats[0];
  b0.socket.sendMatchState(b0.matchId, OP.MOVE, encode({ x: mat.x, y: mat.y }));
  await sleep(6000);
  b0.socket.sendMatchState(b0.matchId, OP.KNEEL, encode({ mat: mat.id }));
  await sleep(500);
  const peer = bots.find((b) => b !== b0 && b.cult === b0.cult);
  check(peer && peer.msgs[OP.WALK] >= 1 && peer.msgs[OP.POSE] >= 1, "room-mate saw WALK and POSE");

  // Everyone acts: 10 recruits each (1 energy).
  const before = Object.fromEntries(bots[0].world.cults.map((c) => [c.id, (c.progress || 0) + (c.stats.followers || 0)]));
  for (let k = 0; k < 10; k++) {
    for (const b of bots) b.socket.sendMatchState(b.matchId, OP.ACT, encode({ actionId: "recruit", clientSeq: k + 1 }));
    await sleep(250);
  }
  await sleep(2500);
  const okCount = bots.reduce((n, b) => n + b.results.filter((r) => r.ok).length, 0);
  check(okCount === BOTS * 10, `accepted ${okCount}/${BOTS * 10} actions`);
  check(bots[0].results.at(-1)?.energy === 2, `energy left after 10 actions: ${bots[0].results.at(-1)?.energy}`);
  const conv = bots.reduce((n, b) => n + (b.msgs[OP.CONVERGENCE] || 0), 0);
  check(BOTS / ids.length < 3 || conv > 0, `convergence messages: ${conv}`);
  const after = Object.fromEntries(bots[0].world.cults.map((c) => [c.id, (c.progress || 0) + (c.stats.followers || 0)]));
  check(ids.every((id) => after[id] > before[id]), "every cult's followers rose in the world snapshot");

  // Mini game rounds: the server seeds the round and scores raw inputs.
  const packs = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, (await rpc(probe, s0, "get_pack", { id })).manifest])));
  const devote = (b) => packs[b.cult].actions.find((a) => a.slot === "devote");
  check(ids.every((id) => packs[id].actions.filter((a) => a.slot).length === 3), "every pack has three slotted actions");
  const startRound = async (b, seq) => {
    b.challenge = null;
    b.socket.sendMatchState(b.matchId, OP.ACT_START, encode({ actionId: devote(b).id, clientSeq: seq }));
    await sleep(700);
    return b.challenge;
  };
  const [p1, p2, p3] = [bots[1], bots[2], bots[3 % BOTS]];
  const c1 = await startRound(p1, 300);
  check(c1 && c1.game === devote(p1).game && c1.nonce, `round handed out: ${c1?.game} seed ${c1?.seed}`);
  const c2 = await startRound(p2, 301);
  const forged = layout(c2.game, c2.seed);
  // p2 claims perfect beats at once: the inputs are later than the server's clock allows.
  p2.socket.sendMatchState(p2.matchId, OP.ACT_FINISH, encode({ nonce: c2.nonce, inputs: (forged.beats ?? [0]).map((t) => ({ t })) }));
  const c3 = await startRound(p3, 302);
  const l1 = layout(c1.game, c1.seed);
  await sleep(l1.lengthMs);
  p1.socket.sendMatchState(p1.matchId, OP.ACT_FINISH, encode({ nonce: c1.nonce, inputs: l1.beats.map((t) => ({ t })) }));
  await sleep(1500);
  const r1 = p1.results.find((r) => r.clientSeq === 300), r2 = p2.results.find((r) => r.clientSeq === 301);
  check(r1?.ok && r1.quality === 1 && r1.grades?.every((g) => g === 1), `perfect round scored ${r1?.quality} (${r1?.grades})`);
  check(r2?.ok && r2.quality === 0.5, `forged-clock round scored as a skip: ${r2?.quality}`);
  await sleep(15500);
  const r3 = p3.results.find((r) => r.clientSeq === 302);
  check(r3?.ok && r3.quality === 0.5, `unfinished round expired as a skip: ${r3?.quality}`);

  // Defect, then a defector action (uses the last energy points).
  const d = await rpc(b0.client, b0.session, "defect");
  check(d.defected === true, "defect after 10 actions");
  b0.socket.sendMatchState(b0.matchId, OP.DEFECT_ACT, encode({ actionId: "gather_evidence", clientSeq: 200 }));
  await sleep(1500);
  check(b0.results.some((r) => r.clientSeq === 200 && r.ok && r.evidence === 1), "gather evidence accepted");
  b0.socket.sendMatchState(b0.matchId, OP.ACT, encode({ actionId: "recruit", clientSeq: 201 }));
  await sleep(800);
  check(b0.results.some((r) => r.clientSeq === 201 && r.reason === "defected"), "a defector cannot act for the cult");
  // A defector's actions also play a mini game round.
  b0.challenge = null;
  b0.socket.sendMatchState(b0.matchId, OP.ACT_START, encode({ actionId: "call_family", clientSeq: 202 }));
  await sleep(700);
  check(b0.challenge?.game === "beat", `defector round handed out: ${b0.challenge?.game}`);
  if (b0.challenge) b0.socket.sendMatchState(b0.matchId, OP.ACT_FINISH, encode({ nonce: b0.challenge.nonce, inputs: [], skip: true }));
  await sleep(1500);
  check(b0.results.some((r) => r.clientSeq === 202 && r.ok && r.quality === 0.5), "defector round (skipped) accepted");

  // Energy runs out (cooldown on gather is 20 s, so use the journalist refusal and energy).
  for (let k = 0; k < 3; k++) peer.socket.sendMatchState(peer.matchId, OP.ACT, encode({ actionId: "recruit", clientSeq: 400 + k }));
  await sleep(1500);
  check(peer.results.some((r) => r.reason === "no_energy"), "out of energy is refused");
  const w = await rpc(b0.client, b0.session, "get_day");
  const mine = w.world.cults.find((c) => c.id === b0.cult);
  check(mine.defectors === 1 && mine.stats.exposure > 0, `defectors ${mine.defectors}, exposure ${mine.stats.exposure}`);

  // Reconnect: rejoin the room.
  const jr = await rpc(peer.client, peer.session, "join_room");
  check(jr.matchId === peer.matchId, "join_room returns the same room");

  if (waitReset) {
    const endsAt = w.world.endsAt;
    const waitMs = (endsAt - w.world.serverTime) * 1000 + 4000;
    console.log(`waiting ${Math.round(waitMs / 1000)} s for the Day to end...`);
    await sleep(waitMs);
    check(bots.some((b) => b.ended), `DAY_ENDED received: ${JSON.stringify(bots.find((b) => b.ended)?.ended)}`);
    const sum = await rpc(b0.client, b0.session, "get_summary", { dayId: w.world.dayId });
    check(!!sum.summary?.headline, `summary: "${sum.summary?.headline}"; you: ${JSON.stringify(sum.you)}`);
    const arch = await rpc(b0.client, b0.session, "list_archive");
    check(arch.days.some((x) => x.dayId === w.world.dayId), `archive lists ${arch.days.length} Day(s)`);
    const next = await rpc(b0.client, b0.session, "get_day");
    check(next.world.dayId !== w.world.dayId && next.world.phase === "live" && !next.player, `next Day ${next.world.dayId} opened fresh`);
  }

  for (const b of bots) b.socket.disconnect(false);
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
