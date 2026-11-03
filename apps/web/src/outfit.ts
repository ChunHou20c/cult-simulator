// What people in a compound wear. A pack describes its cult's clothes in
// manifest.outfit (garment cut, colours, hair, beards, beads); each person
// gets their own pick from it, seeded by their player id, so everyone in the
// room sees the same person dressed the same way. Display only: the server
// never reads it. Nothing here knows a specific cult.
import type { Manifest } from "./packs";

export type Garment = "robe" | "overalls" | "casual";
export type Hair = "long" | "short" | "shaved" | "bun";

export interface OutfitDef {
  /** The cut: a long robe, overalls over a shirt, or a shirt and trousers. */
  garment: Garment;
  /** Main garment colours; each person wears one. */
  colors: string[];
  /** Second layer: the shirt under overalls, or the trousers with a casual shirt. */
  under?: string[];
  /** Hairstyles to pick from; repeat one to make it more common. */
  hair?: Hair[];
  /** Share of people with a beard, 0..1. */
  beard?: number;
  /** Colour of a bead necklace everyone wears, if any. */
  beads?: string;
  /** Shoe or sandal colour. */
  feet?: string;
}

/** One person's clothes, as hex colours. */
export interface Look {
  garment: Garment;
  cloth: number;
  under: number;
  skin: number;
  hair: Hair;
  hairColor: number;
  beard: boolean;
  beads?: number;
  feet: number;
}

const SKIN = [0xf2cfae, 0xe3b28c, 0xc98f63, 0xa86f48, 0x7f5235, 0x5b3a26];
const HAIR = [0x2a201a, 0x3d2b20, 0x5e3f28, 0x7a4b2a, 0xa7773f, 0xcdb184, 0x8f8a84];
const PLAIN: OutfitDef = { garment: "casual", colors: ["#efe6d6", "#d9cdb8"], under: ["#5b5148", "#4a4f57"], hair: ["short", "short", "long", "bun"], beard: 0.25 };
const DEFECTOR = 0x8c8c8c;

const hex = (s: string | undefined, fallback: number) => (s && /^#[0-9a-f]{6}$/i.test(s) ? parseInt(s.slice(1), 16) : fallback);

/** A small seeded random stream, so a player id always gives the same picks. */
function rng(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length) % xs.length];

export function outfitOf(m: Manifest | undefined): OutfitDef {
  const o = m?.outfit;
  return o && o.colors?.length ? o : PLAIN;
}

/** The look of one person. A defector has left: plain grey clothes, no beads. */
export function lookFor(def: OutfitDef, id: string, defected = false): Look {
  const r = rng(id);
  const garment = defected ? "casual" : def.garment;
  const cloth = defected ? DEFECTOR : hex(pick(r, def.colors), 0xefe6d6);
  const under = hex(def.under?.length ? pick(r, def.under) : undefined, garment === "casual" ? 0x4a4f57 : cloth);
  const skin = pick(r, SKIN);
  const hair = pick(r, def.hair?.length ? def.hair : PLAIN.hair!);
  const hairColor = pick(r, HAIR);
  const beard = r() < (def.beard ?? 0);
  const feet = hex(def.feet, garment === "robe" ? 0x8a6a4a : 0x3a2c22);
  return { garment, cloth, under: defected ? 0x4a4f57 : under, skin, hair, hairColor, beard, beads: defected ? undefined : def.beads ? hex(def.beads, 0x6b4325) : undefined, feet };
}

export const lookKey = (l: Look) => [l.garment, l.cloth, l.under, l.skin, l.hair, l.hairColor, l.beard, l.beads ?? "", l.feet].join(":");
