/**
 * One-off verification: the Brush Time web app must appear as a Home Screen Web Clip
 * in every child's generated profile (hidden from the site, pinned to Home
 * Screen). Run: AWS_PROFILE=email npx tsx scripts/verify-brush-clip.ts
 */
import { loadConfig, generateProfile, webClipSites } from "../../shared/scripts/config.js";
import { resolveChildConfig, listChildSubdomains } from "../../shared/scripts/resolve.js";

const config = loadConfig();
let failures = 0;

for (const sub of listChildSubdomains(config)) {
  const resolved = resolveChildConfig(
    config,
    sub,
    new Date().toISOString(),
    config.restrictions ?? []
  );

  // 1. Brush Time must be in the resolved websites (bookmark allowlist).
  const brush = resolved.websites.find((w) =>
    w.url.startsWith("https://brush.")
  );
  if (!brush) {
    console.error(`✗ ${sub}: Brush Time missing from resolved websites`);
    failures++;
    continue;
  }

  // 2. Brush Time must NOT appear on the child's site (hidden).
  const visibleOnSite = resolved.items.some(
    (item) => item.kind === "website" && item.url.startsWith("https://brush.")
  );
  if (visibleOnSite) {
    console.error(`✗ ${sub}: Brush Time is visible on the child site (should be hidden)`);
    failures++;
  }

  // 3. Brush Time must be in webClipSites() → gets a web clip payload.
  const clips = webClipSites(resolved);
  const brushClip = clips.find((c) => c.url.startsWith("https://brush."));
  if (!brushClip) {
    console.error(`✗ ${sub}: Brush Time missing from webClipSites()`);
    failures++;
    continue;
  }

  // 4. The generated profile XML must contain the web clip payload.
  const profile = generateProfile(resolved, resolved.restrictions);
  const payloadOk =
    profile.includes("com.apple.webClip.managed") &&
    profile.includes("https://brush.wainwright.fun");
  if (!payloadOk) {
    console.error(`✗ ${sub}: profile XML missing Brush Time web clip payload`);
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
    `✓ ${sub}: hidden from site, ${clips.length} web clips incl. Brush Time, payload OK`
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll children have the Brush Time web clip.");
