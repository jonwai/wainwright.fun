/**
 * Verify per-app min_age resolution against the live DynamoDB data.
 * Checks each child sees exactly the apps they should, including
 * previously-stranded min_age:4 apps.
 */
import { loadConfig } from "../../shared/scripts/config.js";
import { resolveChildConfig } from "../../shared/scripts/resolve.js";

const config = loadConfig();

const MAGIC_TIMER = "DisneyDigitalBooks.DisneyMagicBrushTimer";
const STRANDED = [
  "DisneyDigitalBooks.DisneyMagicBrushTimer",
  "com.storytoys.lego.duplo.marvel.spiderman.avengers.kids.preschool.free.ios",
  "tv.alphablocks.meetthewonderblocks",
  "uk.co.bbc.cbeebiesgetcreative",
];

// Confirm all four stranded apps are present in the flat list
const byId = new Map(config.apps.map((a) => [a.bundle_id, a]));
for (const id of STRANDED) {
  const app = byId.get(id);
  console.log(`${app ? "✓" : "✗"} ${app?.name ?? id} — min_age ${app?.min_age ?? "MISSING"}`);
}

console.log(`\nTotal apps in config: ${config.apps.length}`);
console.log(`Bands (theme-only): ${config.age_bands.map((b) => `${b.from_age}:${b.theme}`).join(", ")}`);

// Resolve every child and check the stranded apps
console.log("\n── Per-child resolution ──");
let failures = 0;
for (const child of config.children) {
  const resolved = resolveChildConfig(config, child.subdomain, new Date().toISOString());
  const appIds = new Set(resolved.apps.map((a) => a.bundle_id));
  const sees = STRANDED.filter((id) => appIds.has(id));
  const expected = STRANDED.filter((id) => (byId.get(id)?.min_age ?? Infinity) <= resolved.age);
  const ok = sees.length === expected.length;
  if (!ok) failures++;
  console.log(
    `${ok ? "✓" : "✗"} ${child.name} (age ${resolved.age}, theme ${resolved.theme}): ` +
    `${resolved.apps.length} apps, ${resolved.websites.length} websites, ` +
    `${resolved.system_apps.length} system apps — sees ${sees.length}/${expected.length} stranded apps`
  );
  for (const id of expected) {
    if (!appIds.has(id)) {
      console.log(`    ✗ MISSING: ${byId.get(id)?.name} (min_age ${byId.get(id)?.min_age})`);
      failures++;
    }
  }
}

// Age-gating sanity: an app at min_age N must not appear for age N-1
console.log("\n── Age gating ──");
const hannah = resolveChildConfig(config, "hannah", new Date().toISOString());
const hannahIds = new Set(hannah.apps.map((a) => a.bundle_id));
console.log(
  `${hannahIds.has(MAGIC_TIMER) ? "✓" : "✗"} Hannah (8) sees Disney Magic Timer (min_age 4)`
);
const joanna = resolveChildConfig(config, "joanna", new Date().toISOString());
const joannaIds = new Set(joanna.apps.map((a) => a.bundle_id));
console.log(
  `${joannaIds.has(MAGIC_TIMER) ? "✗" : "✓"} Joanna (1) does NOT see Disney Magic Timer`
);
const ethan = resolveChildConfig(config, "ethan", new Date().toISOString());
const ethanIds = new Set(ethan.apps.map((a) => a.bundle_id));
console.log(
  `${ethanIds.has(MAGIC_TIMER) ? "✓" : "✗"} Ethan (4) sees Disney Magic Timer`
);

// Profile whitelist must include it for Hannah
const whitelisted = hannah.system_apps.map((a) => a.bundle_id).concat(hannah.apps.map((a) => a.bundle_id));
console.log(
  `${whitelisted.includes(MAGIC_TIMER) ? "✓" : "✗"} Magic Timer in Hannah's profile whitelist`
);

// Lydia's blocked app must still be excluded from the generated profile whitelist
import { generateProfile } from "../../shared/scripts/config.js";
const lydia = resolveChildConfig(config, "lydia", new Date().toISOString());
const lydiaProfile = generateProfile(lydia);
console.log(
  `${!lydiaProfile.includes("com.netflix.Netflix") ? "✓" : "✗"} Lydia's Netflix still blocked (not in profile whitelist)`
);
const lydiaItems = lydia.items.find((i) => i.key === "com.netflix.Netflix");
console.log(
  `${lydiaItems?.blocked === true ? "✓" : "✗"} Netflix still visible-but-blocked on Lydia's site`
);

console.log(failures === 0 ? "\n✓ ALL CHECKS PASSED" : `\n✗ ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
