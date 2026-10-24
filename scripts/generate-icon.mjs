// scripts/generate-icon.mjs
// Generates the ChatCloser application icon.
//
// The icon is drawn here rather than checked in as a binary so that it is
// reproducible and reviewable: a charcoal rounded square with a gold ring
// and a gold dot, matching the product's visual identity.
//
//   node scripts/generate-icon.mjs

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(here, "..", "electron-app", "src", "assets");

const CHARCOAL = [21, 19, 14, 255];
const GOLD = [201, 168, 99, 255];
const IVORY = [250, 247, 240, 255];

function crc32(buffer) {
  let crc = ~0;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/** Encodes raw RGBA pixels as a PNG. */
function encodePng(width, height, pixels) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Signed distance from a point to a rounded rectangle. */
function roundedRectDistance(x, y, halfW, halfH, radius) {
  const dx = Math.abs(x) - (halfW - radius);
  const dy = Math.abs(y) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

function blend(base, overlay, alpha) {
  return [
    Math.round(base[0] * (1 - alpha) + overlay[0] * alpha),
    Math.round(base[1] * (1 - alpha) + overlay[1] * alpha),
    Math.round(base[2] * (1 - alpha) + overlay[2] * alpha),
    Math.round(base[3] * (1 - alpha) + overlay[3] * alpha),
  ];
}

function drawIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const centre = size / 2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5 - centre;
      const py = y + 0.5 - centre;

      // Rounded square background.
      const bgDistance = roundedRectDistance(px, py, size * 0.46, size * 0.46, size * 0.2);
      let colour = [0, 0, 0, 0];
      if (bgDistance < 0) {
        colour = CHARCOAL;
        const edge = Math.min(1, -bgDistance / 2);
        colour = blend(colour, CHARCOAL, edge);
      }

      // Gold ring.
      const ringRadius = size * 0.28;
      const ringWidth = size * 0.055;
      const distance = Math.hypot(px, py);
      const ringAlpha = Math.max(0, Math.min(1, (ringWidth / 2 - Math.abs(distance - ringRadius)) * 1.5));

      if (ringAlpha > 0 && colour[3] > 0) {
        colour = blend(colour, GOLD, ringAlpha);
      }

      // A speech-bubble notch: a small wedge taken out of the lower-left
      // of the ring, which is what turns the ring into a bubble.
      const notchAngle = Math.atan2(py + size * 0.02, px + size * 0.02);
      const inNotch = notchAngle > 1.95 && notchAngle < 2.45 && distance > size * 0.2 && distance < ringRadius + ringWidth;
      if (inNotch && colour[3] > 0) {
        colour = blend(colour, CHARCOAL, 1);
      }

      // Ivory dot in the middle.
      const dotDistance = Math.hypot(px, py + size * 0.02);
      if (dotDistance < size * 0.075) {
        colour = blend(colour, IVORY, 0.96);
      }

      const offset = (y * size + x) * 4;
      pixels[offset] = colour[0];
      pixels[offset + 1] = colour[1];
      pixels[offset + 2] = colour[2];
      pixels[offset + 3] = colour[3];
    }
  }

  return pixels;
}

/** Wraps PNG images in an ICO container. */
function encodeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);

  const entries = [];
  let offset = 6 + pngs.length * 16;

  for (const { size, data } of pngs) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }

  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

fs.mkdirSync(assetsDir, { recursive: true });

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((size) => ({ size, data: encodePng(size, size, drawIcon(size)) }));

const pngPath = path.join(assetsDir, "icon.png");
fs.writeFileSync(pngPath, pngs[pngs.length - 1].data);

const icoPath = path.join(assetsDir, "icon.ico");
fs.writeFileSync(icoPath, encodeIco(pngs));

console.log(`Wrote ${pngPath}`);
console.log(`Wrote ${icoPath}`);
