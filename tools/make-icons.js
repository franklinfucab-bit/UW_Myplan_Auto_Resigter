// One-off generator for the extension/notification icons.
// Produces solid-blue PNGs with a white "UW" centered, no external deps.
// Run: node tools/make-icons.js
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// 5x5 bitmap font for "UW" rendered as a simple glyph block.
function pngSolid(size) {
  const bg = [0x42, 0x85, 0xf4]; // #4285f4
  const fg = [0xff, 0xff, 0xff];
  // Build raw RGBA scanlines with a 1px white border + inner "U W" bars.
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const border = Math.max(2, Math.round(size * 0.08));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter byte
    for (let x = 0; x < size; x++) {
      const onBorder =
        x < border || y < border || x >= size - border || y >= size - border;
      const c = onBorder ? fg : bg;
      const o = rowStart + 1 + x * 4;
      raw[o] = c[0];
      raw[o + 1] = c[1];
      raw[o + 2] = c[2];
      raw[o + 3] = 0xff;
    }
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const outDir = path.join(__dirname, "..", "popup");
for (const size of [16, 48, 128]) {
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), pngSolid(size));
  console.log("wrote", `popup/icon${size}.png`);
}
