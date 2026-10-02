/**
 * Build twin/public favicon set from a clean house render captured by
 * home-twin/viewer/shot-icon.mjs (icon-raw.png, 1024x1024, UI chrome hidden).
 * Output mirrors the snacks/tickets sets: favicon-96x96.png, favicon.ico
 * (48+32 PNG entries), apple-touch-icon.png (180), web-app-manifest-{192,512},
 * favicon.svg (embedded PNG, same shape as tickets) and site.webmanifest.
 *
 * The house sits roughly in x 205..717, y 235..860 of the capture; we crop a
 * square around it with padding so the model fills the icon.
 */
import sharp from "sharp";
import { writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";

const SRC = process.env.TWIN_ICON_SRC ?? "tools/twin-icon-raw.png";
const OUT = "apps/twin/public";

// Square crop around the projected house bbox from
// icon-d.bbox.json (shot-icon.mjs candidate d, the default hero
// angle): center ~(530,572), side 790 (bbox 707x758 + margin).
const CROP = { left: 530 - 395, top: 572 - 395, width: 790, height: 790 };

async function pngBytes(size: number): Promise<Buffer> {
  return sharp(SRC).extract(CROP).resize(size, size, { fit: "cover" }).png().toBuffer();
}

async function write(name: string, buf: Buffer): Promise<void> {
  await writeFile(`${OUT}/${name}`, buf);
  console.log(`wrote ${OUT}/${name} (${buf.length} bytes)`);
}

// Raster sizes.
await write("favicon-96x96.png", await pngBytes(96));
await write("apple-touch-icon.png", await pngBytes(180));
await write("web-app-manifest-192x192.png", await pngBytes(192));
await write("web-app-manifest-512x512.png", await pngBytes(512));

// favicon.ico: ICO container with PNG-encoded 48x48 + 32x32 (tickets shape).
function icoEntry(png: Buffer, offset: number): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt8(0, 0); // width 0 = 256
  header.writeUInt8(0, 1); // height 0 = 256
  header.writeUInt8(0, 2); // palette
  header.writeUInt8(0, 3); // reserved
  header.writeUInt16LE(1, 4); // color planes
  header.writeUInt16LE(32, 6); // bits per pixel
  header.writeUInt32LE(png.length, 8); // image size
  header.writeUInt32LE(offset, 12); // image offset
  return header;
}
const sizes = [48, 32];
const pngs: Buffer[] = [];
for (const size of sizes) {
  pngs.push(await pngBytes(size));
}
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(pngs.length, 4); // count
let offset = header.length + pngs.length * 16;
const entries: Buffer[] = [];
for (let i = 0; i < pngs.length; i++) {
  entries.push(icoEntry(pngs[i], offset));
  offset += pngs[i].length;
}
await write("favicon.ico", Buffer.concat([header, ...entries, ...pngs]));

// favicon.svg: SVG wrapper embedding the 512 PNG (same shape as tickets).
const png512 = await readFile(`${OUT}/web-app-manifest-512x512.png`);
const b64 = png512.toString("base64");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" xmlns:xlink="http://www.w3.org/1999/xlink" width="512" height="512" viewBox="0 0 512 512"><image width="512" height="512" xlink:href="data:image/png;base64,${b64}"></image></svg>`;
await write("favicon.svg", Buffer.from(svg));

// site.webmanifest (theme matches the viewer's dark bg).
await write(
  "site.webmanifest",
  Buffer.from(
    JSON.stringify(
      {
        name: "Home Twin",
        short_name: "Twin",
        icons: [
          { src: "/web-app-manifest-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "/web-app-manifest-512x512.png", sizes: "512x512", type: "image/png" },
        ],
        theme_color: "#101418",
        background_color: "#101418",
        display: "standalone",
      },
      null,
      2
    )
  )
);
console.log("done");
