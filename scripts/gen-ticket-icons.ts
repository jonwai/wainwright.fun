/**
 * Generate placeholder PWA icons for the tickets app (192 + 512).
 * Replace tickets/public/* with real artwork later.
 */
import sharp from "sharp";

const svg = (size: number) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="22" fill="#8b5cf6"/>
    <text x="50" y="68" font-size="52" text-anchor="middle">🎟️</text>
  </svg>`
);

for (const size of [96, 180, 192, 512]) {
  const name =
    size === 96 ? "favicon-96x96.png"
    : size === 180 ? "apple-touch-icon.png"
    : `tickets-icon-${size}.png`;
  await sharp(svg(size)).png().toFile(`tickets/public/${name}`);
  console.log(`wrote tickets/public/${name}`);
}

for (const size of [192, 512]) {
  await sharp(svg(size)).png().toFile(`tickets/public/web-app-manifest-${size}x${size}.png`);
  console.log(`wrote tickets/public/web-app-manifest-${size}x${size}.png`);
}
