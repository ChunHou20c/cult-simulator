// Fails on any literal cult id in the client source. Cults are data: the
// client renders any cult from its pack and never names one.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const ids = ["cults", "fixtures"].flatMap((d) => {
  try {
    return readdirSync(join(root, "content", d)).filter((n) => statSync(join(root, "content", d, n)).isDirectory());
  } catch {
    return [];
  }
});
const re = new RegExp(`\\b(${ids.join("|")})\\b`);
let bad = 0;
function walk(dir) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx|js|css)$/.test(n)) {
      readFileSync(p, "utf8").split("\n").forEach((line, i) => {
        const m = line.match(re);
        if (m) {
          console.error(`${p}:${i + 1} names cult "${m[1]}"; read it from the pack instead`);
          bad++;
        }
      });
    }
  }
}
walk(join(root, "apps", "web", "src"));
if (bad) process.exit(1);
console.log(`no cult ids in apps/web/src (${ids.length} ids checked)`);
