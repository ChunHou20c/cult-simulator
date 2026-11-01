// The compound canvas: one PixiJS scene for the room. Drawn from the
// pack's compound layout and theme colours, so any cult renders.
import { Application, Container, Graphics, Text, FederatedPointerEvent } from "pixi.js";
import { useStore, S, type Avatar } from "./store";
import { avatarPos, kneel, walkTo } from "./game";

const hex = (s: string | undefined, fallback: number) => (s ? parseInt(s.slice(1), 16) : fallback);

export class CompoundScene {
  app = new Application();
  world = new Container();
  mats = new Container();
  people = new Container();
  sprites = new Map<string, { root: Container; body: Graphics; ring: Graphics; label: Text }>();
  kneelTarget: string | null = null;
  unsub?: () => void;
  ready = false;
  destroyed = false;

  async mount(el: HTMLElement) {
    await this.app.init({ resizeTo: el, background: 0x16130f, antialias: true, resolution: Math.min(2, window.devicePixelRatio || 1), autoDensity: true });
    if (this.destroyed) {
      this.app.destroy(true);
      return;
    }
    el.appendChild(this.app.canvas);
    this.app.stage.addChild(this.world);
    this.world.addChild(this.mats, this.people);
    this.world.eventMode = "static";
    this.world.on("pointertap", (e: FederatedPointerEvent) => this.tap(e));
    this.ready = true;
    this.drawRoom();
    this.unsub = useStore.subscribe((s, prev) => {
      if (s.layout !== prev.layout || s.player?.cult !== prev.player?.cult) this.drawRoom();
      if (s.avatars !== prev.avatars) this.syncAvatars();
    });
    this.syncAvatars();
    this.app.ticker.add(() => this.frame());
  }

  destroy() {
    this.destroyed = true;
    this.unsub?.();
    if (this.ready) this.app.destroy(true, { children: true });
  }

  theme() {
    const st = S();
    const pack = st.player ? st.packs[st.player.cult] : undefined;
    const t = pack?.manifest.theme ?? {};
    return { primary: hex(t.primary, 0x8a6a4a), accent: hex(t.accent, 0xe0b44c), floor: hex(t.floor, 0x2a221b) };
  }

  drawRoom() {
    const st = S();
    const L = st.layout;
    if (!L || !this.ready) return;
    const th = this.theme();
    this.mats.removeChildren();
    const floor = new Graphics().roundRect(0, 0, L.width, L.height, 24).fill(th.floor);
    floor.eventMode = "static";
    this.mats.addChild(floor);
    // A low dais at the top for the leader's empty seat.
    this.mats.addChild(new Graphics().roundRect(L.width / 2 - 120, 40, 240, 70, 16).fill({ color: th.primary, alpha: 0.35 }));
    this.mats.addChild(new Graphics().circle(L.width / 2, 75, 18).fill({ color: th.accent, alpha: 0.8 }));
    for (const m of L.mats) {
      const g = new Graphics().roundRect(m.x - 30, m.y - 20, 60, 40, 10).fill({ color: th.primary, alpha: 0.55 }).stroke({ color: th.accent, alpha: 0.35, width: 2 });
      this.mats.addChild(g);
    }
    this.fit();
    this.app.renderer.on("resize", () => this.fit());
  }

  fit() {
    const L = S().layout;
    if (!L) return;
    const w = this.app.renderer.width / this.app.renderer.resolution;
    const h = this.app.renderer.height / this.app.renderer.resolution;
    const s = Math.min(w / L.width, h / L.height);
    this.world.scale.set(s);
    this.world.position.set((w - L.width * s) / 2, (h - L.height * s) / 2);
  }

  syncAvatars() {
    if (!this.ready) return;
    const st = S();
    const th = this.theme();
    for (const [id, sp] of this.sprites) {
      if (!st.avatars[id]) {
        sp.root.destroy({ children: true });
        this.sprites.delete(id);
      }
    }
    for (const a of Object.values(st.avatars)) {
      let sp = this.sprites.get(a.id);
      if (!sp) {
        const root = new Container();
        const ring = new Graphics();
        const body = new Graphics();
        const label = new Text({ text: a.name, style: { fontFamily: "system-ui, sans-serif", fontSize: 13, fill: 0xf3eadb } });
        label.anchor.set(0.5, 0);
        label.position.set(0, 20);
        label.alpha = a.id === st.you ? 1 : 0.7;
        root.addChild(ring, body, label);
        this.people.addChild(root);
        sp = { root, body, ring, label };
        this.sprites.set(a.id, sp);
      }
      const color = a.defected ? 0x8c8c8c : a.id === st.you ? th.accent : 0xefe6d6;
      sp.body.clear();
      if (a.pose === "kneel") sp.body.ellipse(0, 4, 15, 11).fill(color).circle(0, -8, 7).fill(color);
      else sp.body.roundRect(-11, -14, 22, 30, 10).fill(color).circle(0, -18, 7).fill(color);
    }
  }

  frame() {
    const st = S();
    const now = Date.now() + st.clockSkew;
    for (const a of Object.values(st.avatars)) {
      const sp = this.sprites.get(a.id);
      if (!sp) continue;
      const [x, y] = avatarPos(a, now);
      sp.root.position.set(x, y);
      sp.root.zIndex = y;
      this.ritualRing(sp.ring, a);
    }
    this.people.sortableChildren = true;
    // Walking to a mat: kneel on arrival.
    if (this.kneelTarget && st.you && st.layout) {
      const me = st.avatars[st.you];
      const m = st.layout.mats.find((x) => x.id === this.kneelTarget);
      if (me && m) {
        const [x, y] = avatarPos(me, now);
        if (Math.hypot(x - m.x, y - m.y) < 4) {
          kneel(m.id);
          this.kneelTarget = null;
        }
      }
    }
  }

  ritualRing(g: Graphics, a: Avatar) {
    g.clear();
    if (!a.ritual) return;
    const age = (Date.now() - a.ritual.at) / 1000;
    if (age > 2.5) return;
    const conv = S().convergence;
    const strong = conv && Date.now() - conv.at < 2500 && conv.key === "ritual:" + a.ritual.id;
    const th = this.theme();
    g.circle(0, -2, 18 + age * 22).stroke({ color: th.accent, alpha: (strong ? 0.9 : 0.55) * (1 - age / 2.5), width: strong ? 4 : 2 });
  }

  tap(e: FederatedPointerEvent) {
    const st = S();
    if (!st.layout) return;
    const p = this.world.toLocal(e.global);
    const mat = st.layout.mats.find((m) => Math.abs(p.x - m.x) < 32 && Math.abs(p.y - m.y) < 22);
    if (mat) {
      const taken = Object.values(st.avatars).some((a) => a.mat === mat.id && a.id !== st.you);
      if (taken) return;
      this.kneelTarget = mat.id;
      walkTo(mat.x, mat.y);
      return;
    }
    this.kneelTarget = null;
    walkTo(Math.max(20, Math.min(st.layout.width - 20, p.x)), Math.max(20, Math.min(st.layout.height - 20, p.y)));
  }
}
