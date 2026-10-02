/** One-off verification: the Twin web clip must appear in every child's
 * generated profile (hidden from the site, pinned to Home Screen).
 * Run: AWS_PROFILE=email npx tsx scripts/verify-twin-clip.ts
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

  const twin = resolved.websites.find((w) =>
    w.url.startsWith("https://twin.")
  );
  if (!twin) {
    console.error(`✗ ${sub}: Twin missing from resolved websites`);
    failures++;
    continue;
  }

  const visibleOnSite = resolved.items.some(
    (item) => item.kind === "website" && item.url.startsWith("https://twin.")
  );
  if (visibleOnSite) {
    console.error(`✗ ${sub}: Twin is visible on the child site (should be hidden)`);
    failures++;
  }

  const clips = webClipSites(resolved);
  const twinClip = clips.find((c) => c.url.startsWith("https://twin."));
  if (!twinClip) {
    console.error(`✗ ${sub}: Twin missing from webClipSites()`);
    failures++;
    continue;
  }

  const profile = generateProfile(resolved, resolved.restrictions);
  const payloadOk =
    profile.includes("com.apple.webClip.managed") &&
    profile.includes("https://twin.wainwright.fun");
  if (!payloadOk) {
    console.error(`✗ ${sub}: profile XML missing Twin web clip payload`);
    failures++;
    continue;
  }

  const webappOk = profile.includes("com.apple.webapp");
  if (!webappOk) {
    console.error(`✗ ${sub}: com.apple.webapp missing from bundle allowlist`);
    failures++;
    continue;
  }

  console.log(
    `✓ ${sub}: hidden from site, ${clips.length} web clips incl. Twin, payload OK`
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll children have the Twin web clip.");
