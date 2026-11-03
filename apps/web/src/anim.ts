// The animation library: the movements the 3D figure can make, by our own
// ids (models/avatar.glb is built with these names by scripts/build-avatar.mjs).
// Packs pick a movement per action in manifest.animations; anything a pack
// doesn't name falls back to the defaults below, then to a generic gesture.
import type { Manifest } from "./packs";

export const LIBRARY = [
  "idle", "walk", "kneel", "sit_talk", "talk", "phone", "fold_arms", "dance", "fix", "interact", "pick_up",
  "carry", "plant", "harvest", "water", "chop", "open", "consume", "raise_hands", "lantern", "torch", "yes",
  "no", "crouch", "push",
] as const;
export type Clip = (typeof LIBRARY)[number];

// Movements that loop; they play for LOOP_MS. The rest play once.
export const LOOPING = new Set<Clip>(["idle", "walk", "kneel", "sit_talk", "talk", "phone", "fold_arms", "dance", "carry", "chop", "raise_hands", "lantern", "torch", "no", "crouch", "push"]);
export const LOOP_MS = 3200;

// Shared and defector actions, and the wordless rituals.
const DEFAULTS: Record<string, Clip> = {
  recruit: "talk",
  fundraise: "interact",
  ritual: "raise_hands",
  lie_low: "crouch",
  open_doors: "open",
  gather_evidence: "pick_up",
  call_family: "phone",
  talk_to_journalist: "phone",
  "ritual.bow": "yes",
  "ritual.chant": "raise_hands",
  "ritual.beads": "fold_arms",
  "ritual.candle": "lantern",
};

export const FALLBACK: Clip = "interact";

const known = new Set<string>(LIBRARY);

/** The movement for an action id, or "ritual.<id>" for a ritual. */
export function clipFor(key: string, manifest?: Manifest): Clip {
  const own = manifest?.animations?.[key];
  if (own && known.has(own)) return own as Clip;
  return DEFAULTS[key] ?? FALLBACK;
}
