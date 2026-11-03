// Builds a 3D room from a pack's layout (compound.json: size and mats) and
// its optional scene (scene.json: floor, walls, light, furniture, scenery).
// Without a scene, or before the furniture models load, it builds a plain
// room in the pack's theme colours. Nothing here knows a specific cult.
import * as THREE from "three";
import type { CompoundLayout } from "./packs";
import type { PropMaker } from "./Props";

/** A model placed in the room. x, y on the floor as in compound.json; r in degrees (0 faces the front). */
export interface PropDef {
  m: string;
  x: number;
  y: number;
  r?: number;
  s?: number; // scale (1 = the kit's size)
  h?: number; // lift off the floor, floor units
  c?: Record<string, string>; // recolour by material name, e.g. {"carpet": "#b8325a"}
}

export interface SceneDef {
  /** Background and fog colour (the sky, or the dark outside a room). */
  sky?: string;
  /** Ground around the room. */
  ground?: string;
  floor?: { color?: string; size?: [number, number] };
  light?: { sky?: string; ground?: string; sun?: string; intensity?: number };
  /** Walls on the back and sides. "kit" builds them from wall and window tiles. */
  walls?: false | { style?: "plain" | "kit"; color?: string; height?: number; sides?: ("back" | "left" | "right")[]; windows?: boolean; c?: Record<string, string> };
  pillars?: false | { color?: string; height?: number; every?: number };
  /** The raised platform with the leader's empty seat (default on). */
  dais?: false | { color?: string; seat?: PropDef };
  /** Recolours applied to every model by material name (a prop's own c wins). */
  colors?: Record<string, string>;
  /** The emblem banner on the back wall (default on when there is a back wall). */
  banner?: boolean;
  /** How mats are drawn: a model per mat (facing the mat's r), lifting a seated player by height. */
  seat?: { m?: string; s?: number; height?: number; c?: Record<string, string> };
  props?: PropDef[];
  /** Scenery scattered around the outside of the room, in a ring between inner and outer distance. */
  /** The leader's portrait (the pack's portrait.svg), pixelated in a frame: on the back wall, or on a stand when stand is true. */
  portrait?: false | { x?: number; y?: number; size?: number; stand?: boolean; frame?: string };
  scatter?: { m: string[]; n: number; inner: number; outer: number; seed?: number; s?: [number, number]; c?: Record<string, string>; front?: boolean }[];
}

export interface Theme {
  primary: THREE.Color;
  accent: THREE.Color;
  floor: THREE.Color;
}

export interface Built {
  matHits: THREE.Mesh[];
  /** Per mat: how high a seated player sits and which way they face (radians). */
  seats: Map<string, { height: number; facing: number }>;
  /** Where the emblem banner goes, if any. */
  banner?: THREE.Vector3;
  /** Where the portrait picture goes (its centre), facing the room, and its width. */
  portrait?: { at: THREE.Vector3; width: number };
  light: { sky: THREE.Color; ground: THREE.Color; sun: THREE.Color; intensity: number; background: THREE.Color };
}

const WALL_H = 120;
const deg = (d: number | undefined, fallback: number) => ((d ?? fallback) * Math.PI) / 180;

// A small deterministic random, so scenery stays put between visits.
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export function buildRoom3D(group: THREE.Group, L: CompoundLayout, th: Theme, def: SceneDef | undefined, props: PropMaker | undefined): Built {
  const W = L.width, H = L.height;
  const std = (c: THREE.ColorRepresentation, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, ...extra });
  const col = (s: string | undefined, fallback: THREE.Color) => (s ? new THREE.Color(s) : fallback.clone());
  const furnished = !!def && !!props;
  const d = furnished ? def! : undefined;

  const place = (p: PropDef) => {
    const o = props?.make(p.m, d?.colors || p.c ? { ...d?.colors, ...p.c } : undefined);
    if (!o) return;
    o.position.set(p.x, p.h ?? 0, p.y);
    o.rotation.y = deg(p.r, 0);
    if (p.s) o.scale.multiplyScalar(p.s);
    group.add(o);
  };

  // Floor and the ground around it.
  const [fw, fh] = d?.floor?.size ?? [W, H];
  const floorCol = col(d?.floor?.color, th.floor);
  const floor = new THREE.Mesh(new THREE.BoxGeometry(fw, 8, fh), std(floorCol));
  floor.position.set(W / 2, -4, H / 2);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(W * 8, H * 8), std(col(d?.ground, th.floor.clone().multiplyScalar(0.45))));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(W / 2, -8.5, H / 2);
  group.add(ground, floor);

  // Walls.
  const walls = d ? d.walls : {};
  let banner: THREE.Vector3 | undefined;
  if (walls !== false) {
    const wh = walls?.height ?? WALL_H;
    const sides = walls?.sides ?? ["back", "left", "right"];
    if (furnished && walls?.style === "kit") {
      // Tiles of the kit's wall pieces, every other one a window.
      const tile = 66; // one kit wall piece, in floor units
      const piece = (i: number) => (walls.windows && i % 2 === 1 ? "wallWindow" : "wall");
      if (sides.includes("back")) {
        const n = Math.ceil(W / tile);
        for (let i = 0; i < n; i++) place({ m: piece(i), x: -((n * tile - W) / 2) + tile * i + tile / 2, y: -4, c: walls.c });
      }
      for (const side of ["left", "right"] as const) {
        if (!sides.includes(side)) continue;
        const n = Math.ceil(H / tile);
        for (let i = 0; i < n; i++) place({ m: piece(i), x: side === "left" ? -4 : W + 4, y: tile * i + tile / 2, r: side === "left" ? 90 : -90, c: walls.c });
      }
    } else {
      const wallMat = std(col(walls?.color, th.primary.clone().multiplyScalar(0.55)));
      if (sides.includes("back")) {
        const back = new THREE.Mesh(new THREE.BoxGeometry(W + 40, wh, 20), wallMat);
        back.position.set(W / 2, wh / 2 - 8, -10);
        group.add(back);
      }
      for (const side of ["left", "right"] as const) {
        if (!sides.includes(side)) continue;
        const w = new THREE.Mesh(new THREE.BoxGeometry(20, wh * 0.6, H), wallMat);
        w.position.set(side === "left" ? -10 : W + 10, (wh * 0.6) / 2 - 8, H / 2);
        group.add(w);
      }
    }
    if (sides.includes("back") && (d?.banner ?? true)) banner = new THREE.Vector3(W / 2, 60, 1);
  }

  // Pillars along the sides, outside the walkable strip.
  const pillars = d ? d.pillars : {};
  if (pillars !== false) {
    const ph = pillars?.height ?? WALL_H;
    const geo = new THREE.CylinderGeometry(10, 12, ph, 12);
    const mat = std(col(pillars?.color, th.primary.clone().multiplyScalar(0.8)));
    for (let z = 90; z < H - 40; z += pillars?.every ?? 170) {
      for (const x of [6, W - 6]) {
        const p = new THREE.Mesh(geo, mat);
        p.position.set(x, ph / 2 - 8, z);
        group.add(p);
      }
    }
  }

  // The dais with the leader's empty seat, and candles along its edge.
  const dais = d ? d.dais : {};
  if (dais !== false) {
    const top = new THREE.Mesh(new THREE.BoxGeometry(240, 14, 70), std(col(dais?.color, th.primary)));
    top.position.set(W / 2, 7, 75);
    group.add(top);
    if (furnished && dais?.seat) place({ ...dais.seat, x: dais.seat.x ?? W / 2, y: dais.seat.y ?? 70, h: dais.seat.h ?? 14 });
    else {
      const seat = new THREE.Mesh(new THREE.CylinderGeometry(22, 24, 10, 24), std(th.accent, { emissive: th.accent, emissiveIntensity: 0.25 }));
      seat.position.set(W / 2, 19, 75);
      group.add(seat);
    }
    const candleGeo = new THREE.CylinderGeometry(3, 3, 14, 8);
    const flameMat = new THREE.MeshBasicMaterial({ color: 0xffc46b });
    const candleMat = std(0xefe6d6);
    for (let i = 0; i < 6; i++) {
      const x = W / 2 - 100 + i * 40;
      const c = new THREE.Mesh(candleGeo, candleMat);
      c.position.set(x, 21, 104);
      const f = new THREE.Mesh(new THREE.SphereGeometry(3, 8, 6), flameMat);
      f.position.set(x, 31, 104);
      group.add(c, f);
    }
  }

  // The leader's portrait: a dark frame on the wall, or on a stand.
  let portrait: Built["portrait"];
  const pd = d ? d.portrait : undefined;
  if (pd !== false && (pd || (walls !== false && (walls?.sides ?? ["back"]).includes("back")))) {
    const size = pd?.size ?? 64;
    const ph = size * 1.25;
    const stand = !!pd?.stand;
    const x = pd?.x ?? (stand ? W / 2 : W / 2 - 200);
    const z = pd?.y ?? (stand ? 24 : 1);
    const cy = stand ? 60 + ph / 2 : 58;
    const frameMat = std(col(pd?.frame, new THREE.Color("#3a2a1c")));
    const frame = new THREE.Mesh(new THREE.BoxGeometry(size + 10, ph + 10, 4), frameMat);
    frame.position.set(x, cy, z + 2);
    group.add(frame);
    if (stand) {
      const leg = new THREE.BoxGeometry(5, cy, 5);
      for (const dx of [-size / 3, size / 3]) {
        const l = new THREE.Mesh(leg, frameMat);
        l.position.set(x + dx, cy / 2 - 8, z - 2);
        group.add(l);
      }
    }
    portrait = { at: new THREE.Vector3(x, cy, z + 4.5), width: size };
  }

  // Furniture and props.
  for (const p of d?.props ?? []) place(p);

  // Scenery outside, scattered in a ring around the room.
  for (const sc of d?.scatter ?? []) {
    const rand = rng(sc.seed ?? 7);
    const cx = W / 2, cz = H / 2;
    for (let i = 0; i < sc.n; i++) {
      const a = rand() * Math.PI * 2;
      const dist = sc.inner + rand() * (sc.outer - sc.inner);
      // An ellipse matching the room's shape, so the ring hugs it evenly.
      const x = cx + Math.cos(a) * (W / 2 + dist);
      const z = cz + Math.sin(a) * (H / 2 + dist);
      const [s0, s1] = sc.s ?? [1, 1];
      // Keep the camera's side clear unless asked: the view looks in from the front.
      // ...and never inside the room (the ellipse cuts its corners).
      if ((!sc.front && z > H - 40) || (x > -40 && x < W + 40 && z > -40 && z < H + 40)) {
        rand(), rand(), rand();
        continue;
      }
      place({ m: sc.m[Math.floor(rand() * sc.m.length)], x, y: z, r: rand() * 360, s: s0 + rand() * (s1 - s0), c: sc.c });
    }
  }

  // Mats: a model each when the scene names one, else a low cushion; with a
  // larger invisible box for easy tapping.
  const seats = new Map<string, { height: number; facing: number }>();
  const seat = d?.seat;
  const matGeo = new THREE.BoxGeometry(60, 6, 40);
  const matMat = std(th.primary.clone().lerp(th.floor, 0.25));
  const hitGeo = new THREE.BoxGeometry(70, 30, 50);
  const hitMat = new THREE.MeshBasicMaterial({ visible: false });
  const matHits: THREE.Mesh[] = [];
  for (const m of L.mats) {
    const facing = deg(m.r, 180);
    if (furnished && seat?.m && props?.has(seat.m)) {
      place({ m: seat.m, x: m.x, y: m.y, r: (facing * 180) / Math.PI, s: seat.s, c: seat.c });
    } else {
      const mesh = new THREE.Mesh(matGeo, matMat);
      mesh.position.set(m.x, 3, m.y);
      mesh.rotation.y = facing;
      group.add(mesh);
    }
    seats.set(m.id, { height: furnished ? seat?.height ?? 0 : 0, facing });
    const hit = new THREE.Mesh(hitGeo, hitMat);
    hit.position.set(m.x, 15, m.y);
    hit.userData.mat = m.id;
    matHits.push(hit);
    group.add(hit);
  }

  const li = d?.light ?? {};
  return {
    matHits,
    seats,
    banner,
    portrait,
    light: {
      sky: new THREE.Color(li.sky ?? "#fff1dc"),
      ground: new THREE.Color(li.ground ?? "#2a1f16"),
      sun: new THREE.Color(li.sun ?? "#ffe2b8"),
      intensity: li.intensity ?? 1.6,
      background: new THREE.Color(d?.sky ?? "#16130f"),
    },
  };
}
