/**
 * PayloadUUIDs in a generated configuration profile must be deterministic
 * for a profile identity. A fresh UUID on each download makes iOS recreate
 * managed Web Clips and wipe their localStorage.
 *
 * Run: npx tsx tools/test-profile-uuids.ts
 */

import { createHash } from "node:crypto";
import { generateProfile, type WebsiteEntry } from "../packages/shared/scripts/config.js";
import type { ResolvedChildConfig } from "../packages/shared/scripts/resolve.js";

/** Must match stableUuid() in packages/shared/scripts/config.ts. */
function expectedStableUuid(seed: string): string {
  const hex = createHash("sha1").update(seed).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-").toUpperCase();
}

const SNACKS = "https://snacks.wainwright.fun";
const HOUSEHOLD = "https://household.wainwright.fun";

function site(name: string, url: string): WebsiteEntry {
  return { name, url };
}

function fixture(identifier: string, websites: WebsiteEntry[], extraApp = false): ResolvedChildConfig {
  const subdomain = identifier.split(".").pop() ?? "child";
  return {
    child: {
      name: subdomain,
      subdomain,
      date_of_birth: "2016-01-01",
      color: "blue",
    },
    domain: "wainwright.fun",
    siteUrl: "https://wainwright.fun",
    websites,
    apps: [
      {
        name: "Notes",
        bundle_id: "com.apple.mobilenotes",
        app_store_url: "https://example.com/notes",
        min_age: 0,
      },
      ...(extraApp
        ? [{
            name: "Calculator",
            bundle_id: "com.apple.calculator",
            app_store_url: "https://example.com/calc",
            min_age: 0,
          }]
        : []),
    ],
    system_apps: [{ bundle_id: "com.apple.mobilesafari", name: "Safari", min_age: 0 }],
    blocked_apps: [],
    restrictions: [{ key: "allowAppInstallation", value: false, type: "boolean" }],
    profile: {
      display_name: `${subdomain} — Allowed Apps`,
      identifier,
      organization: "Wainwright",
      removal_disallowed: true,
    },
  } as unknown as ResolvedChildConfig;
}

function uuidsByIdentifier(xml: string): Map<string, string> {
  const found = new Map<string, string>();
  const re =
    /<key>PayloadIdentifier<\/key>\s*<string>([^<]+)<\/string>[\s\S]*?<key>PayloadUUID<\/key>\s*<string>([^<]+)<\/string>/g;
  for (const match of xml.matchAll(re)) {
    found.set(match[1], match[2]);
  }
  return found;
}

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(
    `${ok ? "✓" : "✗"} ${label}: got ${JSON.stringify(actual)}${ok ? "" : `, expected ${JSON.stringify(expected)}`}`,
  );
}

const lydiaId = "fun.wainwright.kids.lydia";
const ethanId = "fun.wainwright.kids.ethan";
const websites = [site("Snacks", SNACKS), site("Household", HOUSEHOLD)];

const first = generateProfile(fixture(lydiaId, websites));
const second = generateProfile(fixture(lydiaId, websites));
check("two builds for the same child are identical", first === second, true);

const lydia = uuidsByIdentifier(first);
const lydiaAgain = uuidsByIdentifier(second);

function expectPayload(id: string, identifier: string, seed: string) {
  const uuid = lydia.get(identifier);
  check(`${id} PayloadIdentifier is present`, lydia.has(identifier), true);
  check(`${id} PayloadUUID matches stable seed`, uuid, expectedStableUuid(seed));
  check(`${id} PayloadUUID is stable across builds`, uuid, lydiaAgain.get(identifier));
}

expectPayload("root", lydiaId, `${lydiaId}|root`);
expectPayload("restrictions", `${lydiaId}.restrictions`, `${lydiaId}|restrictions`);
expectPayload("webfilter", `${lydiaId}.webfilter`, `${lydiaId}|webfilter`);

const snacksUuid = expectedStableUuid(`${lydiaId}|webclip|${SNACKS}`);
const householdUuid = expectedStableUuid(`${lydiaId}|webclip|${HOUSEHOLD}`);
expectPayload("snacks web clip", `${lydiaId}.webclip.${snacksUuid.toLowerCase()}`, `${lydiaId}|webclip|${SNACKS}`);
expectPayload(
  "household web clip",
  `${lydiaId}.webclip.${householdUuid.toLowerCase()}`,
  `${lydiaId}|webclip|${HOUSEHOLD}`,
);

const withExtraApp = uuidsByIdentifier(generateProfile(fixture(lydiaId, websites, true)));
check("adding an app keeps the root UUID", withExtraApp.get(lydiaId), lydia.get(lydiaId));
check(
  "adding an app keeps the snacks Web Clip UUID",
  withExtraApp.get(`${lydiaId}.webclip.${snacksUuid.toLowerCase()}`),
  snacksUuid,
);

const ethan = uuidsByIdentifier(generateProfile(fixture(ethanId, websites)));
check("different children get different root UUIDs", ethan.get(ethanId) !== lydia.get(lydiaId), true);
check(
  "different children get different restrictions UUIDs",
  ethan.get(`${ethanId}.restrictions`) !== lydia.get(`${lydiaId}.restrictions`),
  true,
);
check(
  "different children get different webfilter UUIDs",
  ethan.get(`${ethanId}.webfilter`) !== lydia.get(`${lydiaId}.webfilter`),
  true,
);
const ethanSnacks = expectedStableUuid(`${ethanId}|webclip|${SNACKS}`);
check(
  "different children get different Web Clip UUIDs for the same URL",
  ethan.get(`${ethanId}.webclip.${ethanSnacks.toLowerCase()}`) !== snacksUuid,
  true,
);
check(
  "ethan snacks Web Clip still uses the stable URL seed",
  ethan.get(`${ethanId}.webclip.${ethanSnacks.toLowerCase()}`),
  ethanSnacks,
);

const noSites = uuidsByIdentifier(generateProfile(fixture(lydiaId, [])));
check("profile with no websites still has a stable root UUID", noSites.get(lydiaId), lydia.get(lydiaId));
check("profile with no websites omits the webfilter payload", noSites.has(`${lydiaId}.webfilter`), false);

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll profile UUID checks passed.");
