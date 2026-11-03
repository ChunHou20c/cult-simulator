// Pack loader: turns any cult's manifest and strings into what the screens
// need. Packs come from their hashed asset URL when the server names one,
// otherwise from the get_pack RPC. Nothing here knows a specific cult.
import { rpc } from "./net";

export type Widget = "bar" | "counter" | "currency" | "months";

export interface StatDef { widget: Widget; label: string; min?: number; max?: number }
export type Slot = "recruit" | "work" | "devote";
export const SLOTS: Slot[] = ["recruit", "work", "devote"];
export interface ActionDef {
  id: string; energy?: number; cooldownSec?: number; requires?: string;
  /** Schema 1.1: which of the three icon buttons, its mini game and what the game shows. */
  slot?: Slot; game?: "flick" | "timing" | "beat"; skin?: { target?: string; item?: string; zone?: string };
}
export interface Manifest {
  id: string;
  version: string;
  schema: string;
  difficulty: string;
  theme?: { primary?: string; accent?: string; floor?: string };
  stats?: Record<string, StatDef>;
  goal: { progress: string; label: string };
  sharedActions?: string[];
  actions: ActionDef[];
  /** Movement per action id (or "ritual.<id>") for the 3D figure; see anim.ts. */
  animations?: Record<string, string>;
}
export interface Mat { id: string; x: number; y: number }
export interface CompoundLayout { width: number; height: number; mats: Mat[]; spawn: [number, number][] }

export interface Pack {
  id: string;
  hash: string;
  manifest: Manifest;
  strings: Record<string, string>;
  compound: CompoundLayout;
  codex: string;
  actions: string[]; // display order: enabled shared actions, then signature actions
  /** The cult's symbol as a data: URL (so WebGL can use it from any asset host), if the pack has one. */
  emblem?: string;
}

/** The pack's three slotted actions in slot order, or null for an older pack. */
export function slotted(pack: Pack): ActionDef[] | null {
  const by = SLOTS.map((s) => pack.manifest.actions.find((a) => a.slot === s));
  return by.every(Boolean) ? (by as ActionDef[]) : null;
}

export interface PackInfo { id: string; version: string; schema: string; hash: string; url: string; difficulty: string }

const SHARED = ["recruit", "fundraise", "ritual", "lie_low", "open_doors"];
const cache = new Map<string, Pack>();

async function fetchJSON(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

export async function loadPack(info: PackInfo): Promise<Pack> {
  const key = `${info.id}@${info.hash}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let pack: Pack;
  if (info.url) {
    const text = (rel: string) => fetch(info.url + rel).then((r) => (r.ok ? r.text() : "")).catch(() => "");
    const [manifest, strings, compound, codex, emblem] = await Promise.all([
      fetchJSON(info.url + "manifest.json"),
      fetchJSON(info.url + "strings/en.json"),
      fetchJSON(info.url + "compound.json").catch(() => null),
      text("codex/en.md"),
      text("emblem.svg"),
    ]);
    const shared = (manifest.sharedActions ?? SHARED) as string[];
    pack = {
      id: info.id, hash: info.hash, manifest, strings, codex, emblem: svgURL(emblem),
      compound: compound ?? defaultCompound(),
      actions: [...SHARED.filter((a) => shared.includes(a)), ...manifest.actions.map((a: ActionDef) => a.id)],
    };
  } else {
    const r = await rpc<any>("get_pack", { id: info.id });
    pack = { id: r.id, hash: r.hash, manifest: r.manifest, strings: r.strings, compound: r.compound, codex: r.codex, actions: r.actions, emblem: svgURL(r.emblem) };
  }
  cache.set(key, pack);
  return pack;
}

function svgURL(svg: string | undefined): string | undefined {
  return svg && svg.trimStart().startsWith("<svg") ? "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg) : undefined;
}

function defaultCompound(): CompoundLayout {
  const mats: Mat[] = [];
  let n = 0;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 6; c++) mats.push({ id: `m${++n}`, x: 230 + c * 100, y: 200 + r * 110 });
  return { width: 960, height: 640, mats, spawn: [[480, 590]] };
}

// ---- engine-owned words (shared and defector actions, core stats) ----

const CORE: Record<string, string> = {
  "stat.followers": "Followers", "stat.funds": "Funds", "stat.loyalty": "Loyalty",
  "stat.scrutiny": "Scrutiny", "stat.paranoia": "Paranoia", "stat.exposure": "Exposure",
  "action.recruit": "Recruit", "action.recruit.desc": "Bring in new members. Raises scrutiny a little.",
  "action.fundraise": "Fundraise", "action.fundraise.desc": "Ask for money. More followers give more.",
  "action.ritual": "Hold a ritual", "action.ritual.desc": "Raises loyalty, and a little paranoia.",
  "action.lie_low": "Lie low", "action.lie_low.desc": "Lowers scrutiny. Recruiting is halved for 10 minutes.",
  "action.open_doors": "Open the doors", "action.open_doors.desc": "Lowers paranoia. Costs some loyalty and a few followers.",
  "action.gather_evidence": "Gather evidence", "action.gather_evidence.desc": "Adds exposure and one piece of evidence.",
  "action.call_family": "Call family", "action.call_family.desc": "Lowers the group's loyalty a little.",
  "action.talk_to_journalist": "Talk to a journalist", "action.talk_to_journalist.desc": "Needs 5 evidence. Adds a lot of exposure and scrutiny.",
  "core.fall.investigated": "Investigators closed in and the group was shut down.",
  "core.fall.paranoia": "Paranoia took over and the group turned on the outside world.",
  "core.fall.dissolved": "Loyalty ran out and the members walked away.",
  "core.fall.exposed": "Former members told their story and the group was exposed.",
  "event.milestone": "{cult} reached {pct}%",
  "event.win": "{cult} reached its goal",
  "event.day_end.target_reached": "The Day is over",
  "event.day_end.all_fallen": "Every cult has fallen",
  "event.day_end.time_up": "Time ran out",
};

export function t(pack: Pack | undefined, key: string, vars: Record<string, string | number> = {}): string {
  let s = pack?.strings[key] ?? CORE[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}

export const CORE_STATS: Record<string, StatDef> = {
  followers: { widget: "counter", label: "stat.followers" },
  funds: { widget: "currency", label: "stat.funds" },
  loyalty: { widget: "bar", label: "stat.loyalty" },
  scrutiny: { widget: "bar", label: "stat.scrutiny" },
  paranoia: { widget: "bar", label: "stat.paranoia" },
  exposure: { widget: "bar", label: "stat.exposure" },
};

export const DEFECTOR_ACTIONS = ["gather_evidence", "call_family", "talk_to_journalist"];

/** Energy and cooldown for any action: the pack's own, or the engine's shared list from hello. */
export function actionDef(pack: Pack, id: string, shared: { id: string; energy: number; cooldownSec: number }[]): { energy: number; cooldownSec: number } {
  const a = pack.manifest.actions.find((x) => x.id === id);
  if (a) return { energy: a.energy ?? 1, cooldownSec: a.cooldownSec ?? 0 };
  const s = shared.find((x) => x.id === id);
  return { energy: s?.energy ?? 1, cooldownSec: s?.cooldownSec ?? 0 };
}

const SUPPORTED: Widget[] = ["bar", "counter", "currency", "months"];

export function formatStat(widget: Widget | string, v: number): string {
  if (!SUPPORTED.includes(widget as Widget)) return v.toLocaleString(); // unknown widget: plain number
  switch (widget) {
    case "currency":
      if (v >= 1e6) return `$${(v / 1e6).toFixed(v >= 1e7 ? 1 : 2)}M`;
      if (v >= 1e4) return `$${Math.round(v / 1e3)}k`;
      return `$${Math.round(v).toLocaleString()}`;
    case "months":
      return `${v.toFixed(1)} mo`;
    case "bar":
      return `${Math.round(v)}`;
    default:
      return Math.round(v).toLocaleString();
  }
}
