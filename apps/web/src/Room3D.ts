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
  dais?: false | { color?: string; seat?: PropDef; y?: number };
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
  /** A carved stone idol: a seated, winged figure with a horned beast's head, a star on its brow and a flame between its horns. Built from shapes, no model. x, y on the floor; r turns it (0 faces the front); s scales it (1 is about twice a person's height); h lifts it. */
  idol?: { x?: number; y?: number; r?: number; s?: number; h?: number; stone?: string; horn?: string; wing?: string; glow?: string };
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
    const dz = dais?.y ?? 75; // the dais's centre, front to back
    const top = new THREE.Mesh(new THREE.BoxGeometry(240, 14, 70), std(col(dais?.color, th.primary)));
    top.position.set(W / 2, 7, dz);
    group.add(top);
    // A scene with an idol puts it where the leader's seat would be (below).
    if (furnished && dais?.seat && !def?.idol) place({ ...dais.seat, x: dais.seat.x ?? W / 2, y: dais.seat.y ?? dz - 5, h: dais.seat.h ?? 14 });
    else if (!def?.idol) {
      const seat = new THREE.Mesh(new THREE.CylinderGeometry(22, 24, 10, 24), std(th.accent, { emissive: th.accent, emissiveIntensity: 0.25 }));
      seat.position.set(W / 2, 19, dz);
      group.add(seat);
    }
    const candleGeo = new THREE.CylinderGeometry(3, 3, 14, 8);
    const flameMat = new THREE.MeshBasicMaterial({ color: 0xffc46b });
    const candleMat = std(0xefe6d6);
    for (let i = 0; i < 6; i++) {
      const x = W / 2 - 100 + i * 40;
      const c = new THREE.Mesh(candleGeo, candleMat);
      c.position.set(x, 21, dz + 29);
      const f = new THREE.Mesh(new THREE.SphereGeometry(3, 8, 6), flameMat);
      f.position.set(x, 31, dz + 29);
      group.add(c, f);
    }
  }

  // The idol needs no models, so it stands in the plain room too.
  if (def?.idol) group.add(buildIdol(def.idol, W, std));

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

type Std = (c: THREE.ColorRepresentation, extra?: THREE.MeshStandardMaterialParameters) => THREE.MeshStandardMaterial;

/** The horned idol (SceneDef.idol), facing +z (the front of the room). Units: a person is about 60 tall. */
function buildIdol(o: NonNullable<SceneDef["idol"]>, W: number, std: Std): THREE.Group {
  const g = new THREE.Group();
  const stone = std(o.stone ?? "#4a4250");
  const horn = std(o.horn ?? "#d8c8a0", { roughness: 0.6 });
  const wing = std(o.wing ?? "#3a2a40", { side: THREE.DoubleSide });
  const glowCol = new THREE.Color(o.glow ?? "#f2c14e");
  const glow = new THREE.MeshBasicMaterial({ color: glowCol });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    g.add(m);
    return m;
  };

  // Plinth, robed body, shoulders.
  add(new THREE.BoxGeometry(80, 24, 56), stone, 0, 12, 0);
  add(new THREE.BoxGeometry(70, 6, 48), std(glowCol.clone().multiplyScalar(0.35)), 0, 27, 0);
  add(new THREE.CylinderGeometry(15, 28, 62, 16), stone, 0, 61, 0);
  add(new THREE.SphereGeometry(17, 16, 10), stone, 0, 90, 0).scale.set(1.35, 0.7, 0.9);
  // Arms: one raised, one lowered.
  const arm = new THREE.CylinderGeometry(4, 5, 34, 8);
  add(arm, stone, 26, 104, 0, 0, 0, -0.35);
  add(arm, stone, -25, 74, 4, 0, 0, -0.45);
  add(new THREE.SphereGeometry(5.5, 8, 6), stone, 32, 120, 0);
  add(new THREE.SphereGeometry(5.5, 8, 6), stone, -31, 59, 6);

  // Wings: a curved, scalloped shape on each side, swept back.
  const ws = new THREE.Shape();
  ws.moveTo(0, 0);
  ws.bezierCurveTo(20, 30, 50, 44, 78, 40);
  ws.lineTo(70, 26);
  ws.quadraticCurveTo(62, 18, 66, 8);
  ws.quadraticCurveTo(54, 4, 54, -8);
  ws.quadraticCurveTo(40, -6, 36, -18);
  ws.quadraticCurveTo(22, -10, 10, -14);
  ws.lineTo(0, 0);
  const wg = new THREE.ShapeGeometry(ws, 10);
  for (const side of [1, -1]) {
    const w = add(wg, wing, side * 10, 86, -12, 0, side > 0 ? -0.5 : Math.PI + 0.5, 0);
    w.scale.setScalar(0.95);
  }

  // Head: a long goat's face leaning forward, with a beard, ears and glowing eyes.
  const head = new THREE.Group();
  head.position.set(0, 110, 6);
  // Bigger than life and tipped up a little, so the face reads from the high camera.
  head.scale.setScalar(1.3);
  head.rotation.x = -0.35;
  g.add(head);
  const hadd = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    head.add(m);
    return m;
  };
  hadd(new THREE.SphereGeometry(11, 14, 10), stone, 0, 4, 0).scale.set(1, 1.1, 1);
  hadd(new THREE.CylinderGeometry(4.5, 8, 20, 10), stone, 0, -6, 7, 1.15);
  hadd(new THREE.ConeGeometry(4, 13, 8), stone, 0, -15, 9, Math.PI);
  for (const side of [1, -1]) {
    hadd(new THREE.ConeGeometry(3, 13, 6), stone, side * 12, 5, 0, 0, 0, side * 1.9).scale.set(1, 1, 0.45);
    hadd(new THREE.SphereGeometry(1.8, 8, 6), glow, side * 4.5, 2, 10);
    // Horns: a tapering tube curling up, out and back.
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(side * 5, 11, 1),
      new THREE.Vector3(side * 11, 22, -2),
      new THREE.Vector3(side * 20, 28, -8),
      new THREE.Vector3(side * 26, 24, -14),
    ]);
    const tube = new THREE.TubeGeometry(curve, 16, 3, 8);
    // Taper: shrink each ring towards the tip.
    const pos = tube.attributes.position as THREE.BufferAttribute;
    const segs = 16, radial = 9;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const c = curve.getPointAt(t);
      const k = 1 - 0.8 * t;
      for (let j = 0; j < radial; j++) {
        const vi = i * radial + j;
        pos.setXYZ(vi, c.x + (pos.getX(vi) - c.x) * k, c.y + (pos.getY(vi) - c.y) * k, c.z + (pos.getZ(vi) - c.z) * k);
      }
    }
    tube.computeVertexNormals();
    hadd(tube, horn, 0, 0, 0);
  }
  // The star on the brow, and the flame between the horns.
  const st = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 ? 1.9 : 4.6;
    if (i) st.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    else st.moveTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  hadd(new THREE.ShapeGeometry(st), glow, 0, 9, 10.6, -0.25);
  hadd(new THREE.ConeGeometry(3.2, 11, 10), new THREE.MeshBasicMaterial({ color: 0xffa040 }), 0, 22, -1);
  hadd(new THREE.SphereGeometry(3.2, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffc46b }), 0, 17, -1);

  g.position.set(o.x ?? W / 2, o.h ?? 0, o.y ?? 60);
  g.rotation.y = deg(o.r, 0);
  g.scale.setScalar(o.s ?? 1);
  return g;
}
