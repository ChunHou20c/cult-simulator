// Builds apps/web/public/models/props.glb: the furniture and scenery that
// rooms are furnished with, one named node per model, compressed for phones.
//
// Sources (CC0, by Kenney): Furniture Kit 2.0 and Nature Kit 2.1, the
// "Models/GLTF format" folders.
//   https://kenney.nl/assets/furniture-kit
//   https://kenney.nl/assets/nature-kit
//
//   node scripts/build-props.mjs path/to/furniture-kit/GLTF path/to/nature-kit/GLTF
//
// To add a model: add its file name (without .glb) to PROPS and rebuild. Rooms
// (content/cults/<id>/scene.json) refer to models by these names.
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, meshopt, prune, quantize, weld } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join as joinPath, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROPS = [
  // Furniture Kit
  "bench", "benchCushion", "benchCushionLow", "bookcaseClosedWide", "bookcaseOpen", "bookcaseOpenLow", "books",
  "cardboardBoxClosed", "cardboardBoxOpen", "chair", "chairCushion", "chairRounded", "coatRackStanding",
  "kitchenBar", "kitchenBarEnd", "kitchenBlender", "kitchenCabinet", "kitchenCabinetUpper", "kitchenCoffeeMachine",
  "kitchenFridge", "kitchenFridgeLarge", "kitchenSink", "kitchenStove", "lampRoundFloor", "lampRoundTable",
  "lampSquareFloor", "lampWall", "loungeChair", "loungeChairRelax", "loungeDesignSofa", "loungeSofa",
  "loungeSofaCorner", "loungeSofaLong", "loungeSofaOttoman", "pillow", "pillowBlue", "pillowBlueLong", "pillowLong",
  "plantSmall1", "plantSmall2", "plantSmall3", "pottedPlant", "radio", "rugDoormat", "rugRectangle", "rugRound",
  "rugRounded", "rugSquare", "sideTable", "speaker", "speakerSmall", "table", "tableCloth", "tableCoffee",
  "tableCoffeeSquare", "tableCross", "tableCrossCloth", "tableRound", "televisionVintage", "trashcan",
  "wall", "wallDoorway", "wallHalf", "wallWindow", "wallWindowSlide",
  // Nature Kit
  "cactus_tall", "campfire_stones", "cliff_large_rock", "fence_simple", "flower_redA", "flower_yellowA", "grass",
  "grass_large", "log", "plant_bush", "plant_bushDetailed", "plant_bushLarge", "rock_largeA", "rock_largeB",
  "rock_smallA", "rock_tallA", "stone_largeA", "stump_round", "tent_detailedOpen", "tree_cone", "tree_default",
  "tree_detailed", "tree_fat", "tree_oak", "tree_palm", "tree_palmBend", "tree_palmTall", "tree_pineRoundA",
  "tree_pineRoundC", "tree_pineSmallA", "tree_thin",
];

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../apps/web/public/models/props.glb");

async function main() {
  const dirs = process.argv.slice(2);
  if (!dirs.length) {
    console.error("usage: node scripts/build-props.mjs <furniture GLTF dir> <nature GLTF dir>");
    process.exit(1);
  }
  await MeshoptEncoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": MeshoptEncoder });
  const doc = new Document();
  const root = doc.getRoot();
  const buffer = doc.createBuffer();
  const scene = doc.createScene("props");
  const materials = new Map(); // one material per name+colour, shared across models

  for (const name of PROPS) {
    const file = dirs.map((d) => joinPath(d, name + ".glb")).find((f) => existsSync(f));
    if (!file) throw new Error("model not found: " + name);
    const src = await io.read(file);
    const holder = doc.createNode(name);
    scene.addChild(holder);
    // Copy each node tree, re-creating meshes in this document.
    const copyNode = (n) => {
      const c = doc.createNode(n.getName()).setTranslation(n.getTranslation()).setRotation(n.getRotation()).setScale(n.getScale());
      const mesh = n.getMesh();
      if (mesh) {
        const m = doc.createMesh(mesh.getName());
        for (const p of mesh.listPrimitives()) {
          const np = doc.createPrimitive().setMode(p.getMode());
          for (const sem of p.listSemantics()) {
            if (sem !== "POSITION" && sem !== "NORMAL") continue; // flat-coloured models: no UVs needed
            const a = p.getAttribute(sem);
            np.setAttribute(sem, doc.createAccessor().setType(a.getType()).setArray(a.getArray().slice()).setBuffer(buffer));
          }
          const idx = p.getIndices();
          if (idx) np.setIndices(doc.createAccessor().setType("SCALAR").setArray(idx.getArray().slice()).setBuffer(buffer));
          const sm = p.getMaterial();
          if (sm) {
            const f = sm.getBaseColorFactor();
            const key = sm.getName() + ":" + f.map((v) => v.toFixed(3)).join(",");
            let mat = materials.get(key);
            if (!mat) {
              mat = doc.createMaterial(sm.getName()).setBaseColorFactor(f).setRoughnessFactor(0.85).setMetallicFactor(sm.getName().startsWith("metal") ? 0.4 : 0);
              materials.set(key, mat);
            }
            np.setMaterial(mat);
          }
          m.addPrimitive(np);
        }
        c.setMesh(m);
      }
      for (const ch of n.listChildren()) c.addChild(copyNode(ch));
      return c;
    };
    for (const n of src.getRoot().getDefaultScene().listChildren()) holder.addChild(copyNode(n));
  }
  root.setDefaultScene(scene);

  await doc.transform(weld(), dedup(), prune({ keepLeaves: true }), quantize(), meshopt({ encoder: MeshoptEncoder, level: "high" }), prune({ keepLeaves: true }));
  mkdirSync(dirname(out), { recursive: true });
  await io.write(out, doc);
  console.log(`wrote ${out}: ${PROPS.length} models, ${root.listMaterials().length} materials`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
