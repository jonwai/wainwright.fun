/**
 * One-off verification: id.sky.com must be allowed (web filter bookmark)
 * for every child, with NO web clip payload and no site visibility.
 * Run: npx tsx scripts/verify-sky-id.ts
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

  // 1. Sky ID must be in the resolved websites (bookmark allowlist).
  const sky = resolved.websites.find((w) => w.url === "https://id.sky.com");
  if (!sky) {
    console.error(`✗ ${sub}: id.sky.com missing from resolved websites`);
    failures++;
    continue;
  }

  // 2. Sky ID must NOT appear on the child's site (hidden).
  if (resolved.items.some((item) => item.url === "https://id.sky.com")) {
    console.error(`✗ ${sub}: id.sky.com is visible on the child site (should be hidden)`);
    failures++;
  }

  // 3. Sky ID must NOT be in webClipSites() → no web clip payload.
  if (webClipSites(resolved).some((c) => c.url === "https://id.sky.com")) {
    console.error(`✗ ${sub}: id.sky.com unexpectedly in webClipSites()`);
    failures++;
  }

  // 4. Profile XML: bookmark entry present, web clip payload absent.
  const profile = generateProfile(resolved, resolved.restrictions);
  if (!profile.includes("https://id.sky.com")) {
    console.error(`✗ ${sub}: profile XML missing id.sky.com bookmark`);
    failures++;
  }
  const clipCount = (profile.match(/com\.apple\.webClip\.managed/g) ?? []).length;
  const skyClipPayload = profile.includes(
    "com.apple.webClip.managed"
  ) && profile.split("com.apple.webClip.managed").some((chunk) =>
    chunk.slice(0, 2000).includes("https://id.sky.com")
  );
  if (skyClipPayload) {
    console.error(`✗ ${sub}: profile XML has a web clip payload for id.sky.com`);
    failures++;
  }

  console.log(
    `✓ ${sub}: allowed (bookmark), hidden from site, no web clip (${clipCount} other web clips intact)`
  );
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll children: id.sky.com allowed with no web clip.");
