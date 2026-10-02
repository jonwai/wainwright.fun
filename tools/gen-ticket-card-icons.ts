/**
 * Generate placeholder card icons for the Tickets app — one per reward
 * (and the four seeded tasks), written to apps/kids/public/ticket-icons/.
 * These are the "sensible defaults": bold, high-contrast emoji tiles a
 * pre-reader can identify at a glance. Swap for real photos via the
 * admin portal any time (uploads get fresh filenames, so these files
 * are never overwritten in place).
 *
 * Run:  npx tsx scripts/gen-ticket-card-icons.ts
 * (sharp is a devDependency, used by gen-ticket-icons.ts already)
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { REWARD_EMOJI, TASK_EMOJI } from "../packages/shared/scripts/ticket-emoji";

function tile(emoji: string): Buffer {
  // Violet ticket-app theme (#8b5cf6), white rounded tile, big glyph.
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="22" fill="#f5f3ff"/>
      <rect x="4" y="4" width="92" height="92" rx="18" fill="#8b5cf6" opacity="0.12"/>
      <text x="50" y="66" font-size="52" text-anchor="middle">${emoji}</text>
    </svg>`
  );
}

let count = 0;
const OUT_DIR = join(import.meta.dirname, "../apps/kids/public/ticket-icons");
mkdirSync(OUT_DIR, { recursive: true });
for (const [id, emoji] of Object.entries({ ...REWARD_EMOJI, ...TASK_EMOJI })) {
  await sharp(tile(emoji)).png().toFile(join(OUT_DIR, `${id}.png`));
  count += 1;
}
console.log(`wrote ${count} placeholder icons to apps/kids/public/ticket-icons/`);
