// Copies every pack in content/cults to apps/web/public/packs/<id>/<hash>/,
// using the same content hash as the server (server/content/load.go
// HashDir), so asset URLs are cached forever and a new version is a new URL.
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const cults = join(root, "content", "cults");
const out = join(root, "apps", "web", "public", "packs");

function files(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

export function hashDir(dir) {
  const rels = files(dir).map((f) => relative(dir, f).split(sep).join("/")).sort();
  const h = createHash("sha256");
  for (const r of rels) {
    h.update(r);
    h.update(Buffer.from([0]));
    h.update(readFileSync(join(dir, r)));
    h.update(Buffer.from([0]));
  }
  return h.digest("hex").slice(0, 12);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const index = {};
for (const id of readdirSync(cults)) {
  const dir = join(cults, id);
  if (!statSync(dir).isDirectory()) continue;
  const hash = hashDir(dir);
  cpSync(dir, join(out, id, hash), { recursive: true });
  index[id] = hash;
  console.log(`pack ${id} -> /packs/${id}/${hash}/`);
}
writeFileSync(join(out, "index.json"), JSON.stringify(index, null, 2));
