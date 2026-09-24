/**
 * Sync the home-twin runtime assets into twin/public/ (replacing the dev-time
 * symlinks, which vite would otherwise copy wholesale — including
 * __pycache__ and the 175MB third_party scan library).
 *
 * Copies only what the viewer fetches at runtime:
 *   model/     house.glb + house-summary.json
 *   furniture/ catalogue.json + placements.json + assets/*.glb
 *   lights/     catalogue.json + placements.json + assets/*.glb
 *
 * Run: npx tsx scripts/sync-twin-assets.ts   (from wainwright.fun root)
 * Source: ~/Documents/home-twin (TWIN_SRC override).
 */
import { cpSync, mkdirSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = process.env.TWIN_SRC ?? `${process.env.HOME}/Documents/home-twin`;
const OUT = join(ROOT, "twin/public");

function readJson(rel: string): any {
  return JSON.parse(readFileSync(join(SRC, rel), "utf8"));
}

function copyFile(rel: string): void {
  const from = join(SRC, rel);
  const to = join(OUT, rel);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}

// ---- model ----
copyFile("model/house.glb");
copyFile("model/house-summary.json");

// ---- furniture + lights: catalogue, placements, assets ----
for (const dir of ["furniture", "lights"]) {
  copyFile(`${dir}/catalogue.json`);
  copyFile(`${dir}/placements.json`);
  const placements: any[] = readJson(`${dir}/placements.json`).placements ?? [];
  const catalogue: any[] = readJson(`${dir}/catalogue.json`);
  const byId = new Map<string, any>(catalogue.map((c) => [c.id, c]));
  const wanted = new Set<string>();
  for (const p of placements) {
    const cat = byId.get(p.catalogue_id);
    if (cat?.asset) wanted.add(cat.asset);
  }
  // Keep every catalogue .glb on disk — the viewer lazy-loads any of
  // them (proxy-box fallback covers missing ones).
  const assetsDir = join(SRC, dir, "assets");
  let copied = 0;
  for (const f of readdirSync(assetsDir)) {
    if (!f.endsWith(".glb")) continue;
    copyFile(`${dir}/assets/${f}`);
    copied++;
  }
  console.log(
    `${dir}: ${placements.length} placements, ${copied} assets copied, ` +
    `${wanted.size} referenced by placements`
  );
}

// ---- report ----
function walk(p: string): number {
  let total = 0;
  for (const e of readdirSync(p)) {
    const full = join(p, e);
    if (statSync(full).isDirectory()) total += walk(full);
    else total += statSync(full).size;
  }
  return total;
}
for (const d of ["model", "furniture", "lights"]) {
  console.log(`twin/public/${d}: ${(walk(join(OUT, d)) / 1e6).toFixed(1)}MB`);
}
console.log("done");
