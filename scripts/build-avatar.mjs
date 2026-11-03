// Builds apps/web/public/models/avatar.glb: one rigged figure plus the clips
// the game uses, renamed to our animation library ids, simplified and
// compressed for phones.
//
// Sources (CC0, by Quaternius): Universal Animation Library 1 and 2, the
// "Standard" glTF files (UAL1_Standard.glb, UAL2_Standard.glb). Both use the
// same "Mannequin" rig, so clips from either play on the one figure.
//   https://quaternius.com/packs/universalanimationlibrary.html
//   https://opengameart.org/content/universal-animation-library-2
//
//   node scripts/build-avatar.mjs path/to/UAL1_Standard.glb path/to/UAL2_Standard.glb
//
// To add a movement: add a line to CLIPS (library id: source clip name),
// rebuild, and list the id in apps/web/src/anim.ts.
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, meshopt, prune, quantize, resample, simplify, weld } from "@gltf-transform/functions";
import { MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Library id -> source clip (from either file).
export const CLIPS = {
  idle: "Idle_Loop",
  walk: "Walk_Loop",
  kneel: "Sitting_Idle_Loop",
  sit_talk: "Sitting_Talking_Loop",
  talk: "Idle_Talking_Loop",
  phone: "Idle_TalkingPhone_Loop",
  fold_arms: "Idle_FoldArms_Loop",
  dance: "Dance_Loop",
  fix: "Fixing_Kneeling",
  interact: "Interact",
  pick_up: "PickUp_Table",
  carry: "Walk_Carry_Loop",
  plant: "Farm_PlantSeed",
  harvest: "Farm_Harvest",
  water: "Farm_Watering",
  chop: "TreeChopping_Loop",
  open: "Chest_Open",
  consume: "Consume",
  raise_hands: "Spell_Simple_Idle_Loop",
  lantern: "Idle_Lantern_Loop",
  torch: "Idle_Torch_Loop",
  yes: "Yes",
  no: "Idle_No_Loop",
  crouch: "Crouch_Idle_Loop",
  push: "Push_Loop",
};

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../apps/web/public/models/avatar.glb");

// Disposing an animation leaves its samplers alive in the graph, holding
// their keyframe data, so prune() keeps it all. Drop them explicitly.
function dropSampler(s) {
  const input = s.getInput(), output = s.getOutput();
  s.dispose();
  for (const a of [input, output]) if (a && a.listParents().every((p) => p.propertyType === "Root")) a.dispose();
}
function dropAnimation(anim) {
  for (const ch of anim.listChannels()) ch.dispose();
  for (const s of anim.listSamplers()) dropSampler(s);
  anim.dispose();
}

async function main() {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) {
    console.error("usage: node scripts/build-avatar.mjs UAL1_Standard.glb UAL2_Standard.glb");
    process.exit(1);
  }
  await MeshoptEncoder.ready;
  await MeshoptSimplifier.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": MeshoptEncoder });
  const doc = await io.read(a);
  const extra = await io.read(b);
  const root = doc.getRoot();
  const buffer = root.listBuffers()[0];
  const nodeByName = new Map(root.listNodes().map((n) => [n.getName(), n]));
  const wanted = new Map(Object.entries(CLIPS).map(([id, src]) => [src, id]));

  // Keep only the wanted clips from the main file, renamed to library ids.
  for (const anim of root.listAnimations()) {
    const src = anim.getName();
    const id = wanted.get(src);
    if (id) {
      anim.setName(id);
      wanted.delete(src);
    } else dropAnimation(anim);
  }
  // Copy the rest from the second file onto the same rig, matching bones by name.
  for (const anim of extra.getRoot().listAnimations()) {
    const id = wanted.get(anim.getName());
    if (!id) continue;
    const copy = doc.createAnimation(id);
    const samplers = new Map();
    for (const ch of anim.listChannels()) {
      const node = nodeByName.get(ch.getTargetNode()?.getName());
      if (!node) continue;
      const s = ch.getSampler();
      let ns = samplers.get(s);
      if (!ns) {
        const acc = (src) => doc.createAccessor().setType(src.getType()).setArray(src.getArray().slice()).setBuffer(buffer);
        ns = doc.createAnimationSampler().setInput(acc(s.getInput())).setOutput(acc(s.getOutput())).setInterpolation(s.getInterpolation());
        samplers.set(s, ns);
        copy.addSampler(ns);
      }
      copy.addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(ch.getTargetPath()).setSampler(ns));
    }
    wanted.delete(anim.getName());
  }
  if (wanted.size) throw new Error("clips not found: " + [...wanted.keys()].join(", "));

  // Trim channels the figure doesn't need: bones only rotate (the pelvis and
  // root also move), nothing scales, and leaf bones are end markers. This
  // cuts the file to about a third.
  for (const anim of root.listAnimations()) {
    for (const ch of anim.listChannels()) {
      const name = ch.getTargetNode()?.getName() ?? "";
      const path = ch.getTargetPath();
      const keep = !name.includes("leaf") && (path === "rotation" || (path === "translation" && (name === "pelvis" || name === "root")));
      if (!keep) ch.dispose();
    }
    const used = new Set(anim.listChannels().map((c) => c.getSampler()));
    for (const s of anim.listSamplers()) if (!used.has(s)) dropSampler(s);
  }

  await doc.transform(
    resample(),
    weld(),
    simplify({ simplifier: MeshoptSimplifier, ratio: 0.4, error: 0.002 }),
    prune(),
    dedup(),
    quantize(),
    prune(),
    meshopt({ encoder: MeshoptEncoder, level: "high" }),
    prune(),
  );
  mkdirSync(dirname(out), { recursive: true });
  await io.write(out, doc);
  const tris = root.listMeshes().flatMap((m) => m.listPrimitives()).reduce((n, p) => n + (p.getIndices()?.getCount() ?? 0) / 3, 0);
  console.log(`wrote ${out}: ${root.listAnimations().length} clips, ${tris} triangles`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
