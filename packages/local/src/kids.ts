/**
 * The wainwright.fun launcher and iPad profile on the home network: the hosted kid-routes logic
 * (packages/infra/lambda/kid-routes.ts) with the child taken from the device's IP address instead
 * of a device token. The config and the profile come from the same shared code as hosted
 * (buildRootConfig → resolveChildConfig → generateProfile), so the allowlist, apps, Web Clips and
 * restrictions are exactly what hosted would serve for the same data.
 *
 * Differences from hosted, on purpose:
 *   - Web Clip icons are read from the icons directory (a copy of the hosted site bucket's
 *     website-icons/), not S3.
 *   - The profile is signed with the cert and key files on the Mac. If they are missing or
 *     openssl fails, NO profile is served (hosted fell back to an unsigned one).
 *   - Every profile handed out is recorded in kids.profile_downloads.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ALL_AVATARS } from "../../shared/avatars.js";
import { generateProfile, webClipSites } from "../../shared/scripts/config.js";
import { websiteIconKeys } from "../../shared/scripts/icons.js";
import { resolveChildConfig, type ResolvedChildConfig } from "../../shared/scripts/resolve.js";
import { buildRootConfig, type DbApp, type DbChild, type DbRestriction, type DbTheme, type DbWebsite } from "../../shared/scripts/yaml-generator.js";
import { LOGICAL_TABLES, PgDocumentClient } from "./pg-ddb.js";

type Item = Record<string, unknown>;

async function scan(ddb: PgDocumentClient, table: string): Promise<Item[]> {
  return (await ddb.send({ constructor: { name: "ScanCommand" }, input: { TableName: table } })).Items as Item[];
}

/** Everything the generator reads, in the hosted item shapes. */
export async function loadRows(ddb: PgDocumentClient) {
  const [children, apps, websites, themes, restrictions] = await Promise.all([
    scan(ddb, LOGICAL_TABLES.children),
    scan(ddb, LOGICAL_TABLES.apps),
    scan(ddb, LOGICAL_TABLES.websites),
    scan(ddb, LOGICAL_TABLES.themes),
    scan(ddb, LOGICAL_TABLES.restrictions),
  ]);
  return { children, apps, websites, themes, restrictions };
}

/** hosted loadResolved(): the child's resolved config as of now. */
export async function loadResolved(ddb: PgDocumentClient, childId: string, now = new Date()): Promise<ResolvedChildConfig> {
  const rows = await loadRows(ddb);
  const config = buildRootConfig({
    children: rows.children as unknown as DbChild[],
    apps: rows.apps as unknown as DbApp[],
    websites: rows.websites as unknown as DbWebsite[],
    themes: rows.themes as unknown as DbTheme[],
    restrictions: rows.restrictions as unknown as DbRestriction[],
  });
  return resolveChildConfig(config, childId, now.toISOString(), config.restrictions ?? [], now);
}

/** hosted toKidPayload(): the config without restrictions, date of birth or overrides. */
export function toKidPayload(resolved: ResolvedChildConfig): Record<string, unknown> {
  const { restrictions: _restrictions, ...rest } = resolved;
  const { date_of_birth: _dob, restriction_overrides: _overrides, ...child } = rest.child;
  return { ...rest, child };
}

export function isAvatar(value: unknown): value is string {
  return typeof value === "string" && ALL_AVATARS.includes(value);
}

/** hosted loadWebClipIconsFromS3(), from the icons directory instead of the bucket. */
export async function loadWebClipIcons(iconsDir: string | null | undefined, sites: { url: string; icon?: string }[]): Promise<Map<string, Buffer>> {
  const icons = new Map<string, Buffer>();
  if (!iconsDir) return icons;
  const base = path.resolve(iconsDir);
  await Promise.all(
    sites.map(async (site) => {
      for (const key of websiteIconKeys(site)) {
        const file = path.resolve(base, key);
        if (!file.startsWith(base + path.sep)) continue;
        try {
          const bytes = await readFile(file);
          if (bytes.length > 0) {
            icons.set(site.url, bytes);
            return;
          }
        } catch {
          // Try the next candidate, as hosted does.
        }
      }
    }),
  );
  return icons;
}

export interface Signer {
  certFile: string;
  keyFile: string;
}

export class SigningUnavailable extends Error {}

/** The same openssl call as hosted signProfile(), but it never falls back to unsigned. */
export function signProfile(unsigned: string, signer: Signer | null): Buffer {
  if (!signer || !existsSync(signer.certFile) || !existsSync(signer.keyFile)) {
    throw new SigningUnavailable("Profile signing is not set up on this Mac");
  }
  const result = spawnSync("openssl", ["smime", "-sign", "-signer", signer.certFile, "-inkey", signer.keyFile, "-outform", "DER", "-nodetach"], {
    input: unsigned,
    encoding: null,
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout?.length) {
    // stderr can mention file paths but never key material; keep only the first line.
    const reason = result.error?.message ?? result.stderr?.toString("utf8").split("\n")[0] ?? `signal ${result.signal ?? "unknown"}`;
    throw new SigningUnavailable(`Profile signing failed: ${reason}`);
  }
  return result.stdout;
}

/** The child's profile, unsigned (hosted generateProfile with the Web Clip icons). */
export async function unsignedProfile(resolved: ResolvedChildConfig, iconsDir: string | null | undefined): Promise<string> {
  const webClipIcons = await loadWebClipIcons(iconsDir, webClipSites(resolved));
  return generateProfile(resolved, resolved.restrictions, { webClipIcons });
}

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
