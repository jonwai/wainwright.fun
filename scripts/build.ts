import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");

console.log("Fetching App Store icons...");
execSync("npx tsx scripts/fetch-icons.ts", { stdio: "inherit", cwd: ROOT });

if (existsSync(DIST)) {
  rmSync(DIST, { recursive: true });
}

console.log("Building kids site...");
execSync("vite build", {
  stdio: "inherit",
  env: { ...process.env },
});

console.log("Built kids site to dist/");
