// The compound in 3D: the same room as CompoundScene (2D), drawn with
// Three.js. The server's floor is unchanged: its (x, y) is world (x, 0, y),
// in the same units, so walks, prediction and kneeling work as they do in 2D.
// The camera sits at a fixed angle and follows your avatar a little.
import * as THREE from "three";
import { useStore, S, type Avatar } from "./store";
import { avatarPos, kneel, walkTo } from "./game";
import { Figures, loadModel, type Figure } from "./Figure";
import { clipFor } from "./anim";
import { loadProps, PropMaker } from "./Props";
import { buildRoom3D } from "./Room3D";
import { emblemCanvas } from "./emblem";

// Camera angle down from horizontal: steeper on portrait screens, so the
// room uses the tall screen instead of leaving empty sky and ground.
const TILT_WIDE = THREE.MathUtils.degToRad(52);
const TILT_TALL = THREE.MathUtils.degToRad(66);
const FOV = 38;

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
  frameW = 0; // floor kept in view around you (narrower on portrait screens)
  frameD = 0;
  zoom = 1; // pinch or mouse wheel: 0.6 (closer) .. 2.2 (farther)
  pointers = new Map<number, { x: number; y: number }>();
  pinch?: number;
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
  hemi = new THREE.HemisphereLight(0xfff1dc, 0x2a1f16, 1.6);
  sun = new THREE.DirectionalLight(0xffe2b8, 1.6);
  props?: Awaited<ReturnType<typeof loadProps>>;
  propsFailed = false;
  propMaker?: PropMaker;
  seats = new Map<string, { height: number; facing: number }>();
  roomId = 0; // bumps on each rebuild, so a late emblem never lands in an old room
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
    this.sun.position.set(-300, 900, 500);
    this.scene.add(this.hemi, this.sun, this.room, this.people, this.fx);

    r.domElement.addEventListener("pointerdown", this.onDown);
    r.domElement.addEventListener("pointerup", this.onUp);
    r.domElement.addEventListener("pointercancel", this.onUp);
    r.domElement.addEventListener("pointermove", this.onMove);
    r.domElement.addEventListener("wheel", this.onWheel, { passive: false });
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
    r.domElement.removeEventListener("pointercancel", this.onUp);
    r.domElement.removeEventListener("pointermove", this.onMove);
    r.domElement.removeEventListener("wheel", this.onWheel);
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
        // Furniture shares its geometry and materials with the model library.
        if (o.userData.shared) return;
        (o as THREE.Mesh).geometry?.dispose();
        const mat = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
        mat?.map?.dispose();
        mat?.dispose();
      });
    }
    this.propMaker?.dispose();
    this.matHits = [];
    const id = ++this.roomId;
    if (!L) return;
    const th = this.theme();
    this.accent = th.accent;
    const st = S();
    const pack = st.player ? st.packs[st.player.cult] : undefined;
    const def = pack?.scene;
    // Furnished rooms need the furniture models: build a plain room now and
    // rebuild once they arrive (or stay plain if they fail to load).
    if (def && !this.props && !this.propsFailed) {
      loadProps()
        .then((lib) => {
          if (this.destroyed || id !== this.roomId) return;
          this.props = lib;
          this.buildRoom();
        })
        .catch(() => (this.propsFailed = true));
    }
    this.propMaker = this.props ? new PropMaker(this.props) : undefined;
    const built = buildRoom3D(this.room, L, th, def, this.propMaker);
    this.matHits = built.matHits;
    this.seats = built.seats;
    this.hemi.color.copy(built.light.sky);
    this.hemi.groundColor.copy(built.light.ground);
    this.hemi.intensity = built.light.intensity;
    this.sun.color.copy(built.light.sun);
    this.sun.intensity = built.light.intensity;
    this.scene.background = built.light.background;
    (this.scene.fog as THREE.Fog).color.copy(built.light.background);

    // The leader's portrait, deliberately pixelated: drawn tiny, shown with
    // nearest-neighbour filtering so it stays blocky up close.
    if (built.portrait && pack?.portrait) {
      const p = built.portrait;
      emblemCanvas(pack.portrait, 160).then((c) => {
        if (!c || id !== this.roomId || this.destroyed) return;
        const small = document.createElement("canvas");
        small.width = 16;
        small.height = 20;
        small.getContext("2d")?.drawImage(c, 0, 0, c.width, c.height * 1.0, 0, 0, 16, 20);
        const tex = new THREE.CanvasTexture(small);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.magFilter = tex.minFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        const pic = new THREE.Mesh(new THREE.PlaneGeometry(p.width, p.width * 1.25), new THREE.MeshBasicMaterial({ map: tex }));
        pic.position.copy(p.at);
        this.room.add(pic);
      });
    }

    // A banner on the back wall behind the dais, carrying the cult's emblem.
    if (built.banner) {
      const b = built.banner;
      const std = (c: THREE.Color, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, ...extra });
      const banner = new THREE.Mesh(new THREE.PlaneGeometry(110, 104), std(th.primary.clone().multiplyScalar(0.35)));
      banner.position.set(b.x, b.y - 2, b.z + 8);
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 124, 8), std(th.accent, { metalness: 0.4, roughness: 0.5 }));
      rod.rotation.z = Math.PI / 2;
      rod.position.set(b.x, b.y + 51, b.z + 10);
      this.room.add(banner, rod);
      emblemCanvas(pack?.emblem, 256).then((c) => {
        if (!c || id !== this.roomId || this.destroyed) return;
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        const emblem = new THREE.Mesh(new THREE.PlaneGeometry(84, 84), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
        emblem.position.set(b.x, b.y, b.z + 9);
        this.room.add(emblem);
      });
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
    // Keep a patch of floor around you in view, not the whole room: about
    // five or six mats across on a wide screen, three on a phone.
    this.frameW = Math.min(L.width, aspect >= 1 ? 560 : 250);
    this.frameD = Math.min(L.height, this.frameW * (aspect >= 1 ? 0.55 : 1.1));
    const fw = this.frameW, fd = this.frameD;
    const center = new THREE.Vector3(L.width / 2, 0, L.height / 2);
    const corners = [
      [center.x - fw / 2, center.z - fd / 2], [center.x + fw / 2, center.z - fd / 2],
      [center.x - fw / 2, center.z + fd / 2], [center.x + fw / 2, center.z + fd / 2],
    ].map(([x, z]) => new THREE.Vector3(x, 0, z));
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
      const seat = kneeling && a.mat ? this.seats.get(a.mat) : undefined;
      if (kneeling) sp.facing = seat?.facing ?? Math.PI; // the seat's way, else facing the dais
      sp.last = [x, y];
      // Sitting on a chair or bench lifts the figure to its seat.
      const lift = seat?.height ?? 0;
      sp.root.position.set(x, sp.root.position.y + (lift - sp.root.position.y) * Math.min(1, dt * 8), y);
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

    // Camera: fixed angle, close behind you, following as you walk. Near the
    // walls it stops a little short so the view doesn't drift off the room.
    const me = st.you ? this.sprites.get(st.you) : undefined;
    let tx = L.width / 2, tz = L.height / 2;
    if (me) {
      const mx = Math.min(this.frameW * 0.3 * this.zoom, L.width / 2);
      const back = Math.min(this.frameD * 0.25 * this.zoom, L.height / 2);
      const front = Math.min(this.frameD * 0.5 * this.zoom, L.height / 2);
      tx = THREE.MathUtils.clamp(me.root.position.x, mx, L.width - mx);
      tz = THREE.MathUtils.clamp(me.root.position.z, back, L.height - front);
    }
    if (this.target.lengthSq() === 0) this.target.set(tx, 0, tz);
    const k = Math.min(1, dt * 4);
    this.target.x += (tx - this.target.x) * k;
    this.target.z += (tz - this.target.z) * k;
    this.placeCamera(this.target, this.dist * this.zoom);
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
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      this.down = undefined; // a pinch, not a tap
      this.pinch = this.pinchDist();
    } else this.down = { x: e.clientX, y: e.clientY };
  };

  onMove = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2 && this.pinch) {
      const d = this.pinchDist();
      this.setZoom(this.zoom * (this.pinch / d));
      this.pinch = d;
    }
  };

  onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.setZoom(this.zoom * Math.exp(e.deltaY * 0.001));
  };

  pinchDist() {
    const [a, b] = [...this.pointers.values()];
    return Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
  }

  setZoom(z: number) {
    this.zoom = THREE.MathUtils.clamp(z, 0.6, 2.2);
  }

  onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = undefined;
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
