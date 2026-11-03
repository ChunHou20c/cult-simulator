// Furniture and scenery for the 3D rooms (models/props.glb, CC0 Kenney kits,
// built by scripts/build-props.mjs). Each model is a named node; rooms place
// clones of them, optionally recoloured by material name ("carpet", "wood").
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

// Kenney models are about 0.9 units for a person's height; ours is 60.
export const PROP_SCALE = 66;

type Library = Map<string, THREE.Object3D>;
let libP: Promise<Library> | undefined;

export function loadProps(): Promise<Library> {
  if (!libP) {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    libP = loader.loadAsync(`${import.meta.env.BASE_URL}models/props.glb`).then((g) => {
      const lib: Library = new Map();
      for (const child of g.scene.children) lib.set(child.name, child);
      return lib;
    });
    libP.catch(() => (libP = undefined));
  }
  return libP;
}

/** Places props for one scene; owns the recoloured materials it makes. */
export class PropMaker {
  private tinted = new Map<string, THREE.Material>();
  private offsets = new Map<string, THREE.Vector3>();

  constructor(private lib: Library) {}

  has(name: string) {
    return this.lib.has(name);
  }

  /** A clone of a model, its base on the floor, recoloured per material name. */
  make(name: string, colors?: Record<string, string>): THREE.Object3D | undefined {
    const src = this.lib.get(name);
    if (!src) return undefined;
    const obj = src.clone(true);
    // Stand the model on the floor, centred on its spot.
    let off = this.offsets.get(name);
    if (!off) {
      obj.position.set(0, 0, 0);
      obj.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(obj);
      off = new THREE.Vector3(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
      this.offsets.set(name, off);
    }
    obj.position.copy(off);
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.userData.shared = true; // geometry belongs to the library; never dispose it per room
      const mat = m.material as THREE.MeshStandardMaterial;
      const want = colors?.[mat.name];
      if (want) {
        const key = mat.uuid + want;
        let t = this.tinted.get(key);
        if (!t) {
          t = mat.clone();
          (t as THREE.MeshStandardMaterial).color.set(want);
          this.tinted.set(key, t);
        }
        m.material = t;
        m.userData.shared = true;
      }
    });
    const wrap = new THREE.Group();
    wrap.add(obj);
    wrap.scale.setScalar(PROP_SCALE);
    return wrap;
  }

  dispose() {
    this.tinted.forEach((m) => m.dispose());
    this.tinted.clear();
  }
}
