import { PdfDocument, MM, isPrintableAscii } from '../lib/pdf.js';
import { qrRuns, qrMatrix, mixHex, resolveStyle } from './qr.js';

/**
 * 二维码 A4 拼版：把一批短链的二维码排成可打印的 PDF。
 *
 * 设计取舍：
 * - 二维码用矢量图形画（re f / 贝塞尔），不是塞位图。缩放、印刷都不会糊。
 * - 每个格子下方给短码和标题，剪下来也能对上号。
 * - 加浅色裁切线，方便按格剪裁；不画外框，省墨。
 * - 样式（颜色 / 渐变 / 码点形状）只在真正用上时才走彩色路径：
 *   纯黑白仍然是一条一条合并的矩形，页面上对象数最少、文件最小。
 */

const PAPERS = {
  a4: { width: 210 * MM, height: 297 * MM, label: 'A4' },
  letter: { width: 215.9 * MM, height: 279.4 * MM, label: 'Letter' },
};

export const PAPER_KEYS = Object.keys(PAPERS);

export function paperSize(name = 'a4') {
  return PAPERS[String(name).toLowerCase()] || PAPERS.a4;
}

/**
 * @param {{code:string, shortUrl:string, title?:string, url?:string}[]} rows
 * @param {{paper?:string, cols?:number, siteName?:string, showTitle?:boolean, showCutLines?:boolean, style?:object}} options
 * @returns {Buffer} PDF 字节
 */
export function buildQrSheetPdf(rows, options = {}) {
  const paper = paperSize(options.paper);
  const items = Array.isArray(rows) ? rows.filter((r) => r && r.code) : [];
  if (!items.length) throw new Error('没有可排版的短链');

  const cols = clampCols(options.cols, items.length);
  const showTitle = options.showTitle !== false;
  const showCutLines = options.showCutLines !== false;
  const siteName = String(options.siteName || 'HighURL');
  // 样式走和单条二维码同一套解析，保证「预览里看到的」和「印出来的」是一套规则
  const style = normalizeSheetStyle(options.style);

  const margin = 12 * MM;
  const headerH = 18 * MM;
  const gap = 5 * MM;
  const usableW = paper.width - margin * 2;
  const usableH = paper.height - margin * 2 - headerH;

  // 行列都定死，格子尺寸才是稳定的；格子太小二维码就印不清，所以按最小边长反推行数
  const cellW = (usableW - gap * (cols - 1)) / cols;
  const minCell = Math.min(58 * MM, cellW + gap);
  const rowsPerPage = Math.max(1, Math.floor((usableH + gap) / (minCell + gap)));
  const cellH = (usableH - gap * (rowsPerPage - 1)) / rowsPerPage;

  const labelLines = showTitle ? 2 : 1;
  const lineH = 9;
  const labelH = labelLines * lineH + 4;
  const side = Math.max(18, Math.min(cellW, cellH - labelH));

  const doc = new PdfDocument({
    width: paper.width,
    height: paper.height,
    title: `HighURL QR sheet (${items.length})`,
    subject: `${paper.label} ${cols}x${rowsPerPage}`,
    creator: 'HighURL',
  });

  const perPage = cols * rowsPerPage;
  const pageCount = Math.ceil(items.length / perPage);

  for (let page = 0; page < pageCount; page += 1) {
    doc.addPage();
    const contentTop = paper.height - margin - headerH;
    doc.text(siteName, margin, paper.height - margin - 10, { size: 11 });
    doc.text(
      `QR sheet  ${page + 1}/${pageCount}   ${items.length} codes   ${paper.label}`,
      margin,
      paper.height - margin - 21,
      { size: 7.5, gray: 0.45 },
    );
    const ruleY = contentTop + 7;
    doc.rect(margin, ruleY, usableW, 0.8, { gray: 0.7 });

    const slice = items.slice(page * perPage, (page + 1) * perPage);
    for (let i = 0; i < slice.length; i += 1) {
      const item = slice[i];
      const x = margin + (i % cols) * (cellW + gap);
      const cellTop = contentTop - Math.floor(i / cols) * (cellH + gap);
      const qrX = x + (cellW - side) / 2;
      const qrY = cellTop - side;

      if (showCutLines) doc.strokeRect(x, cellTop - cellH, cellW, cellH, { gray: 0.88, lineWidth: 0.4 });
      drawQr(doc, item.shortUrl || `/${item.code}`, qrX, qrY, side, style);

      const textX = x + cellW / 2;
      // 短链接去掉协议再印：https:// 占了四分之一格宽，还完全不提供信息
      doc.text(displayUrl(item), textX, qrY - 9, {
        size: 8,
        align: 'center',
        maxChars: Math.max(10, Math.floor(cellW / (8 * 0.6))),
      });
      if (showTitle) {
        doc.text(captionOf(item), textX, qrY - 18, {
          size: 6.5,
          gray: 0.42,
          align: 'center',
          maxChars: Math.max(16, Math.floor(cellW / (6.5 * 0.6))),
        });
      }
    }
  }

  return doc.build();
}

/** 打印用的短链接：去掉协议与结尾斜杠 */
export function displayUrl(item) {
  const raw = String(item.shortUrl || '');
  return (raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '')) || `/${item.code}`;
}

/**
 * 格子下方的副标题。内置字体画不了中文，所以标题不是纯 ASCII 时
 * 退回域名——剪下来也好认，而不是印一排问号。
 */
export function captionOf(item) {
  const title = String(item.title || '');
  if (isPrintableAscii(title)) return title;
  try {
    return new URL(item.url || '').host;
  } catch {
    return '';
  }
}

function clampCols(value, count) {
  const n = Number(value);
  // 0 / 空 / 非法值都表示「自动」：Number(0) 也是有限数，
  // 只判 isFinite 会把「自动」误解成「2 列」
  if (Number.isFinite(n) && n >= 2) return Math.min(6, Math.round(n));
  if (count <= 4) return 2;
  if (count <= 12) return 3;
  if (count <= 24) return 4;
  return 5;
}

/**
 * 拼版用的样式归一。
 *
 * 只保留 PDF 真正能表达的部分：码点形状、纯色、对角渐变、背景色。
 * 背景始终画成实心矩形——透明底在纸上没有意义，那是 SVG / PNG 的事。
 */
function normalizeSheetStyle(input = {}) {
  const resolved = resolveStyle({
    preset: input.preset || '',
    dotStyle: input.dotStyle || input.dot || '',
    dark: input.dark || '',
    light: input.light === 'transparent' ? '#ffffff' : input.light || '',
    gradient: Array.isArray(input.gradient) ? input.gradient.join(',') : input.gradient || '',
    ecc: input.ecc || '',
  });
  return {
    dotStyle: resolved.dotStyle || 'square',
    ecc: resolved.ecc || 'M',
    // 不指定颜色时默认纯黑：这是上一版的行为，也是印在纸上的实际观感
    dark: resolved.dark || '#000000',
    gradient: Array.isArray(resolved.gradient) && resolved.gradient.length === 2 ? resolved.gradient : null,
    light: resolved.light && resolved.light !== 'transparent' ? resolved.light : '#ffffff',
  };
}

/** #rrggbb → PDF 的 [0-1, 0-1, 0-1]；解析不出来当成黑色 */
function rgbOf(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return [0, 0, 0];
  const n = Number.parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * 在 (x, y) 处画边长 side 的二维码，右下角为原点。
 *
 * 两条路径：
 * - 纯黑白方块：按行合并成横向矩形，一条 run 一个 `re f`，对象数最少。
 * - 带颜色 / 渐变 / 圆角 / 圆点：逐模块画，渐变按行插值成实色，
 *   因为 PDF 的 shading 字典要额外写一套 Pattern 资源，收益不值这个复杂度。
 */
function drawQr(doc, text, x, y, side, style = {}) {
  const quiet = 2;
  const dotStyle = style.dotStyle || 'square';
  const gradient = style.gradient;
  const light = rgbOf(style.light || '#ffffff');
  const plain = dotStyle === 'square' && !gradient;
  const dark = rgbOf(style.dark || '#000000');

  // 纯黑白走灰度算子：`0 g` 比 `0 0 0 rg` 短，一条 run 省几个字节，
  // 一份 500 条的拼版就是几万字节的差别，而它跟彩色路径画出来完全一样
  const white = light.every((c) => c === 1);
  const grayPath = plain && white && dark.every((c) => c === 0);

  // 白（或自定义）底：二维码印在有色纸或深色物料上才不糊
  if (grayPath) doc.rect(x, y, side, side, { gray: 1 });
  else doc.rect(x, y, side, side, { color: light });

  if (plain) {
    const { count, runs } = qrRuns(text, { ecc: style.ecc });
    const total = count + quiet * 2;
    const unit = side / total;
    for (const run of runs) {
      doc.rect(
        x + (run.start + quiet) * unit,
        y + (count - run.row - 1 + quiet) * unit,
        run.length * unit,
        unit,
        grayPath ? { gray: 0 } : { color: dark },
      );
    }
    return;
  }

  const qr = qrMatrix(text, { ecc: style.ecc });
  const total = qr.count + quiet * 2;
  const unit = side / total;
  // 圆点半径取 0.44 而不是 0.5：半径等于半格时相邻圆点正好相切，
  // 远看还是一整片黑，圆点就白做了。留一点缝才看得出是点。
  const r = dotStyle === 'dots' ? unit * 0.44 : unit * 0.32;
  for (let row = 0; row < qr.count; row += 1) {
    for (let col = 0; col < qr.count; col += 1) {
      if (!qr.isDark(row, col)) continue;
      const color = gradient
        ? rgbOf(mixHex(gradient[0], gradient[1], qr.count > 1 ? (row + col) / (2 * (qr.count - 1)) : 0))
        : dark;
      const left = x + (col + quiet) * unit;
      // PDF 坐标从下往上，矩阵第 0 行在顶部，所以要翻过来
      const bottom = y + (qr.count - row - 1 + quiet) * unit;
      if (dotStyle === 'dots') {
        doc.circle(left + unit / 2, bottom + unit / 2, r, { color });
      } else if (dotStyle === 'rounded') {
        doc.roundedRect(left, bottom, unit, unit, r, { color });
      } else {
        doc.rect(left, bottom, unit, unit, { color });
      }
    }
  }
}

/**
 * 从查询串里取拼版样式。非法值一律回落默认——
 * 样式参数不该成为 500 的来源。
 */
export function sheetStyleFromQuery(get) {
  return normalizeSheetStyle({
    preset: get('preset') || '',
    dotStyle: get('dot') || '',
    dark: get('dark') || '',
    light: get('light') || '',
    gradient: get('gradient') || '',
    ecc: get('ecc') || '',
  });
}

export { normalizeSheetStyle };
