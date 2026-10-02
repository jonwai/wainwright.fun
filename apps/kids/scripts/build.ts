import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

// Repo root (apps/kids/scripts -> ../../..). The icon fetch and its `aws s3
// sync` targets are repo-root-relative, so they must run from there.
const REPO_ROOT = join(import.meta.dirname, "../../..");
const APP_ROOT = join(import.meta.dirname, "..");
const DIST = join(APP_ROOT, "dist");

console.log("Fetching App Store icons...");
execSync("npx tsx packages/infra/scripts/fetch-icons.ts", {
  stdio: "inherit",
  cwd: REPO_ROOT,
});

if (existsSync(DIST)) {
  rmSync(DIST, { recursive: true });
}

console.log("Building kids site...");
execSync("vite build", {
  stdio: "inherit",
  cwd: APP_ROOT,
  env: { ...process.env },
});

console.log("Built kids site to apps/kids/dist/");
