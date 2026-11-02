// Generates the peach ring icon with no dependencies: node tools/gen-icon.js <size> <out.png>
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const S = Number(process.argv[2] || 32);
const OUT = process.argv[3] || path.join(__dirname, '..', 'assets', 'icon.png');
const px = Buffer.alloc(S * S * 4, 0);
const cx = S / 2 - 0.5, cy = S / 2 - 0.5, rOut = S * 0.42, rIn = S * 0.27;
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  const d = Math.hypot(x - cx, y - cy);
  // anti-aliased ring coverage
  const cov = Math.max(0, Math.min(1, rOut - d + 0.5)) * Math.max(0, Math.min(1, d - rIn + 0.5));
  const i = (y * S + x) * 4;
  px[i] = 0xF0; px[i + 1] = 0xB5; px[i + 2] = 0x8F; px[i + 3] = Math.round(cov * 255);
}
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }

const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, png);
console.log('wrote', OUT, S + 'x' + S);
