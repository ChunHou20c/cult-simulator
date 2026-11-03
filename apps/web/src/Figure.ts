// The people in the 3D compound. One rigged figure (models/avatar.glb,
// CC0 by Quaternius) cloned per player, each with its own animation mixer.
// Until the model has loaded, or if it fails to load, players are simple
// capsules, so the room is never empty.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { LOOPING, LOOP_MS, type Clip } from "./anim";

export const AVATAR_H = 60; // standing height, floor units
const FADE = 0.25; // seconds to blend between movements

type Model = { scene: THREE.Object3D; clips: Map<string, THREE.AnimationClip>; scale: number };
let modelP: Promise<Model> | undefined;

export function loadModel(): Promise<Model> {
  if (!modelP) {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    modelP = loader.loadAsync(`${import.meta.env.BASE_URL}models/avatar.glb`).then((g) => {
      const box = new THREE.Box3().setFromObject(g.scene);
      const h = box.max.y - box.min.y || 1;
      return { scene: g.scene, clips: new Map(g.animations.map((c) => [c.name, c])), scale: AVATAR_H / h };
    });
    modelP.catch(() => (modelP = undefined)); // allow a retry on the next room
  }
  return modelP;
}

export interface Pose {
  moving: boolean;
  kneel: boolean;
  tint: THREE.Color;
}

export interface Figure {
  object: THREE.Object3D;
  /** Height of the head right now, for the name label. */
  headY(): number;
  /** Start a movement (an action or ritual). Ignored while walking. */
  play(clip: Clip): void;
  update(dt: number, pose: Pose): void;
  dispose(): void;
}

/** Makes figures for one scene and owns their shared materials and geometry. */
export class Figures {
  model?: Model;
  private mats = new Map<number, THREE.MeshStandardMaterial>();
  private joints = new THREE.MeshStandardMaterial({ color: 0x3a3029, roughness: 0.8 });
  private capsule = { body: new THREE.CapsuleGeometry(11, 24, 4, 12), head: new THREE.SphereGeometry(8, 16, 12) };

  material(c: THREE.Color): THREE.MeshStandardMaterial {
    const key = c.getHex();
    let m = this.mats.get(key);
    if (!m) this.mats.set(key, (m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.75 })));
    return m;
  }

  make(tint: THREE.Color): Figure {
    return this.model ? new Rigged(this, this.model, tint) : new Capsule(this, tint);
  }

  geo() {
    return this.capsule;
  }

  jointMaterial() {
    return this.joints;
  }

  dispose() {
    this.mats.forEach((m) => m.dispose());
    this.joints.dispose();
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

  constructor(private f: Figures, tint: THREE.Color) {
    const g = f.geo();
    this.body = new THREE.Mesh(g.body, f.material(tint));
    this.head = new THREE.Mesh(g.head, f.material(tint));
    this.object.add(this.body, this.head);
  }

  headY() {
    return AVATAR_H - 6 - this.k * 18;
  }

  play() {
    this.hop = 0.6;
  }

  update(dt: number, p: Pose) {
    this.t += dt;
    const m = this.f.material(p.tint);
    this.body.material = m;
    this.head.material = m;
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
  main: THREE.Mesh[] = [];
  tint = -1;
  kneelY = 0;

  constructor(private f: Figures, private model: Model, tint: THREE.Color) {
    this.object = cloneSkinned(model.scene);
    this.object.scale.setScalar(model.scale);
    this.object.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isMesh) return;
      // Skinned bounds don't follow the animation; never cull a person.
      m.frustumCulled = false;
      const name = (Array.isArray(m.material) ? m.material[0] : m.material)?.name ?? "";
      if (name === "M_Joints") m.material = f.jointMaterial();
      else this.main.push(m);
    });
    this.mixer = new THREE.AnimationMixer(this.object);
    this.setTint(tint);
    this.fadeTo("idle");
  }

  setTint(c: THREE.Color) {
    if (c.getHex() === this.tint) return;
    this.tint = c.getHex();
    const m = this.f.material(c);
    for (const mesh of this.main) mesh.material = m;
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
    this.setTint(p.tint);
    if (p.moving) this.oneShot = undefined;
    if (this.oneShot && performance.now() > this.oneShot.until) this.oneShot = undefined;
    const base = p.moving ? "walk" : p.kneel ? "kneel" : "idle";
    if (!this.oneShot) this.fadeTo(base);
    // The kneel movement sits back on the heels; lower the label with it.
    this.kneelY += ((this.currentClip === "kneel" ? AVATAR_H * 0.3 : 0) - this.kneelY) * Math.min(1, dt * 6);
    this.mixer.update(dt);
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.object);
  }
}
