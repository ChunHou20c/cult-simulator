// Dev-only 3D preview with fake players, no server needed:
//   npm run dev -w apps/web, then open /preview3d.html?cult=synanon
// Not part of the production build (Vite only builds index.html).
import { S } from "./src/store";
import { CompoundScene3D } from "./src/CompoundScene3D";
const cult = new URLSearchParams(location.search).get("cult") || "rajneeshpuram";
const mods = import.meta.glob("../../content/cults/*/*.json", { eager: true }) as Record<string, any>;
const manifest = mods[`../../content/cults/${cult}/manifest.json`].default;
const compound = mods[`../../content/cults/${cult}/compound.json`].default;
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
avatars.me = { id: "me", name: "You (Still Lantern)", fx: compound.width / 2, fy: compound.height - 80, tx: compound.width / 2, ty: compound.height - 80, t0: 0, pose: "stand" };
S().set({ you: "me", avatars, layout: compound, player: { cult } as any, packs: { [cult]: { manifest } as any }, convergence: { key: "ritual:chant", at: now + 300 } });
new CompoundScene3D().mount(document.getElementById("c")!);
(window as any).S = S;
