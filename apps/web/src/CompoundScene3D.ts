// The compound in 3D: the same room as CompoundScene (2D), drawn with
// Three.js. The server's floor is unchanged: its (x, y) is world (x, 0, y),
// in the same units, so walks, prediction and kneeling work as they do in 2D.
// The camera sits at a fixed angle and follows your avatar a little.
import * as THREE from "three";
import { useStore, S, type Avatar } from "./store";
import { avatarPos, kneel, walkTo } from "./game";
import { Figures, loadModel, type Figure } from "./Figure";
import { clipFor } from "./anim";

// Camera angle down from horizontal: steeper on portrait screens, so the
// room uses the tall screen instead of leaving empty sky and ground.
const TILT_WIDE = THREE.MathUtils.degToRad(52);
const TILT_TALL = THREE.MathUtils.degToRad(66);
const FOV = 38;
const WALL_H = 120;

type Sprite = {
  root: THREE.Group;
  fig: Figure;
  label: THREE.Sprite;
  last: [number, number];
  facing: number;
  seenAct?: number; // the last action / ritual movement started, by its time
  seenRitual?: number;
};

const CREAM = new THREE.Color(0xefe6d6);
const GREY = new THREE.Color(0x8c8c8c);
const color = (s: string | undefined, fallback: number) => new THREE.Color(s ? parseInt(s.slice(1), 16) : fallback);

export class CompoundScene3D {
  renderer?: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(FOV, 1, 10, 6000);
  room = new THREE.Group();
  people = new THREE.Group();
  fx = new THREE.Group();
  matHits: THREE.Mesh[] = [];
  floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  sprites = new Map<string, Sprite>();
  rings = new Map<string, THREE.Mesh>();
  marker?: { mesh: THREE.Mesh; at: number };
  kneelTarget: string | null = null;
  target = new THREE.Vector3();
  dist = 1000;
  frameW = 0; // width of the floor kept in view (narrower on portrait screens)
  tilt = TILT_WIDE;
  el?: HTMLElement;
  ro?: ResizeObserver;
  unsub?: () => void;
  raf = 0;
  down?: { x: number; y: number };
  destroyed = false;
  lastFrame = performance.now();
  figures = new Figures();
  accent = new THREE.Color(0xe0b44c); // your own figure's colour, from the pack theme
  // Shared geometry: one of each, reused by every avatar.
  geo = {
    shadow: new THREE.CircleGeometry(16, 24),
    ring: new THREE.RingGeometry(0.82, 1, 48),
  };
  shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false });

  mount(el: HTMLElement) {
    this.el = el;
    const r = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    // Phones: cap the pixel ratio; most of the cost is fill rate.
    const coarse = window.matchMedia?.("(pointer: coarse)").matches;
    r.setPixelRatio(Math.min(coarse ? 1.5 : 2, window.devicePixelRatio || 1));
    r.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = r;
    el.appendChild(r.domElement);

    this.scene.background = new THREE.Color(0x16130f);
    this.scene.fog = new THREE.Fog(0x16130f, 1400, 3200);
    this.scene.add(new THREE.HemisphereLight(0xfff1dc, 0x2a1f16, 1.6));
    const sun = new THREE.DirectionalLight(0xffe2b8, 1.6);
    sun.position.set(-300, 900, 500);
    this.scene.add(sun, this.room, this.people, this.fx);

    r.domElement.addEventListener("pointerdown", this.onDown);
    r.domElement.addEventListener("pointerup", this.onUp);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(el);
    this.resize();
    this.buildRoom();
    this.unsub = useStore.subscribe((s, prev) => {
      if (s.layout !== prev.layout || s.player?.cult !== prev.player?.cult) {
        this.buildRoom();
        this.resize();
      }
      if (s.avatars !== prev.avatars) this.syncAvatars();
    });
    this.syncAvatars();
    // Swap the capsules for the rigged figure once it has loaded.
    loadModel()
      .then((m) => {
        if (this.destroyed) return;
        this.figures.model = m;
        for (const sp of this.sprites.values()) {
          sp.root.remove(sp.fig.object);
          sp.fig.dispose();
          sp.fig = this.figures.make(CREAM);
          sp.root.add(sp.fig.object);
        }
      })
      .catch(() => {});
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    loop();
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    for (const sp of this.sprites.values()) sp.fig.dispose();
    this.unsub?.();
    this.ro?.disconnect();
    const r = this.renderer;
    if (!r) return;
    r.domElement.removeEventListener("pointerdown", this.onDown);
    r.domElement.removeEventListener("pointerup", this.onUp);
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
      (mat as THREE.SpriteMaterial | undefined)?.map?.dispose();
    });
    this.figures.dispose();
    r.dispose();
    r.domElement.remove();
  }

  theme() {
    const st = S();
    const pack = st.player ? st.packs[st.player.cult] : undefined;
    const t = pack?.manifest.theme ?? {};
    return { primary: color(t.primary, 0x8a6a4a), accent: color(t.accent, 0xe0b44c), floor: color(t.floor, 0x2a221b) };
  }

  // A generated room from the pack's layout and colours. Real per-cult rooms
  // (models of the actual places) replace this later; it stays as the fallback.
  buildRoom() {
    const L = S().layout;
    for (const c of [...this.room.children]) {
      this.room.remove(c);
      c.traverse((o) => {
        (o as THREE.Mesh).geometry?.dispose();
        ((o as THREE.Mesh).material as THREE.Material | undefined)?.dispose();
      });
    }
    this.matHits = [];
    if (!L) return;
    const th = this.theme();
    this.accent = th.accent;
    const W = L.width, H = L.height;
    const std = (c: THREE.Color, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, ...extra });

    // Floor, slightly larger than the walkable area, and a darker surround.
    const floor = new THREE.Mesh(new THREE.BoxGeometry(W, 8, H), std(th.floor));
    floor.position.set(W / 2, -4, H / 2);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(W * 4, H * 4), std(th.floor.clone().multiplyScalar(0.45)));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(W / 2, -8.5, H / 2);
    this.room.add(ground, floor);

    // Walls on the back and sides; the front stays open to the camera.
    const wallMat = std(th.primary.clone().multiplyScalar(0.55));
    const back = new THREE.Mesh(new THREE.BoxGeometry(W + 40, WALL_H, 20), wallMat);
    back.position.set(W / 2, WALL_H / 2 - 8, -10);
    const left = new THREE.Mesh(new THREE.BoxGeometry(20, WALL_H * 0.6, H), wallMat);
    left.position.set(-10, (WALL_H * 0.6) / 2 - 8, H / 2);
    const right = left.clone();
    right.position.x = W + 10;
    this.room.add(back, left, right);

    // Pillars along the side walls, outside the walkable strip.
    const pillarGeo = new THREE.CylinderGeometry(10, 12, WALL_H, 12);
    const pillarMat = std(th.primary.clone().multiplyScalar(0.8));
    for (let z = 90; z < H - 40; z += 170) {
      for (const x of [6, W - 6]) {
        const p = new THREE.Mesh(pillarGeo, pillarMat);
        p.position.set(x, WALL_H / 2 - 8, z);
        this.room.add(p);
      }
    }

    // The dais with the leader's empty seat, as in 2D.
    const dais = new THREE.Mesh(new THREE.BoxGeometry(240, 14, 70), std(th.primary));
    dais.position.set(W / 2, 7, 75);
    const seat = new THREE.Mesh(new THREE.CylinderGeometry(22, 24, 10, 24), std(th.accent, { emissive: th.accent, emissiveIntensity: 0.25 }));
    seat.position.set(W / 2, 19, 75);
    this.room.add(dais, seat);
    // Candles along the dais edge: emissive, no real lights (cheap on phones).
    const candleGeo = new THREE.CylinderGeometry(3, 3, 14, 8);
    const flameMat = new THREE.MeshBasicMaterial({ color: 0xffc46b });
    const candleMat = std(new THREE.Color(0xefe6d6));
    for (let i = 0; i < 6; i++) {
      const x = W / 2 - 100 + i * 40;
      const c = new THREE.Mesh(candleGeo, candleMat);
      c.position.set(x, 21, 104);
      const f = new THREE.Mesh(new THREE.SphereGeometry(3, 8, 6), flameMat);
      f.position.set(x, 31, 104);
      this.room.add(c, f);
    }

    // Mats: low cushions, with a larger invisible box for easy tapping.
    const matGeo = new THREE.BoxGeometry(60, 6, 40);
    const matMat = std(th.primary.clone().lerp(th.floor, 0.25));
    const hitGeo = new THREE.BoxGeometry(70, 20, 50);
    const hitMat = new THREE.MeshBasicMaterial({ visible: false });
    for (const m of L.mats) {
      const mesh = new THREE.Mesh(matGeo, matMat);
      mesh.position.set(m.x, 3, m.y);
      const hit = new THREE.Mesh(hitGeo, hitMat);
      hit.position.set(m.x, 10, m.y);
      hit.userData.mat = m.id;
      this.matHits.push(hit);
      this.room.add(mesh, hit);
    }
  }

  resize() {
    const el = this.el, r = this.renderer;
    if (!el || !r) return;
    const w = el.clientWidth || 1, h = el.clientHeight || 1;
    r.setSize(w, h, false);
    r.domElement.style.width = w + "px";
    r.domElement.style.height = h + "px";
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.fitDistance();
  }

  // Find the camera distance that keeps the room in view. On narrow (portrait)
  // screens we keep only part of the width in view and follow the player.
  fitDistance() {
    const L = S().layout;
    if (!L) return;
    const aspect = this.camera.aspect;
    this.tilt = aspect >= 1 ? TILT_WIDE : TILT_TALL;
    this.frameW = aspect >= 1.1 ? L.width : Math.min(L.width, Math.max(380, L.width * aspect * 0.95));
    const fw = this.frameW;
    const center = new THREE.Vector3(L.width / 2, 0, L.height / 2);
    const corners = [
      [center.x - fw / 2, -10], [center.x + fw / 2, -10],
      [center.x - fw / 2, L.height], [center.x + fw / 2, L.height],
    ].map(([x, z]) => new THREE.Vector3(x, 0, z));
    corners.push(new THREE.Vector3(center.x, WALL_H, -10));
    let lo = 200, hi = 8000;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      this.placeCamera(center, mid);
      const fits = corners.every((c) => {
        const p = c.clone().project(this.camera);
        // Leave room at the top and bottom for the HUD.
        return Math.abs(p.x) <= 0.96 && p.y <= 0.82 && p.y >= -0.7;
      });
      if (fits) hi = mid;
      else lo = mid;
    }
    this.dist = hi;
  }

  placeCamera(target: THREE.Vector3, dist: number) {
    this.camera.position.set(target.x, target.y + Math.sin(this.tilt) * dist, target.z + Math.cos(this.tilt) * dist);
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld();
  }

  labelSprite(text: string, mine: boolean) {
    const c = document.createElement("canvas");
    const ctx = c.getContext("2d")!;
    const font = "600 28px system-ui, sans-serif";
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width) + 20;
    c.width = w;
    c.height = 40;
    ctx.font = font;
    ctx.fillStyle = "rgba(22,19,15,0.55)";
    ctx.beginPath();
    ctx.roundRect(0, 2, w, 36, 18);
    ctx.fill();
    ctx.fillStyle = "#f3eadb";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 10, 21);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: mine ? 1 : 0.7, depthWrite: false }));
    s.scale.set(w * 0.45, 40 * 0.45, 1);
    return s;
  }

  syncAvatars() {
    const st = S();
    for (const [id, sp] of this.sprites) {
      if (!st.avatars[id]) {
        this.people.remove(sp.root);
        sp.fig.dispose();
        sp.label.material.map?.dispose();
        sp.label.material.dispose();
        this.sprites.delete(id);
        const ring = this.rings.get(id);
        if (ring) {
          this.fx.remove(ring);
          (ring.material as THREE.Material).dispose();
          this.rings.delete(id);
        }
      }
    }
    for (const a of Object.values(st.avatars)) {
      let sp = this.sprites.get(a.id);
      if (!sp) {
        const root = new THREE.Group();
        const fig = this.figures.make(this.tintOf(a));
        const shadow = new THREE.Mesh(this.geo.shadow, this.shadowMat);
        shadow.rotation.x = -Math.PI / 2;
        shadow.position.y = 0.6;
        const label = this.labelSprite(a.name, a.id === st.you);
        root.add(shadow, fig.object, label);
        this.people.add(root);
        const [x, y] = avatarPos(a, Date.now() + st.clockSkew);
        // Movements already over when we arrive are not replayed.
        sp = { root, fig, label, last: [x, y], facing: 0, seenAct: a.act?.at, seenRitual: a.ritual?.at };
        this.sprites.set(a.id, sp);
      }
    }
  }

  tintOf(a: Avatar): THREE.Color {
    if (a.defected) return GREY;
    return a.id === S().you ? this.accent : CREAM;
  }

  frame() {
    const r = this.renderer;
    const st = S();
    const L = st.layout;
    if (!r || !L) return;
    const now = Date.now() + st.clockSkew;
    const pnow = performance.now();
    const dt = Math.min(0.1, (pnow - this.lastFrame) / 1000);
    this.lastFrame = pnow;
    const manifest = st.player ? st.packs[st.player.cult]?.manifest : undefined;
    for (const a of Object.values(st.avatars)) {
      const sp = this.sprites.get(a.id);
      if (!sp) continue;
      const [x, y] = avatarPos(a, now);
      const dx = x - sp.last[0], dy = y - sp.last[1];
      const moving = Math.hypot(dx, dy) > 0.05;
      const kneeling = a.pose === "kneel" && !moving;
      if (moving) sp.facing = Math.atan2(dx, dy);
      else if (kneeling) sp.facing = Math.PI; // kneel facing the dais
      sp.last = [x, y];
      sp.root.position.set(x, 0, y);
      // Turn smoothly rather than snapping.
      const turn = Math.atan2(Math.sin(sp.facing - sp.root.rotation.y), Math.cos(sp.facing - sp.root.rotation.y));
      sp.root.rotation.y += turn * Math.min(1, dt * 12);
      // A new action or ritual from this player: play its movement.
      if (a.act && a.act.at !== sp.seenAct) {
        sp.seenAct = a.act.at;
        sp.fig.play(clipFor(a.act.id, manifest));
      }
      if (a.ritual && a.ritual.at !== sp.seenRitual) {
        sp.seenRitual = a.ritual.at;
        sp.fig.play(clipFor("ritual." + a.ritual.id, manifest));
      }
      sp.fig.update(dt, { moving, kneel: kneeling, tint: this.tintOf(a) });
      sp.label.position.set(0, sp.fig.headY() + 14, 0);
      this.ritualRing(a);
    }

    // Walking to a mat: kneel on arrival.
    if (this.kneelTarget && st.you) {
      const me = st.avatars[st.you];
      const m = L.mats.find((x) => x.id === this.kneelTarget);
      if (me && m) {
        const [x, y] = avatarPos(me, now);
        if (Math.hypot(x - m.x, y - m.y) < 4) {
          kneel(m.id);
          this.kneelTarget = null;
        }
      }
    }

    if (this.marker) {
      const age = (performance.now() - this.marker.at) / 1000;
      const m = this.marker.mesh;
      if (age > 0.8) {
        this.fx.remove(m);
        (m.material as THREE.Material).dispose();
        this.marker = undefined;
      } else {
        const s = 10 + age * 18;
        m.scale.set(s, s, s);
        (m.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - age / 0.8);
      }
    }

    // Camera: fixed angle; on narrow screens follow your avatar sideways.
    const me = st.you ? this.sprites.get(st.you) : undefined;
    let tx = L.width / 2;
    if (me && this.frameW < L.width) {
      const half = this.frameW / 2;
      tx = THREE.MathUtils.clamp(me.root.position.x, half, L.width - half);
    } else if (me) {
      tx = L.width / 2 + (me.root.position.x - L.width / 2) * 0.08;
    }
    const tz = L.height / 2 + (me ? (me.root.position.z - L.height / 2) * 0.08 : 0);
    if (this.target.lengthSq() === 0) this.target.set(tx, 0, tz);
    this.target.x += (tx - this.target.x) * 0.06;
    this.target.z += (tz - this.target.z) * 0.06;
    this.placeCamera(this.target, this.dist);
    r.render(this.scene, this.camera);
  }

  ritualRing(a: Avatar) {
    let ring = this.rings.get(a.id);
    const age = a.ritual ? (Date.now() - a.ritual.at) / 1000 : Infinity;
    if (age > 2.5) {
      if (ring) ring.visible = false;
      return;
    }
    const th = this.theme();
    if (!ring) {
      ring = new THREE.Mesh(this.geo.ring, new THREE.MeshBasicMaterial({ color: th.accent, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2;
      this.rings.set(a.id, ring);
      this.fx.add(ring);
    }
    const conv = S().convergence;
    const strong = !!conv && Date.now() - conv.at < 2500 && conv.key === "ritual:" + a.ritual!.id;
    const sp = this.sprites.get(a.id);
    if (sp) ring.position.set(sp.root.position.x, 1.5, sp.root.position.z);
    const s = 20 + age * 26;
    ring.scale.set(s, s, s);
    ring.visible = true;
    (ring.material as THREE.MeshBasicMaterial).opacity = (strong ? 0.95 : 0.6) * (1 - age / 2.5);
  }

  onDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY };
  };

  onUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = undefined;
    // A tap, not a drag or a scroll.
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 12) return;
    this.tap(e.clientX, e.clientY);
  };

  tap(cx: number, cy: number) {
    const st = S();
    const L = st.layout;
    const r = this.renderer;
    if (!L || !r) return;
    const rect = r.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObjects(this.matHits, false)[0];
    if (hit) {
      const id = hit.object.userData.mat as string;
      const mat = L.mats.find((m) => m.id === id);
      const taken = Object.values(st.avatars).some((a) => a.mat === id && a.id !== st.you);
      if (mat && !taken) {
        this.kneelTarget = mat.id;
        this.showMarker(mat.x, mat.y);
        walkTo(mat.x, mat.y);
      }
      return;
    }
    const p = new THREE.Vector3();
    if (!ray.ray.intersectPlane(this.floorPlane, p)) return;
    this.kneelTarget = null;
    const x = Math.max(20, Math.min(L.width - 20, p.x));
    const y = Math.max(20, Math.min(L.height - 20, p.z));
    this.showMarker(x, y);
    walkTo(x, y);
  }

  showMarker(x: number, y: number) {
    if (this.marker) {
      this.fx.remove(this.marker.mesh);
      (this.marker.mesh.material as THREE.Material).dispose();
    }
    const mesh = new THREE.Mesh(this.geo.ring, new THREE.MeshBasicMaterial({ color: this.theme().accent, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 1.2, y);
    this.fx.add(mesh);
    this.marker = { mesh, at: performance.now() };
  }
}
