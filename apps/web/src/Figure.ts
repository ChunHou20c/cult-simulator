// The people in the 3D compound. One rigged figure (models/avatar.glb,
// CC0 by Quaternius) cloned per player, each with its own animation mixer.
// Until the model has loaded, or if it fails to load, players are simple
// capsules, so the room is never empty.
//
// Clothes (outfit.ts) are drawn without extra art: every vertex of the
// figure is tagged once with the body part it belongs to (from its bone), and
// a per-look palette colours each part: skin, garment, shirt, shoes. Hair,
// beards, bead necklaces and the hem of a robe are small shapes fixed to the
// head, chest and hip bones, so they move with every animation.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { LOOPING, LOOP_MS, type Clip } from "./anim";
import { lookKey, type Look } from "./outfit";

export const AVATAR_H = 60; // standing height, floor units
const FADE = 0.25; // seconds to blend between movements

// Body parts, by the bone that moves each vertex most.
const enum Part { Head, Neck, Hand, UpperArm, LowerArm, Front, Torso, Pelvis, Thigh, Calf, Foot }
const PARTS = 11;

function partOf(bone: string, front: boolean): Part {
  // "front" is the chest and belly below the collarbones: an overall's bib.
  if (front && (bone.startsWith("spine") || bone.startsWith("clavicle"))) return Part.Front;
  if (bone === "Head") return Part.Head;
  if (bone.startsWith("neck")) return Part.Neck;
  if (/^(hand|thumb|index|middle|ring|pinky)/.test(bone)) return Part.Hand;
  if (bone.startsWith("lowerarm")) return Part.LowerArm;
  if (bone.startsWith("upperarm") || bone.startsWith("clavicle")) return Part.UpperArm;
  if (bone.startsWith("spine")) return Part.Torso;
  if (bone === "pelvis" || bone === "root") return Part.Pelvis;
  if (bone.startsWith("thigh")) return Part.Thigh;
  if (bone.startsWith("calf")) return Part.Calf;
  return Part.Foot;
}

/** Which colour of a look each body part wears, per garment. */
function palette(l: Look): number[] {
  const p = new Array<number>(PARTS);
  const { skin, cloth, under, feet } = l;
  p[Part.Head] = p[Part.Neck] = p[Part.Hand] = skin;
  p[Part.Foot] = feet;
  if (l.garment === "robe") {
    p[Part.UpperArm] = p[Part.LowerArm] = p[Part.Front] = p[Part.Torso] = p[Part.Pelvis] = p[Part.Thigh] = p[Part.Calf] = cloth;
  } else if (l.garment === "overalls") {
    p[Part.LowerArm] = skin;
    p[Part.UpperArm] = p[Part.Torso] = under;
    p[Part.Front] = p[Part.Pelvis] = p[Part.Thigh] = p[Part.Calf] = cloth;
  } else {
    p[Part.LowerArm] = skin;
    p[Part.UpperArm] = p[Part.Torso] = p[Part.Front] = cloth;
    p[Part.Pelvis] = p[Part.Thigh] = p[Part.Calf] = under;
  }
  return p;
}

/** A standard material that colours each body part from a palette uniform. */
function clothesMaterial(l: Look): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.8 });
  const pal = palette(l).map((c) => new THREE.Color(c));
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uPal = { value: pal };
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", `#include <common>\nattribute float part;\nuniform vec3 uPal[${PARTS}];\nvarying vec3 vCloth;`)
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvCloth = uPal[ int( part + 0.5 ) ];");
    // Look the colour up per vertex: a seam then blends two neighbouring
    // colours, never the parts in between.
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vCloth;")
      .replace("vec4 diffuseColor = vec4( diffuse, opacity );", "vec4 diffuseColor = vec4( vCloth, opacity );");
  };
  m.customProgramCacheKey = () => "clothes";
  return m;
}

// Shapes fixed to bones, built once in the figure's rest pose and stored in
// each bone's own space so a clone can reuse them as they are.
type Kit = {
  hair: Record<"long" | "short" | "bun", THREE.BufferGeometry>;
  beard: THREE.BufferGeometry;
  beads: THREE.BufferGeometry;
  hem: THREE.BufferGeometry;
};

type Model = { scene: THREE.Object3D; clips: Map<string, THREE.AnimationClip>; scale: number; kit?: Kit };
let modelP: Promise<Model> | undefined;

export function loadModel(): Promise<Model> {
  if (!modelP) {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    modelP = loader.loadAsync(`${import.meta.env.BASE_URL}models/avatar.glb`).then((g) => {
      const box = new THREE.Box3().setFromObject(g.scene);
      const h = box.max.y - box.min.y || 1;
      let kit: Kit | undefined;
      try {
        kit = tailor(g.scene);
      } catch (e) {
        console.warn("outfits unavailable", e); // plain figures still work
      }
      return { scene: g.scene, clips: new Map(g.animations.map((c) => [c.name, c])), scale: AVATAR_H / h, kit };
    });
    modelP.catch(() => (modelP = undefined)); // allow a retry on the next room
  }
  return modelP;
}

/** Tags every vertex with its body part and measures the body for the add-ons. */
function tailor(scene: THREE.Object3D): Kit {
  scene.updateMatrixWorld(true);
  const bones = new Map<string, THREE.Bone>();
  scene.traverse((o) => (o as THREE.Bone).isBone && bones.set(o.name, o as THREE.Bone));
  const boneAt = (n: string) => {
    const b = bones.get(n);
    if (!b) throw new Error("no bone " + n);
    return b;
  };
  const boxes = new Map<Part, THREE.Box3>();
  const v = new THREE.Vector3();
  const chestTop = boneAt("neck_01").getWorldPosition(new THREE.Vector3()).y - 0.015;
  const spineZ = boneAt("spine_02").getWorldPosition(new THREE.Vector3()).z;
  scene.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    const geo = m.geometry;
    const idx = geo.getAttribute("skinIndex"), wt = geo.getAttribute("skinWeight");
    const n = geo.getAttribute("position").count;
    const part = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let best = 0;
      for (let k = 1; k < 4; k++) if (wt.getComponent(i, k) > wt.getComponent(i, best)) best = k;
      const bone = m.skeleton.bones[idx.getComponent(i, best)];
      m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld);
      const p = partOf(bone.name, v.z > spineZ + 0.03 && v.y < chestTop && Math.abs(v.x) < 0.105);
      part[i] = p;
      if (!boxes.has(p)) boxes.set(p, new THREE.Box3());
      boxes.get(p)!.expandByPoint(v);
    }
    geo.setAttribute("part", new THREE.BufferAttribute(part, 1));
  });
  const head = boxes.get(Part.Head)!;
  const hc = head.getCenter(new THREE.Vector3());
  const hs = head.getSize(new THREE.Vector3());
  const torso = boxes.get(Part.Torso)!.clone().union(boxes.get(Part.Front) ?? new THREE.Box3());
  const pelvis = boxes.get(Part.Pelvis)!;
  const calf = boxes.get(Part.Calf)!;
  const neckY = boneAt("neck_01").getWorldPosition(new THREE.Vector3()).y;

  // Bake a world-space shape into a bone's space.
  const onto = (g: THREE.BufferGeometry, bone: string) => g.applyMatrix4(boneAt(bone).matrixWorld.clone().invert());

  // Hair: a cap over the crown, tilted back so the face shows. The head is
  // an egg, longer front to back, so shapes are scaled to its half-sizes.
  const ax = hs.x / 2, ay = hs.y / 2, az = hs.z / 2;
  const cap = () =>
    new THREE.SphereGeometry(1, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.6)
      .rotateX(-0.75)
      .scale(ax * 1.22, ay * 1.1, az * 1.16)
      .translate(hc.x, hc.y + ay * 0.06, hc.z - az * 0.06);
  // Long hair falls behind the head to the shoulders.
  const fallTop = hc.y + ay * 0.2, fallBottom = neckY - ay * 0.55;
  const fall = new THREE.CylinderGeometry(1, 1.2, fallTop - fallBottom, 18, 1, true, Math.PI / 2 - 0.1, Math.PI + 0.2)
    .scale(ax * 1.22, 1, az * 1.06)
    .translate(hc.x, (fallTop + fallBottom) / 2, hc.z - az * 0.12);
  const knot = new THREE.SphereGeometry(ax * 0.5, 12, 8).translate(hc.x, hc.y + ay * 0.55, hc.z - az * 0.95);
  const hair = {
    short: onto(cap(), "Head"),
    long: onto(mergeGeometries([cap(), fall])!, "Head"),
    bun: onto(mergeGeometries([cap(), knot])!, "Head"),
  };
  const beard = onto(
    new THREE.SphereGeometry(1, 14, 10).scale(ax * 0.85, ay * 0.6, az * 0.55).translate(hc.x, hc.y - ay * 0.6, hc.z + az * 0.55),
    "Head",
  );

  // Beads: a loop round the neck that hangs lower at the front, with a pendant.
  const bead = new THREE.SphereGeometry(hs.x * 0.075, 8, 6);
  const parts: THREE.BufferGeometry[] = [];
  const bx = (torso.max.x - torso.min.x) * 0.36, bz = (torso.max.z - torso.min.z) * 0.55;
  const cz = (torso.max.z + torso.min.z) / 2;
  const top = neckY - hs.y * 0.08;
  const N = 30;
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    const s = Math.sin(t);
    const drop = s > 0 ? s * s * hs.y * 0.75 : 0;
    parts.push(bead.clone().translate(hc.x + bx * Math.cos(t), top - drop, cz + bz * s + (s > 0 ? s * hs.z * 0.08 : 0)));
  }
  parts.push(
    new THREE.CylinderGeometry(hs.x * 0.16, hs.x * 0.16, hs.x * 0.05, 16)
      .rotateX(Math.PI / 2)
      .translate(hc.x, top - hs.y * 0.75 - hs.x * 0.16, cz + bz + hs.z * 0.12),
  );
  const beads = onto(mergeGeometries(parts)!, "spine_03");

  // A robe's hem: a flared skirt from the hips to the shins, so a robe reads
  // as a robe and not as trousers.
  const waist = pelvis.max.y - (pelvis.max.y - pelvis.min.y) * 0.25;
  const hemY = calf.min.y + (calf.max.y - calf.min.y) * 0.35;
  const rx = (pelvis.max.x - pelvis.min.x) * 0.55;
  const pz = (pelvis.max.z + pelvis.min.z) / 2;
  const prof = [new THREE.Vector2(rx, 0), new THREE.Vector2(rx * 1.12, (hemY - waist) * 0.3), new THREE.Vector2(rx * 1.45, hemY - waist)];
  const hem = onto(
    new THREE.LatheGeometry(prof, 20).scale(1, 1, 0.82).translate(hc.x, waist, pz),
    "pelvis",
  );
  return { hair, beard, beads, hem };
}

export interface Pose {
  moving: boolean;
  kneel: boolean;
}

export interface Figure {
  object: THREE.Object3D;
  /** Height of the head right now, for the name label. */
  headY(): number;
  /** Start a movement (an action or ritual). Ignored while walking. */
  play(clip: Clip): void;
  /** Change clothes (a member who defects changes into plain clothes). */
  dress(look: Look): void;
  update(dt: number, pose: Pose): void;
  dispose(): void;
}

/** Makes figures for one scene and owns their shared materials and geometry. */
export class Figures {
  model?: Model;
  private mats = new Map<number, THREE.MeshStandardMaterial>();
  private clothes = new Map<string, THREE.MeshStandardMaterial>();
  private capsule = { body: new THREE.CapsuleGeometry(11, 24, 4, 12), head: new THREE.SphereGeometry(8, 16, 12) };

  /** A plain colour, two-sided so open shapes (hair, hem) look solid. */
  material(c: number): THREE.MeshStandardMaterial {
    let m = this.mats.get(c);
    if (!m) this.mats.set(c, (m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, side: THREE.DoubleSide })));
    return m;
  }

  clothesFor(l: Look): THREE.MeshStandardMaterial {
    const key = palette(l).join(",");
    let m = this.clothes.get(key);
    if (!m) this.clothes.set(key, (m = clothesMaterial(l)));
    return m;
  }

  make(look: Look): Figure {
    return this.model ? new Rigged(this, this.model, look) : new Capsule(this, look);
  }

  geo() {
    return this.capsule;
  }

  dispose() {
    this.mats.forEach((m) => m.dispose());
    this.clothes.forEach((m) => m.dispose());
    this.capsule.body.dispose();
    this.capsule.head.dispose();
  }
}

class Capsule implements Figure {
  object = new THREE.Group();
  body: THREE.Mesh;
  head: THREE.Mesh;
  k = 0; // 0 standing .. 1 kneeling, eased
  hop = 0;
  t = 0;

  constructor(private f: Figures, look: Look) {
    const g = f.geo();
    this.body = new THREE.Mesh(g.body);
    this.head = new THREE.Mesh(g.head);
    this.dress(look);
    this.object.add(this.body, this.head);
  }

  dress(l: Look) {
    this.body.material = this.f.material(l.cloth);
    this.head.material = this.f.material(l.skin);
  }

  headY() {
    return AVATAR_H - 6 - this.k * 18;
  }

  play() {
    this.hop = 0.6;
  }

  update(dt: number, p: Pose) {
    this.t += dt;
    this.k += ((p.kneel ? 1 : 0) - this.k) * Math.min(1, dt * 9);
    this.hop = Math.max(0, this.hop - dt);
    const k = this.k;
    const bob = (p.moving ? Math.abs(Math.sin(this.t * 10)) * 3 : 0) + Math.sin(this.hop * Math.PI * 3) * this.hop * 8;
    this.body.position.y = 23 - k * 11 + bob;
    this.body.scale.set(1, 1 - k * 0.35, 1);
    this.body.rotation.x = k * 0.25;
    this.head.position.set(0, AVATAR_H - 14 - k * 18 + bob, k * 4);
  }

  dispose() {}
}

class Rigged implements Figure {
  object: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions = new Map<string, THREE.AnimationAction>();
  current?: THREE.AnimationAction;
  currentClip = "";
  oneShot?: { clip: Clip; until: number };
  body: THREE.Mesh[] = [];
  bones = new Map<string, THREE.Object3D>();
  extras: THREE.Mesh[] = [];
  look = "";
  kneelY = 0;

  constructor(private f: Figures, private model: Model, look: Look) {
    this.object = cloneSkinned(model.scene);
    this.object.scale.setScalar(model.scale);
    this.object.traverse((o) => {
      if ((o as THREE.Bone).isBone) this.bones.set(o.name, o);
      const m = o as THREE.SkinnedMesh;
      if (!m.isMesh) return;
      // Skinned bounds don't follow the animation; never cull a person.
      m.frustumCulled = false;
      this.body.push(m);
    });
    this.mixer = new THREE.AnimationMixer(this.object);
    this.dress(look);
    this.fadeTo("idle");
  }

  dress(l: Look) {
    const key = lookKey(l);
    if (key === this.look) return;
    this.look = key;
    const kit = this.model.kit;
    const clothes = kit ? this.f.clothesFor(l) : this.f.material(l.cloth);
    for (const m of this.body) m.material = clothes;
    for (const e of this.extras) e.removeFromParent();
    this.extras = [];
    if (!kit) return;
    const add = (geo: THREE.BufferGeometry, bone: string, color: number) => {
      const b = this.bones.get(bone);
      if (!b) return;
      const mesh = new THREE.Mesh(geo, this.f.material(color));
      mesh.frustumCulled = false;
      b.add(mesh);
      this.extras.push(mesh);
    };
    if (l.hair !== "shaved") add(kit.hair[l.hair], "Head", l.hairColor);
    if (l.beard) add(kit.beard, "Head", l.hairColor);
    if (l.beads !== undefined) add(kit.beads, "spine_03", l.beads);
    if (l.garment === "robe") add(kit.hem, "pelvis", l.cloth);
  }

  headY() {
    return AVATAR_H - this.kneelY;
  }

  play(clip: Clip) {
    if (this.currentClip === "walk") return;
    const c = this.model.clips.get(clip);
    if (!c) return;
    const ms = LOOPING.has(clip) ? LOOP_MS : Math.max(600, c.duration * 1000 - FADE * 1000);
    this.oneShot = { clip, until: performance.now() + ms };
    this.fadeTo(clip, true);
  }

  fadeTo(clip: string, restart = false) {
    if (clip === this.currentClip && !restart) return;
    const c = this.model.clips.get(clip);
    if (!c) return;
    let next = this.actions.get(clip);
    if (!next) {
      next = this.mixer.clipAction(c);
      if (!LOOPING.has(clip as Clip)) {
        next.setLoop(THREE.LoopOnce, 1);
        next.clampWhenFinished = true;
      }
      this.actions.set(clip, next);
    }
    next.reset().setEffectiveWeight(1).fadeIn(FADE).play();
    if (this.current && this.current !== next) this.current.fadeOut(FADE);
    this.current = next;
    this.currentClip = clip;
  }

  update(dt: number, p: Pose) {
    if (p.moving) this.oneShot = undefined;
    if (this.oneShot && performance.now() > this.oneShot.until) this.oneShot = undefined;
    const base = p.moving ? "walk" : p.kneel ? "kneel" : "idle";
    if (!this.oneShot) this.fadeTo(base);
    // The kneel movement sits back on the heels; lower the label with it.
    this.kneelY += ((this.currentClip === "kneel" ? AVATAR_H * 0.3 : 0) - this.kneelY) * Math.min(1, dt * 6);
    this.mixer.update(dt);
  }

  dispose() {
    for (const e of this.extras) e.removeFromParent();
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.object);
  }
}
