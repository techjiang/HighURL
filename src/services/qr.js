import qrcode from '../vendor/qrcode-gen.mjs';
import { encodeGrayPng, createCanvas, fillRect, fillCircle, encodeRgbaPng, parseColor } from '../lib/png.js';

/**
 * 二维码矩阵。txt 太长时从高纠错等级往下降级，最后退到更小的版本号。
 *
 * 纠错等级是个真实取舍：等级越高，同样的内容需要越多的模块，
 * 印得小的时候反而更难扫。默认 M 是常规物料的平衡点，
 * 允许调用方指定 H（贴在容易磨损的位置）或 L（链接很长又不想让码变大）。
 */
export function qrMatrix(text, { ecc = 'M' } = {}) {
  const payload = String(text || '').slice(0, 1200) || 'https://example.com';
  const levels = [...new Set([String(ecc || 'M').toUpperCase(), 'M', 'L'])]
    .filter((l) => ['L', 'M', 'Q', 'H'].includes(l));
  for (const level of levels) {
    for (let type = 4; type <= 40; type += 1) {
      try {
        const candidate = qrcode(type, level);
        candidate.addData(payload);
        candidate.make();
        return { count: candidate.getModuleCount(), isDark: (row, col) => candidate.isDark(row, col) };
      } catch {
        /* 容量不够，换更大的版本 */
      }
    }
  }
  throw new Error('内容过长，无法生成二维码');
}

/**
 * 把二维码按行合并成横向色块：[{row, start, length}]。
 * SVG 的 path 与 PDF 的矩形都靠它，省掉逐模块绘制。
 */
export function qrRuns(text, opts = {}) {
  const qr = qrMatrix(text, opts);
  const runs = [];
  for (let row = 0; row < qr.count; row += 1) {
    let start = -1;
    for (let col = 0; col <= qr.count; col += 1) {
      const dark = col < qr.count && qr.isDark(row, col);
      if (dark && start < 0) start = col;
      else if (!dark && start >= 0) {
        runs.push({ row, start, length: col - start });
        start = -1;
      }
    }
  }
  return { count: qr.count, runs };
}

/** 圆点样式。默认方块——它才是二维码的规范形态，其余是物料上的观感选择 */
export const DOT_STYLES = ['square', 'rounded', 'dots'];

function normalizeStyle(style) {
  return DOT_STYLES.includes(style) ? style : 'square';
}

/**
 * 生成 SVG 二维码（纯文本矢量，无外部依赖）。
 *
 * 支持：
 * - `dark` 单色，或 `gradient: [from, to]` 双色对角渐变
 * - `light` 背景色，`'transparent'` 表示留空（叠在深色物料上用）
 * - `dotStyle` 方块 / 圆角块 / 圆点
 * - `ecc` 纠错等级
 */
export function qrSvg(text, {
  margin = 2, dark = '#111827', light = 'transparent', size = 0,
  dotStyle = 'square', gradient = null, ecc = 'M',
} = {}) {
  const qr = qrMatrix(text, { ecc });
  const count = qr.count;
  const total = count + margin * 2;
  const style = normalizeStyle(dotStyle);

  let body = '';
  if (style === 'square') {
    const cells = [];
    for (let row = 0; row < count; row += 1) {
      let start = -1;
      for (let col = 0; col <= count; col += 1) {
        const isDark = col < count && qr.isDark(row, col);
        if (isDark && start < 0) start = col;
        else if (!isDark && start >= 0) {
          cells.push(`M${start + margin} ${row + margin}h${col - start}v1h-${col - start}z`);
          start = -1;
        }
      }
    }
    body = `<path fill="${gradient ? 'url(#qr-grad)' : dark}" d="${cells.join('')}"/>`;
  } else {
    // 圆角块与圆点：逐模块画，块数虽然多但都是纯几何，文件依然很小
    const shapes = [];
    const r = style === 'dots' ? 0.5 : 0.32;
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (!qr.isDark(row, col)) continue;
        const cx = col + margin + 0.5;
        const cy = row + margin + 0.5;
        const paint = gradient ? `url(#qr-grad-${row})` : dark;
        if (style === 'dots') shapes.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${paint}"/>`);
        else shapes.push(`<rect x="${col + margin}" y="${row + margin}" width="0.98" height="0.98" rx="${r}" fill="${paint}"/>`);
      }
    }
    body = shapes.join('');
  }

  // 渐变默认 gradientUnits 是 objectBoundingBox，而竖线这类 path 的包围盒宽度为 0，
  // 渐变矩阵会退化成奇异矩阵，整笔不渲染。这里显式用 userSpaceOnUse 并给出坐标范围。
  const [from, to] = Array.isArray(gradient) ? gradient : [];
  let defs = '';
  if (from && to) {
    if (style === 'square') {
      defs = `<defs><linearGradient id="qr-grad" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${total}" y2="${total}">
        <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>`;
    } else {
      // 圆点模式按行渐变：每一行一个 stop 对，模拟对角过渡
      const rows = [];
      for (let row = 0; row < count; row += 1) {
        const t = count > 1 ? row / (count - 1) : 1;
        rows.push(`<linearGradient id="qr-grad-${row}" gradientUnits="userSpaceOnUse" x1="${margin}" y1="${row + margin}" x2="${margin + count}" y2="${row + margin + 1}">
          <stop offset="0" stop-color="${mixHex(from, to, t)}"/><stop offset="1" stop-color="${mixHex(from, to, Math.min(1, t + 0.25))}"/></linearGradient>`);
      }
      defs = `<defs>${rows.join('')}</defs>`;
    }
  }

  const dims = size ? ` width="${size}" height="${size}"` : '';
  const bg = light === 'transparent' ? '' : `<rect width="${total}" height="${total}" fill="${light}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}"${dims} shape-rendering="${style === 'square' ? 'crispEdges' : 'geometricPrecision'}" role="img" aria-label="QR Code">
${defs}${bg}${body}</svg>`;
}

/**
 * 生成位图二维码。
 *
 * scale 是每个模块占几个像素，输出尺寸为（模块数 + 两侧留白）× scale，
 * 保持整数避免边缘发虚。
 *
 * 全黑白的常规情况仍走原来的灰度编码器：文件更小（每像素 1 字节 vs 4 字节），
 * 二维码本来就是二值图，没必要为了彩图把所有人都拖进 RGBA。
 * 只有在带颜色、圆点样式或透明底时才走 RGBA 路径。
 */
export function qrPng(text, {
  margin = 2, scale = 8, dark = '#000000', light = '#ffffff',
  dotStyle = 'square', gradient = null, ecc = 'M',
} = {}) {
  const style = normalizeStyle(dotStyle);
  const plainDark = !gradient && /^#?(0{3}|0{6}|0{8})?$/i.test(String(dark));
  const plainLight = /^#?(f{3}|f{6}|f{8})$/i.test(String(light));

  if (style === 'square' && plainDark && plainLight) {
    const qr = qrMatrix(text, { ecc });
    const total = (qr.count + margin * 2) * scale;
    const gray = new Uint8Array(total * total).fill(255);
    for (let row = 0; row < qr.count; row += 1) {
      for (let col = 0; col < qr.count; col += 1) {
        if (!qr.isDark(row, col)) continue;
        const y0 = (row + margin) * scale;
        const x0 = (col + margin) * scale;
        for (let dy = 0; dy < scale; dy += 1) {
          gray.fill(0, (y0 + dy) * total + x0, (y0 + dy) * total + x0 + scale);
        }
      }
    }
    return { png: encodeGrayPng({ width: total, height: total, gray }), size: total };
  }

  const qr = qrMatrix(text, { ecc });
  const total = (qr.count + margin * 2) * scale;
  const bg = light === 'transparent' ? [0, 0, 0, 0] : parseColor(light, [255, 255, 255, 255]);
  const canvas = createCanvas(total, total, bg);
  const [from, to] = Array.isArray(gradient) ? gradient : [];
  const baseColor = parseColor(dark, [0, 0, 0, 255]);

  for (let row = 0; row < qr.count; row += 1) {
    for (let col = 0; col < qr.count; col += 1) {
      if (!qr.isDark(row, col)) continue;
      const x = (col + margin) * scale;
      const y = (row + margin) * scale;
      const color = from && to
        ? parseColor(mixHex(from, to, qr.count > 1 ? (row + col) / (2 * (qr.count - 1)) : 0), baseColor)
        : baseColor;
      if (style === 'dots') {
        fillCircle(canvas, x + scale / 2, y + scale / 2, scale * 0.5, color);
      } else if (style === 'rounded') {
        roundedRect(canvas, x, y, scale, scale * 0.32, color);
      } else {
        fillRect(canvas, x, y, scale, scale, color);
      }
    }
  }
  return { png: encodeRgbaPng(canvas), size: total };
}

/** 圆角方块：中间正十字 + 四角各补一个 1/4 圆，避免逐像素判断 */
function roundedRect(canvas, x, y, size, radius, color) {
  const r = Math.min(radius, size / 2);
  const inner = size - r * 2;
  fillRect(canvas, x + r, y, inner, size, color);
  fillRect(canvas, x, y + r, r, inner, color);
  fillRect(canvas, x + size - r, y + r, r, inner, color);
  fillCircle(canvas, x + r, y + r, r, color);
  fillCircle(canvas, x + size - r, y + r, r, color);
  fillCircle(canvas, x + r, y + size - r, r, color);
  fillCircle(canvas, x + size - r, y + size - r, r, color);
}

/** 两个十六进制颜色按比例混合，返回 #rrggbb */
export function mixHex(a, b, t) {
  const [r1, g1, b1] = parseColor(a, [0, 0, 0, 255]);
  const [r2, g2, b2] = parseColor(b, [0, 0, 0, 255]);
  const k = Math.max(0, Math.min(1, Number(t) || 0));
  const to2 = (n) => Math.round(n).toString(16).padStart(2, '0');
  return `#${to2(r1 + (r2 - r1) * k)}${to2(g1 + (g2 - g1) * k)}${to2(b1 + (b2 - b1) * k)}`;
}

/** 二维码样式预设：给管理台的下拉框用，也方便 API 调用方少填几个字段 */
export const QR_PRESETS = {
  classic: { label: '经典黑白', dotStyle: 'square', dark: '#111827', light: '#ffffff' },
  brand: { label: '品牌渐变', dotStyle: 'rounded', gradient: ['#8b5cf6', '#22d3ee'], light: '#ffffff' },
  soft: { label: '柔和圆点', dotStyle: 'dots', dark: '#3b2f63', light: '#f8f7ff' },
  light: { label: '深色底反白', dotStyle: 'rounded', dark: '#ffffff', light: '#0f1023' },
  sticker: { label: '透明底贴纸', dotStyle: 'dots', dark: '#111827', light: 'transparent' },
};

/** 把请求里的样式参数解析成 qrSvg / qrPng 都认的选项，非法值一律回落到默认 */
export function resolveStyle({ preset = '', dotStyle = '', dark = '', light = '', gradient = '', ecc = '' } = {}) {
  const base = QR_PRESETS[preset] ? { ...QR_PRESETS[preset] } : {};
  delete base.label;
  const out = { ...base };
  if (DOT_STYLES.includes(dotStyle)) out.dotStyle = dotStyle;
  if (/^#?[0-9a-f]{3,8}$/i.test(String(dark))) out.dark = String(dark).startsWith('#') ? dark : `#${dark}`;
  if (/^transparent$/i.test(String(light))) out.light = 'transparent';
  else if (/^#?[0-9a-f]{3,8}$/i.test(String(light))) out.light = String(light).startsWith('#') ? light : `#${light}`;
  if (gradient) {
    const parts = String(gradient).split(/[,|]/).map((s) => s.trim()).filter(Boolean).slice(0, 2);
    if (parts.length === 2 && parts.every((c) => /^#?[0-9a-f]{3,8}$/i.test(c))) {
      out.gradient = parts.map((c) => (c.startsWith('#') ? c : `#${c}`));
    }
  }
  if (/^[LMQH]$/i.test(String(ecc))) out.ecc = String(ecc).toUpperCase();
  return out;
}
