import zlib from 'node:zlib';

/**
 * 极简 PNG 编码器：只做 8 位灰度。
 * 二维码只有黑白两种像素，用灰度图最省事，也省掉调色板与通道交织的复杂度。
 * 零依赖——zlib 是 Node 内置的。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * @param {{width:number,height:number,gray:Uint8Array}} image 灰度像素，逐行逐列
 * @returns {Buffer} PNG 字节
 */
export function encodeGrayPng({ width, height, gray }) {
  if (gray.length !== width * height) throw new Error('像素数量与宽高不匹配');
  // 每行前置一个 filter 字节，统一用 0（None），二维码是纯色块，压缩率已经够好
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0;
    raw.set(gray.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- 真彩色（RGBA）输出 ---------- */

/** #rgb / #rrggbb / #rrggbbaa → [r,g,b,a] */
export function parseColor(input, fallback = [0, 0, 0, 255]) {
  const s = String(input ?? '').trim();
  const hex = /^#?([0-9a-f]{3,8})$/i.exec(s.replace(/^transparent$/i, '00000000'));
  if (!hex) return fallback.slice();
  let h = hex[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('') + 'ff';
  else if (h.length === 4) h = h.split('').map((c) => c + c).join('');
  else if (h.length === 6) h += 'ff';
  if (h.length !== 8) return fallback.slice();
  const n = Number.parseInt(h, 16);
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/**
 * 32 位 RGBA 画布，只提供二维码需要的那几个像素操作。
 *
 * 为什么不复用灰度那套：二维码一旦上色、加圆点、留透明底，就不再是
 * 「黑或白」的二元图——灰度只能表达「深浅」，透明更是完全表达不了。
 * 直接上 RGBA，代价是每像素 4 字节，一张 1024² 也就 4 MB。
 */
export function createCanvas(width, height, background = [0, 0, 0, 0]) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = background[0];
    pixels[i + 1] = background[1];
    pixels[i + 2] = background[2];
    pixels[i + 3] = background[3];
  }
  return { width, height, pixels };
}

/** 填一个矩形区域（含左不含右，含上不含下），自动裁到画布边界 */
export function fillRect(canvas, x, y, w, h, color) {
  const { width, height, pixels } = canvas;
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(width, Math.round(x + w));
  const y1 = Math.min(height, Math.round(y + h));
  if (x1 <= x0 || y1 <= y0) return;
  const [r, g, b, a] = color;
  if (a === 0) return;
  for (let py = y0; py < y1; py += 1) {
    let idx = (py * width + x0) * 4;
    for (let px = x0; px < x1; px += 1) {
      pixels[idx] = r;
      pixels[idx + 1] = g;
      pixels[idx + 2] = b;
      pixels[idx + 3] = a;
      idx += 4;
    }
  }
}

/**
 * 画一个圆。抗锯齿用「按覆盖率混合」的暴力办法：每个像素在 2×2 子采样上
 * 判断是否落在圆内，得到 0/0.25/0.5/0.75/1 五档覆盖率。
 *
 * 不用距离场公式是因为这里只在二维码圆点模式下用，数量有限；
 * 2×2 子采样已经足够让 8 倍放大的圆点边缘不出锯齿，也不必引入数学依赖。
 */
export function fillCircle(canvas, cx, cy, radius, color) {
  if (radius <= 0) return;
  const { width, height, pixels } = canvas;
  const [r, g, b, a] = color;
  const x0 = Math.max(0, Math.floor(cx - radius - 1));
  const y0 = Math.max(0, Math.floor(cy - radius - 1));
  const x1 = Math.min(width, Math.ceil(cx + radius + 1));
  const y1 = Math.min(height, Math.ceil(cy + radius + 1));
  const r2 = radius * radius;
  const samples = [
    [-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25],
  ];
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      let inside = 0;
      for (const [dx, dy] of samples) {
        const sx = px + 0.5 + dx - cx;
        const sy = py + 0.5 + dy - cy;
        if (sx * sx + sy * sy <= r2) inside += 1;
      }
      if (!inside) continue;
      const idx = (py * width + px) * 4;
      if (inside === 4) {
        pixels[idx] = r;
        pixels[idx + 1] = g;
        pixels[idx + 2] = b;
        pixels[idx + 3] = a;
        continue;
      }
      // 部分覆盖：按覆盖率把新色混到已有像素上
      const t = (inside / 4) * (a / 255);
      pixels[idx] = r * t + pixels[idx] * (1 - t);
      pixels[idx + 1] = g * t + pixels[idx + 1] * (1 - t);
      pixels[idx + 2] = b * t + pixels[idx + 2] * (1 - t);
      pixels[idx + 3] = Math.max(pixels[idx + 3], Math.round(255 * t + pixels[idx + 3] * (1 - t)));
    }
  }
}

/** 32 位 RGBA 画布 → PNG 字节 */
export function encodeRgbaPng(canvas) {
  const { width, height, pixels } = canvas;
  if (pixels.length !== width * height * 4) throw new Error('像素数量与宽高不匹配');
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter: None
    raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), rowStart + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolour with alpha
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
