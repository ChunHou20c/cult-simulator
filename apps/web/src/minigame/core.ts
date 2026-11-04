// Mirror of server/minigame: the same seeded layouts and grading, so the
// client can draw a round and show Perfect or Miss the moment you tap. The
// server re-scores the raw inputs itself and its number is the one applied.
// Keep the two in step; scripts/check-minigame.mjs compares golden values.

export type GameId = "flick" | "timing" | "beat" | "snuff";
export const CATALOG: GameId[] = ["flick", "timing", "beat", "snuff"];

export interface Input { t: number; x?: number; y?: number }
export interface Stranger { y: number; x0: number; dir: number; speed: number; start: number }
export interface Zone { c: number; w: number }
export interface Candle { x: number; y: number; start: number; burnMs: number }
export interface Layout { game: GameId; lengthMs: number; strangers?: Stranger[]; zones?: Zone[]; periodMs?: number; beats?: number[]; candles?: Candle[] }

export const SKIP_QUALITY = 0.5;
export const MISS = 0, GOOD = 0.6, PERFECT = 1;
export const FLICK_X = 0.5, FLICK_Y = 0.92, FLICK_SPEED = 1.8;
const GAP: Record<GameId, number> = { flick: 250, timing: 200, beat: 80, snuff: 60 };
export const SNUFF_SPOTS = 6, SNUFF_LIGHTS = 6, SNUFF_RING = 0.32, SNUFF_REACH = 0.12, SNUFF_BURN_MS = 1300;

export const gain = (q: number) => 0.6 + 0.8 * clamp01(q);
export const heat = (q: number) => 1.3 - 0.6 * clamp01(q);

/** mulberry32, identical to the Go version (uint32 arithmetic). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ ((t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0)) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function layout(game: GameId, seed: number): Layout {
  const r = rng(seed);
  if (game === "flick") {
    const strangers: Stranger[] = [];
    for (let k = 0; k < 3; k++) {
      const dir = r() < 0.5 ? -1 : 1;
      strangers.push({ y: 0.22 + 0.16 * k, x0: dir < 0 ? 1.1 : -0.1, dir, speed: 0.45 + 0.2 * r(), start: 300 + 1300 * k });
    }
    return { game, strangers, lengthMs: strangers[2].start + 2600 };
  }
  if (game === "timing") {
    const zones = [0.13, 0.11, 0.09].map((w) => ({ c: 0.2 + 0.6 * r(), w }));
    return { game, zones, periodMs: 1600, lengthMs: 5500 };
  }
  if (game === "snuff") {
    const candles: Candle[] = [];
    let prev = -1, at = 500;
    for (let k = 0; k < SNUFF_LIGHTS; k++) {
      // A different spot from the last one, so two in a row never stack.
      let spot = Math.trunc(r() * (SNUFF_SPOTS - 1));
      if (spot >= prev && prev >= 0) spot++;
      prev = spot;
      const ang = (spot / SNUFF_SPOTS) * 2 * Math.PI - Math.PI / 2;
      candles.push({ x: 0.5 + SNUFF_RING * Math.cos(ang), y: 0.5 + SNUFF_RING * Math.sin(ang), start: at, burnMs: SNUFF_BURN_MS });
      at += 520 + 260 * r();
    }
    const last = candles[SNUFF_LIGHTS - 1];
    return { game, candles, lengthMs: last.start + last.burnMs + 300 };
  }
  const interval = 500 + Math.floor(r() * 5) * 40;
  const beats = Array.from({ length: 6 }, (_, j) => 1200 + j * interval);
  return { game, beats, lengthMs: beats[5] + 700 };
}

export function needle(periodMs: number, t: number): number {
  const ph = (t % periodMs) / periodMs;
  return ph < 0.5 ? ph * 2 : 2 - ph * 2;
}

export const strangerX = (s: Stranger, t: number) => s.x0 + (s.dir * s.speed * (t - s.start)) / 1000;

/** Where a flyer thrown at time t in direction (dx, dy) lands on a stranger's lane, and when. */
export function flyerAt(s: Stranger, i: Input): { x: number; at: number } | null {
  const n = Math.hypot(i.x ?? 0, i.y ?? 0);
  if (n === 0 || (i.y ?? 0) >= 0) return null;
  const dx = (i.x ?? 0) / n, dy = (i.y ?? 0) / n;
  const tt = (FLICK_Y - s.y) / (-dy * FLICK_SPEED);
  return { x: FLICK_X + dx * FLICK_SPEED * tt, at: i.t + tt * 1000 };
}

const band = (err: number, perfect: number, good: number) => (err <= perfect ? PERFECT : err <= good ? GOOD : MISS);

export function flickGrade(s: Stranger, i: Input): number {
  const f = flyerAt(s, i);
  if (!f || f.at < s.start) return MISS;
  return band(Math.abs(f.x - strangerX(s, f.at)), 0.05, 0.11);
}

export function timingGrade(l: Layout, k: number, t: number): number {
  const z = l.zones![k];
  return band(Math.abs(needle(l.periodMs!, t) - z.c), z.w * 0.4, z.w);
}

/** The lit, not yet snuffed candle a tap puts out (the nearest in reach), or -1. */
export function snuffHit(l: Layout, out: boolean[], i: Input): number {
  let best = -1, bestD = SNUFF_REACH;
  l.candles!.forEach((c, k) => {
    if (out[k] || i.t < c.start || i.t > c.start + c.burnMs) return;
    const d = Math.hypot((i.x ?? 0) - c.x, (i.y ?? 0) - c.y);
    if (d <= bestD) { best = k; bestD = d; }
  });
  return best;
}

export const snuffGrade = (c: Candle, t: number) => (t - c.start <= c.burnMs * 0.5 ? PERFECT : GOOD);

/** Drops inputs closer than the game's gap to the last kept one, like the server. */
export function spaced(game: GameId, inputs: Input[]): Input[] {
  const out: Input[] = [];
  for (const i of inputs) if (!out.length || i.t - out[out.length - 1].t >= GAP[game]) out.push(i);
  return out;
}

/** The server's score for a finished round (display only). */
export function score(game: GameId, seed: number, inputs: Input[]): { q: number; grades: number[] } {
  const l = layout(game, seed);
  const inp = spaced(game, inputs.filter((i) => i.t >= 0 && i.t <= l.lengthMs).sort((a, b) => a.t - b.t));
  if (game === "flick") {
    const grades = l.strangers!.map((s, k) => (k < inp.length ? flickGrade(s, inp[k]) : MISS));
    return { q: mean(grades), grades };
  }
  if (game === "timing") {
    const grades = l.zones!.map((_, k) => (k < inp.length ? timingGrade(l, k, inp[k].t) : MISS));
    return { q: mean(grades), grades };
  }
  if (game === "snuff") {
    const grades = l.candles!.map(() => 0);
    const out = l.candles!.map(() => false);
    let extra = 0;
    for (const i of inp) {
      const k = snuffHit(l, out, i);
      if (k < 0) { extra++; continue; }
      out[k] = true;
      grades[k] = snuffGrade(l.candles![k], i.t);
    }
    return { q: clamp01((grades.reduce((a, b) => a + b, 0) - 0.25 * extra) / grades.length), grades };
  }
  const beats = l.beats!;
  const grades = beats.map(() => 0);
  const used = beats.map(() => false);
  let extra = 0;
  for (const i of inp) {
    let best = -1, bestErr = 200;
    beats.forEach((b, j) => {
      const e = Math.abs(i.t - b);
      if (!used[j] && e <= bestErr) { best = j; bestErr = e; }
    });
    if (best < 0) { extra++; continue; }
    used[best] = true;
    grades[best] = band(bestErr, 60, 140);
  }
  return { q: clamp01((grades.reduce((a, b) => a + b, 0) - 0.5 * extra) / beats.length), grades };
}

function mean(v: number[]) { return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; }
function clamp01(v: number) { return Math.max(0, Math.min(1, v)); }
