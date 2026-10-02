/**
 * Generate placeholder PWA icons for the snacks app (192 + 512).
 * Replace apps/snacks/public/snacks-icon-{192,512}.png with real artwork later.
 */
import sharp from "sharp";

const svg = (size: number) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="22" fill="#f59e0b"/>
    <text x="50" y="68" font-size="52" text-anchor="middle">🍪</text>
  </svg>`
);

for (const size of [192, 512]) {
  await sharp(svg(size)).png().toFile(`apps/snacks/public/snacks-icon-${size}.png`);
  console.log(`wrote apps/snacks/public/snacks-icon-${size}.png`);
}
