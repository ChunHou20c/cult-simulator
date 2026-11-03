// Dev-only 3D preview with fake players, no server needed:
//   npm run dev -w apps/web, then open /preview3d.html?cult=synanon
// Add &2d=1 to see the same room in the 2D view.
// Not part of the production build (Vite only builds index.html).
import { S } from "./src/store";
import { CompoundScene3D } from "./src/CompoundScene3D";
import { CompoundScene } from "./src/CompoundScene";
const cult = new URLSearchParams(location.search).get("cult") || "rajneeshpuram";
const mods = import.meta.glob("../../content/cults/*/*.json", { eager: true }) as Record<string, any>;
const manifest = mods[`../../content/cults/${cult}/manifest.json`].default;
const compound = mods[`../../content/cults/${cult}/compound.json`].default;
const sceneDef = mods[`../../content/cults/${cult}/scene.json`]?.default;
const emblems = import.meta.glob("../../content/cults/*/emblem.svg", { eager: true, query: "?raw", import: "default" }) as Record<string, string>;
const emblemSVG = emblems[`../../content/cults/${cult}/emblem.svg`];
const portraits = import.meta.glob("../../content/cults/*/portrait.svg", { eager: true, query: "?raw", import: "default" }) as Record<string, string>;
const portraitSVG = portraits[`../../content/cults/${cult}/portrait.svg`];
const portrait = portraitSVG ? "data:image/svg+xml;charset=utf-8," + encodeURIComponent(portraitSVG) : undefined;
const emblem = emblemSVG ? "data:image/svg+xml;charset=utf-8," + encodeURIComponent(emblemSVG) : undefined;
const now = Date.now();
const avatars: any = {};
const names = ["Quiet Heron", "Amber Moth", "Slow River", "Dusk Finch", "Pale Cedar", "Open Hand", "Still Water", "Ember Fox"];
for (let i = 0; i < 24; i++) {
  const id = "p" + i;
  const m = compound.mats[i % compound.mats.length];
  const kneel = i < 10;
  const x = kneel ? m.x : 60 + ((i * 137) % (compound.width - 120)), y = kneel ? m.y : 140 + ((i * 89) % (compound.height - 180));
  avatars[id] = { id, name: names[i % names.length], fx: x, fy: y, tx: kneel ? x : x + 120, ty: kneel ? y : y + 40, t0: kneel ? 0 : now, pose: kneel ? "kneel" : "stand", mat: kneel ? m.id : undefined, ritual: i === 3 || i === 5 ? { id: "chant", at: now + 300 } : undefined, defected: i === 20 };
}
// ?at=x,y puts you somewhere else (the camera follows you).
const [ax, ay] = (new URLSearchParams(location.search).get("at") ?? `${compound.width / 2},${compound.height - 80}`).split(",").map(Number);
avatars.me = { id: "me", name: "You (Still Lantern)", fx: ax, fy: ay, tx: ax, ty: ay, t0: 0, pose: "stand" };
S().set({ you: "me", avatars, layout: compound, player: { cult } as any, packs: { [cult]: { manifest, emblem, portrait, scene: sceneDef } as any }, convergence: { key: "ritual:chant", at: now + 300 } });
const flat = new URLSearchParams(location.search).has("2d");
const view = new CompoundScene3D();
if (flat) new CompoundScene().mount(document.getElementById("c")!);
else view.mount(document.getElementById("c")!);
// ?zoom=0.6 moves the camera closer (like pinch or the mouse wheel).
const zoom = Number(new URLSearchParams(location.search).get("zoom"));
if (zoom) view.zoom = zoom;
(window as any).S = S;

// Fake room activity: someone does an action or a ritual every so often.
// ?clip=<id> makes every standing player do that one movement (to check it).
const acts = [...(manifest.sharedActions ?? ["recruit", "fundraise", "ritual", "lie_low", "open_doors"]), ...manifest.actions.map((a: any) => a.id)];
const rituals = ["bow", "chant", "beads", "candle"];
const only = new URLSearchParams(location.search).get("clip");
if (only) {
  (manifest.animations ??= {}).recruit = only;
  setTimeout(() => {
    const st = S();
    const next = { ...st.avatars };
    for (const a of Object.values(next) as any[]) if (a.pose !== "kneel") next[a.id] = { ...a, fx: a.tx, fy: a.ty, act: { id: "recruit", at: Date.now() } };
    st.set({ avatars: next });
  }, 1500);
} else {
  setInterval(() => {
    const st = S();
    const ids = Object.keys(st.avatars);
    const id = ids[Math.floor(Math.random() * ids.length)];
    const a = st.avatars[id];
    const ritual = Math.random() < 0.3;
    st.set({ avatars: { ...st.avatars, [id]: ritual ? { ...a, ritual: { id: rituals[Math.floor(Math.random() * 4)], at: Date.now() } } : { ...a, act: { id: acts[Math.floor(Math.random() * acts.length)], at: Date.now() } } } });
  }, 700);
}
