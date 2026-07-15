// gen-test-assets.mjs — synthesizes a few small sample PNGs for test-assets/
// without any native/image dependencies (hand-rolled PNG encoder using only
// Node's built-in zlib). Run once: `node scripts/gen-test-assets.mjs`.

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'test-assets');
mkdirSync(OUT_DIR, { recursive: true });

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter: none
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idatData = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idatData), chunk('IEND', Buffer.alloc(0))]);
}

function makeBuffer(width, height, painter) {
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = painter(x, y, width, height);
      const i = (y * width + x) * 4;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = a;
    }
  }
  return buf;
}

const SIZE = 256;

// 1. Smooth diagonal gradient — good for adjust/posterize/dither/duotone.
const gradient = makeBuffer(SIZE, SIZE, (x, y, w, h) => [
  Math.round((x / (w - 1)) * 255),
  Math.round((y / (h - 1)) * 255),
  Math.round(((x + y) / (w + h - 2)) * 255),
  255,
]);

// 2. Hard-edged shapes on a flat background — good for pixelate/halftone/chromatic.
const shapes = makeBuffer(SIZE, SIZE, (x, y, w, h) => {
  const bg = [30, 30, 40, 255];
  const cx = w * 0.3, cy = h * 0.35, r = w * 0.18;
  if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) return [255, 90, 60, 255];
  if (x > w * 0.55 && x < w * 0.9 && y > h * 0.15 && y < h * 0.5) return [70, 180, 255, 255];
  if (x > w * 0.15 && x < w * 0.85 && y > h * 0.62 && y < h * 0.9) return [250, 220, 60, 255];
  return bg;
});

// 3. Radial vignette + noise-ish stripes — good for grain/scanlines.
const radial = makeBuffer(SIZE, SIZE, (x, y, w, h) => {
  const dx = x / w - 0.5, dy = y / h - 0.5;
  const d = Math.sqrt(dx * dx + dy * dy);
  const base = Math.max(0, 255 * (1 - d * 1.6));
  const stripe = (Math.floor(y / 6) % 2 === 0) ? 10 : -10;
  const v = Math.min(255, Math.max(0, base + stripe));
  return [v, v * 0.85, v * 0.95, 255];
});

writeFileSync(path.join(OUT_DIR, 'gradient.png'), encodePNG(SIZE, SIZE, gradient));
writeFileSync(path.join(OUT_DIR, 'shapes.png'), encodePNG(SIZE, SIZE, shapes));
writeFileSync(path.join(OUT_DIR, 'radial.png'), encodePNG(SIZE, SIZE, radial));

console.log(`Wrote gradient.png, shapes.png, radial.png (${SIZE}x${SIZE}) to ${OUT_DIR}`);
