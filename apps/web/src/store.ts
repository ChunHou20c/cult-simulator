// One store shared by React and the Pixi scene.
import { create } from "zustand";
import type { Pack, PackInfo, CompoundLayout } from "./packs";

export interface CultView {
  id: string;
  status: "standing" | "won" | "fallen" | "exposed";
  fallReason?: string;
  fallText?: string;
  players: number;
  defectors: number;
  progress?: number;
  phase?: string;
  stats: Record<string, number>;
  buffs?: { id: string; target: string; mul: number; until: number }[];
  can?: Record<string, boolean>;
}

export interface WorldEvent { at: number; kind: string; cult?: string; key: string; data?: Record<string, any> }

export interface World {
  dayId: string;
  contentHash: string;
  seq: number;
  phase: "live" | "concluded";
  startedAt: number;
  endsAt: number;
  endedAt?: number;
  endReason?: string;
  winner?: string;
  serverTime: number;
  cults: CultView[];
  events?: WorldEvent[];
}

export interface PlayerDay {
  dayId: string;
  userId: string;
  name: string;
  cult: string;
  switchedFrom?: string;
  defected: boolean;
  energy: number;
  energyAt: number;
  actions: number;
  contribution: number;
  evidence: number;
  outcome?: string;
}

export interface Avatar {
  id: string;
  name: string;
  fx: number; fy: number; tx: number; ty: number; t0: number; // walk from -> to, start (server ms)
  pose: "stand" | "kneel";
  mat?: string;
  defected?: boolean;
  ritual?: { id: string; at: number };
  act?: { id: string; at: number }; // last action seen in the room (3D movement)
}

export interface EngineInfo { maxEnergy: number; refillSec: number; defectMinActions: number; evidenceForJournalist: number; roomSize: number }
export interface SharedAction { id: string; energy: number; cooldownSec: number }

export type Screen = "gate" | "lobby" | "compound" | "end" | "summary" | "archive" | "codex";

export interface Pending { seq: number; action: string }

/** An open mini game round, as the server handed it out. */
export interface Round { seq: number; nonce: string; seed: number; game: "flick" | "timing" | "beat"; action: string; at: number }

interface State {
  screen: Screen;
  error?: string;
  /** A new release is installed and waiting for a reload. */
  updateReady?: boolean;
  name?: string;
  userId?: string;
  engine?: EngineInfo;
  shared: SharedAction[];
  packInfo: PackInfo[];
  packs: Record<string, Pack>;
  world?: World;
  player?: PlayerDay;
  // room
  you?: string;
  layout?: CompoundLayout;
  avatars: Record<string, Avatar>;
  clockSkew: number; // server ms - local ms
  energy: number;
  energyAt: number;
  cooldowns: Record<string, number>;
  pending: Pending[];
  round?: Round;
  lastResult?: { action: string; ok: boolean; reason?: string; deltas?: Record<string, number>; quality?: number; grades?: number[]; at: number };
  convergence?: { key: string; at: number };
  /** The Day that just ended; cult is this player's cult's final state when the next Day already opened. */
  dayEnded?: { dayId: string; reason?: string; winner?: string; reset?: boolean; cult?: CultView };
  summaryDay?: string;
  codexCult?: string;
  set: (p: Partial<State>) => void;
}

export const useStore = create<State>((set) => ({
  screen: "gate",
  shared: [],
  packInfo: [],
  packs: {},
  avatars: {},
  clockSkew: 0,
  energy: 0,
  energyAt: 0,
  cooldowns: {},
  pending: [],
  set: (p) => set(p),
}));

export const S = () => useStore.getState();

export function cultView(world: World | undefined, id: string | undefined): CultView | undefined {
  return world?.cults.find((c) => c.id === id);
}

/** Energy now, from the last server value and its refill clock. */
export function energyNow(energy: number, energyAt: number, max: number, refillSec: number, skewMs: number): number {
  if (energy >= max) return max;
  const now = (Date.now() + skewMs) / 1000;
  return Math.min(max, energy + Math.floor((now - energyAt) / refillSec));
}
