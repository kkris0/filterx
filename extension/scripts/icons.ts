/** Renders the toolbar icons (a narrowing "filter" mark) to static/icon{16,48,128}.png. */
import { deflateSync } from "node:zlib";

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// Signed-distance helpers in unit space [0,1].
const roundRect = (x: number, y: number, cx: number, cy: number, hw: number, hh: number, r: number) => {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const BARS = [
  { y: 0.33, w: 0.54 },
  { y: 0.5, w: 0.36 },
  { y: 0.67, w: 0.14 },
];

function render(size: number) {
  const ss = 4;
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          if (roundRect(x, y, 0.5, 0.5, 0.5, 0.5, 0.22) <= 0) {
            bg++;
            if (BARS.some((b) => roundRect(x, y, 0.5, b.y, b.w / 2, 0.05, 0.05) <= 0)) fg++;
          }
        }
      const n = ss * ss;
      const a = bg / n;
      const t = bg ? fg / bg : 0;
      const v = Math.round(15 + (240 - 15) * t);
      const o = py * (size * 4 + 1) + 1 + px * 4;
      raw.set([v, v, v + (t ? 0 : 5), Math.round(a * 255)], o);
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size);
  dv.setUint32(4, size);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]);
}

for (const s of [16, 48, 128]) await Bun.write(`static/icon${s}.png`, render(s));
console.log("wrote static/icon{16,48,128}.png");
