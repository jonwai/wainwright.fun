import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const CERT_DIR = join(ROOT, "certificates");
const CERT_PATH = join(CERT_DIR, "profile-signing.crt");
const KEY_PATH = join(CERT_DIR, "profile-signing.key");

/**
 * Signs a .mobileconfig profile using openssl smime (PKCS#7/CMS).
 * Returns the signed profile as a DER-encoded buffer.
 * If the signing certificate doesn't exist, returns the unsigned profile as-is.
 */
export function signProfile(unsignedProfile: string): Buffer {
  if (!existsSync(CERT_PATH) || !existsSync(KEY_PATH)) {
    return Buffer.from(unsignedProfile, "utf8");
  }

  const result = spawnSync("openssl", [
    "smime", "-sign",
    "-signer", CERT_PATH,
    "-inkey", KEY_PATH,
    "-outform", "DER",
    "-nodetach",
  ], {
    input: unsignedProfile,
    encoding: null,
    timeout: 10_000,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString("utf8") ?? "";
    console.warn("Warning: profile signing failed, serving unsigned profile:", stderr.trim());
    return Buffer.from(unsignedProfile, "utf8");
  }

  return Buffer.from(result.stdout);
}

/** Returns true if a signing certificate is configured. */
export function hasSigningCert(): boolean {
  return existsSync(CERT_PATH) && existsSync(KEY_PATH);
}
