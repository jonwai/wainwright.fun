import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

const secrets = new SecretsManagerClient({});

let cachedDir: string | null | undefined;

export async function getSigningDir(): Promise<string | null> {
  if (cachedDir !== undefined) return cachedDir;

  const certId = process.env.SIGNING_CERT_SECRET;
  const keyId = process.env.SIGNING_KEY_SECRET;
  if (!certId || !keyId) {
    cachedDir = null;
    return null;
  }

  try {
    const [certResp, keyResp] = await Promise.all([
      secrets.send(new GetSecretValueCommand({ SecretId: certId })),
      secrets.send(new GetSecretValueCommand({ SecretId: keyId })),
    ]);
    const cert = certResp.SecretString;
    const key = keyResp.SecretString;
    if (!cert || !key || cert === "REPLACE_ME" || key === "REPLACE_ME") {
      cachedDir = null;
      return null;
    }
    const dir = mkdtempSync(join(tmpdir(), "signing-"));
    writeFileSync(join(dir, "cert.pem"), cert);
    writeFileSync(join(dir, "key.pem"), key);
    cachedDir = dir;
    return dir;
  } catch {
    cachedDir = null;
    return null;
  }
}

export function signProfile(unsignedProfile: string, certDir: string): Buffer {
  const result = spawnSync(
    "openssl",
    [
      "smime", "-sign",
      "-signer", join(certDir, "cert.pem"),
      "-inkey", join(certDir, "key.pem"),
      "-outform", "DER",
      "-nodetach",
    ],
    {
      input: unsignedProfile,
      encoding: null,
      timeout: 10_000,
      // Profiles embed web-clip icons and exceed spawnSync's 1MB default,
      // which kills openssl with ENOBUFS/SIGTERM (looks like an empty error).
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, LD_LIBRARY_PATH: "" },
    },
  );

  if (result.status !== 0) {
    console.warn(
      "Profile signing failed, serving unsigned:",
      result.error?.message ?? `signal: ${result.signal ?? "unknown"}`,
      result.stderr?.toString("utf8").trim(),
    );
    return Buffer.from(unsignedProfile, "utf8");
  }

  return result.stdout;
}
