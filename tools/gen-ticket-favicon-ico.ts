/**
 * Build apps/tickets/public/favicon.ico as a proper ICO container holding
 * PNG-encoded 48x48 + 32x32 images (same shape as the snacks one).
 */
import sharp from "sharp";
import { writeFile } from "node:fs/promises";

async function pngBytes(size: number): Promise<Buffer> {
  return sharp("apps/tickets/public/favicon-96x96.png").resize(size).png().toBuffer();
}

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

await writeFile("apps/tickets/public/favicon.ico", Buffer.concat([header, ...entries, ...pngs]));
console.log("wrote apps/tickets/public/favicon.ico");
