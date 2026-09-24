import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = join(import.meta.dirname, "..");
export const SYSTEM_ICONS_DIR = join(ROOT, "public", "system-icons");

/** Built-in apps with no iTunes listing — extract their icons from macOS instead. */
const SYSTEM_APP_ICONS = [
  { name: "app-store", appPath: "/System/Applications/App Store.app", icnsPath: "Contents/Resources/AppIcon.icns" },
  { name: "messages", appPath: "/System/Applications/Messages.app", icnsPath: "Contents/Resources/AppIcon.icns" },
];

async function trimOuterPadding(pngFile: string): Promise<void> {
  const trimmed = await sharp(pngFile).trim({ threshold: 15 }).png().toBuffer();
  await sharp(trimmed).png().toFile(pngFile);
}

export async function extractSystemIcons(): Promise<number> {
  if (process.platform !== "darwin") {
    console.log("System icon extraction requires macOS (skipped).");
    return 0;
  }

  mkdirSync(SYSTEM_ICONS_DIR, { recursive: true });

  let count = 0;
  for (const { name, appPath, icnsPath } of SYSTEM_APP_ICONS) {
    const icnsFile = join(appPath, icnsPath);
    const pngFile = join(SYSTEM_ICONS_DIR, `${name}.png`);

    if (!existsSync(icnsFile)) {
      console.warn(`  ! Skipping ${name}: not found at ${icnsFile}`);
      continue;
    }

    execSync(
      `sips -s format png -z 256 256 ${JSON.stringify(icnsFile)} --out ${JSON.stringify(pngFile)}`,
      { stdio: "pipe" }
    );

    await trimOuterPadding(pngFile);
    console.log(`  ✓ ${name}.png`);
    count++;
  }
  return count;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log("Extracting system app icons from macOS...");
  const count = await extractSystemIcons();
  console.log(`Done (${count} ${count === 1 ? "icon" : "icons"}).`);
}
