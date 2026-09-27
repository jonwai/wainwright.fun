/**
 * One-off verification: the Chores PWA must appear as a Home Screen Web Clip
 * in every child's generated profile (hidden from the site, pinned to Home
 * Screen). Run: AWS_PROFILE=email npx tsx scripts/verify-chores-clip.ts
 */
import { loadConfig, generateProfile, webClipSites } from "./config.js";
import { resolveChildConfig, listChildSubdomains } from "./resolve.js";

const config = loadConfig();
let failures = 0;

for (const sub of listChildSubdomains(config)) {
  const resolved = resolveChildConfig(
    config,
    sub,
    new Date().toISOString(),
    config.restrictions ?? []
  );

  // 1. Chores must be in the resolved websites (bookmark allowlist).
  const chores = resolved.websites.find((w) =>
    w.url.startsWith("https://chores.")
  );
  if (!chores) {
    console.error(`✗ ${sub}: Chores missing from resolved websites`);
    failures++;
    continue;
  }

  // 2. Chores must NOT appear on the child's site (hidden).
  const visibleOnSite = resolved.items.some(
    (item) => item.kind === "website" && item.url.startsWith("https://chores.")
  );
  if (visibleOnSite) {
    console.error(`✗ ${sub}: Chores is visible on the child site (should be hidden)`);
    failures++;
  }

  // 3. Chores must be in webClipSites() → gets a web clip payload.
  const clips = webClipSites(resolved);
  const choresClip = clips.find((c) => c.url.startsWith("https://chores."));
  if (!choresClip) {
    console.error(`✗ ${sub}: Chores missing from webClipSites()`);
    failures++;
    continue;
  }

  // 4. The generated profile XML must contain the web clip payload.
  const profile = generateProfile(resolved, resolved.restrictions);
  const payloadOk =
    profile.includes("com.apple.webClip.managed") &&
    profile.includes("https://chores.wainwright.fun");
  if (!payloadOk) {
    console.error(`✗ ${sub}: profile XML missing Chores web clip payload`);
    failures++;
    continue;
  }

  // 5. com.apple.webapp must be in the app allowlist (web clips hidden without it).
  const webappOk = profile.includes("com.apple.webapp");
  if (!webappOk) {
    console.error(`✗ ${sub}: com.apple.webapp missing from bundle allowlist`);
    failures++;
    continue;
  }

  console.log(
    `✓ ${sub}: hidden from site, ${clips.length} web clips incl. Chores, payload OK`
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll children have the Chores web clip.");
