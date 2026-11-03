// Checks that the client's mini game mirror (apps/web/src/minigame/core.ts)
// matches the server's golden values (server/minigame TestLayoutGolden).
//   node --experimental-strip-types scripts/check-minigame.mjs
import { rng, layout, score } from "../apps/web/src/minigame/core.ts";

const r = rng(12345);
const want = [0.97972826776094735, 0.30675226449966431, 0.484205421525985];
let ok = true;
for (const w of want) {
  const got = r();
  if (got !== w) { console.error(`mulberry32 mismatch: ${got} != ${w}`); ok = false; }
}
const b = layout("beat", 12345);
if (b.beats[1] !== 1860 || b.lengthMs !== 5200) { console.error("beat layout mismatch", b); ok = false; }
// Seed 777, printed by the Go side.
if (layout("flick", 777).strangers[1].speed !== 0.47460059002041816) { console.error("flick layout mismatch"); ok = false; }
if (layout("timing", 777).zones[2].c !== 0.3154323977883905) { console.error("timing layout mismatch"); ok = false; }
const perfect = score("beat", 12345, b.beats.map((t) => ({ t })));
if (perfect.q !== 1) { console.error("perfect beat round did not score 1", perfect); ok = false; }
console.log(ok ? "minigame mirror matches the server" : "MISMATCH");
process.exit(ok ? 0 : 1);
