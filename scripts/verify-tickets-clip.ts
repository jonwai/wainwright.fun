/**
 * One-off verification: the Tickets PWA must appear as a Home Screen Web Clip
 * in every child's generated profile (hidden from the site, pinned to Home
 * Screen). Run: AWS_PROFILE=email npx tsx scripts/verify-tickets-clip.ts
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

  // 1. Tickets must be in the resolved websites (bookmark allowlist).
  const tickets = resolved.websites.find((w) =>
    w.url.startsWith("https://tickets.")
  );
  if (!tickets) {
    console.error(`✗ ${sub}: Tickets missing from resolved websites`);
    failures++;
    continue;
  }

  // 2. Tickets must NOT appear on the child's site (hidden).
  const visibleOnSite = resolved.items.some(
    (item) => item.kind === "website" && item.url.startsWith("https://tickets.")
  );
  if (visibleOnSite) {
    console.error(`✗ ${sub}: Tickets is visible on the child site (should be hidden)`);
    failures++;
  }

  // 3. Tickets must be in webClipSites() → gets a web clip payload.
  const clips = webClipSites(resolved);
  const ticketsClip = clips.find((c) => c.url.startsWith("https://tickets."));
  if (!ticketsClip) {
    console.error(`✗ ${sub}: Tickets missing from webClipSites()`);
    failures++;
    continue;
  }

  // 4. The generated profile XML must contain the web clip payload.
  const profile = generateProfile(resolved, resolved.restrictions);
  const payloadOk =
    profile.includes("com.apple.webClip.managed") &&
    profile.includes("https://tickets.wainwright.fun");
  if (!payloadOk) {
    console.error(`✗ ${sub}: profile XML missing Tickets web clip payload`);
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
    `✓ ${sub}: hidden from site, ${clips.length} web clips incl. Tickets, payload OK`
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll children have the Tickets web clip.");
