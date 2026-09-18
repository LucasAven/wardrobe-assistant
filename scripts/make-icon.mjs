// Writes client/public/icon-180.png. iOS often ignores a data URI apple-touch-icon and
// falls back to a screenshot of the page, which looks broken on the home screen.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const SIZE = 180;
const BG = [0x14, 0x12, 0x10];
const FG = [0xf2, 0xf0, 0xea];

const inShirt = (x, y) => {
  const neck = (x - 90) ** 2 + (y - 38) ** 2 < 21 ** 2;
  if (neck) return false;
  const sleeves = y >= 44 && y < 80 && x >= 28 && x < 152;
  const body = y >= 80 && y <= 150 && x >= 54 && x <= 126;
  return sleeves || body;
};

const raw = Buffer.alloc(SIZE * (SIZE * 3 + 1));
let o = 0;
for (let y = 0; y < SIZE; y++) {
  raw[o++] = 0;
  for (let x = 0; x < SIZE; x++) {
    const [r, g, b] = inShirt(x, y) ? FG : BG;
    raw[o++] = r; raw[o++] = g; raw[o++] = b;
  }
}

const table = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 2;

writeFileSync('client/public/icon-180.png', Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]));
console.log('client/public/icon-180.png written');
