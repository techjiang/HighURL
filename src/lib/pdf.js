import zlib from 'node:zlib';

/**
 * 极简 PDF 写入器：只做「文本 + 图形填充」这两件事。
 *
 * 为什么不用图片塞进去：二维码是纯黑白方格，直接用 `re f` 画矩形，
 * 打成 PDF 是矢量的，印多大都锐利，也不必担心 DPI 与重采样。
 * 字体只用 PDF 内置的 Courier（等宽，字宽固定 = 0.6em），
 * 居中、截断都能靠字符数算出来，不用带字体文件。
 */

export const MM = 2.834645669; // 1mm = 2.834645pt

/**
 * 'g' 是灰度算子，'rg' 是三通道填充色，'RG' 是描边色。
 * 三者不能混用：灰度设过之后颜色会一直是那个灰度，改回彩色必须显式再设一次。
 */
function fillStyle({ gray = 0, color = null } = {}) {
  if (Array.isArray(color) && color.length === 3) {
    return `${color.map((c) => clamp01(c).toFixed(4)).join(' ')} rg`;
  }
  return `${clamp01(gray).toFixed(3)} g`;
}

function strokeStyle({ gray = 0.82, color = null } = {}) {
  if (Array.isArray(color) && color.length === 3) {
    return `${color.map((c) => clamp01(c).toFixed(4)).join(' ')} RG`;
  }
  return `${clamp01(gray).toFixed(3)} G`;
}

function clamp01(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/**
 * 只保留 Courier(WinAnsi) 能画的字符。内置字体没有中文字形，
 * 与其印出一串问号，不如让调用方自己决定退回什么内容。
 */
export function asciiFold(text, replacement = '') {
  return String(text ?? '')
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\x20-\x7e]/g, replacement)
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 纯 ASCII 才算「印出来有意义」，拿它决定要不要退回备用文案 */
export function isPrintableAscii(text) {
  return /^[\x20-\x7e]+$/.test(String(text ?? ''));
}

function escapeText(text) {
  return text.replace(/[\\()]/g, (c) => `\\${c}`);
}

/** 文档属性里的中文不能按 WinAnsi 写出，改用带 BOM 的 UTF-16BE 十六进制串 */
function pdfString(text) {
  const str = String(text ?? '');
  if (!/[^\x00-\x7f]/.test(str)) return `(${escapeText(str)})`;
  const utf16 = Buffer.from(str, 'utf16le').swap16();
  return `<feff${utf16.toString('hex')}>`;
}

/**
 * @param {{width:number,height:number}} size 页面尺寸，单位 pt
 */
export class PdfDocument {
  constructor({ width = 210 * MM, height = 297 * MM, title = '', creator = 'HighURL', subject = '' } = {}) {
    this.width = width;
    this.height = height;
    this.meta = { title, creator, subject };
    this.pages = [];
    this.current = null;
  }

  addPage() {
    this.current = [];
    this.pages.push(this.current);
    return this;
  }

  get pageCount() {
    return this.pages.length;
  }

  #push(op) {
    if (!this.current) this.addPage();
    this.current.push(op);
  }

  /**
   * 填充矩形，坐标以左下角为原点（PDF 原生坐标系）。
   * `color` 传 [r,g,b]（0-1），不传就走灰度 `gray`。
   */
  rect(x, y, w, h, { gray = 0, color = null } = {}) {
    this.#push(`${fillStyle({ gray, color })} ${this.#n(x)} ${this.#n(y)} ${this.#n(w)} ${this.#n(h)} re f 0 g`);
    return this;
  }

  strokeRect(x, y, w, h, { gray = 0.82, color = null, lineWidth = 0.5 } = {}) {
    this.#push(`${strokeStyle({ gray, color })} ${lineWidth} w ${this.#n(x)} ${this.#n(y)} ${this.#n(w)} ${this.#n(h)} re S 0 G`);
    return this;
  }

  /**
   * 圆。PDF 没有圆这个图元，用四段三次贝塞尔逼近——
   * 控制点系数 k = 4/3 * (sqrt(2) - 1) 是把 90° 圆弧压成贝塞尔的经典解，
   * 误差约 0.027%，印刷尺寸下看不出来。
   */
  circle(cx, cy, r, { gray = 0, color = null } = {}) {
    const k = 0.5522847498 * r;
    const n = this.#n.bind(this);
    this.#push(
      `${fillStyle({ gray, color })} ${n(cx + r)} ${n(cy)} m ` +
        `${n(cx + r)} ${n(cy + k)} ${n(cx + k)} ${n(cy + r)} ${n(cx)} ${n(cy + r)} c ` +
        `${n(cx - k)} ${n(cy + r)} ${n(cx - r)} ${n(cy + k)} ${n(cx - r)} ${n(cy)} c ` +
        `${n(cx - r)} ${n(cy - k)} ${n(cx - k)} ${n(cy - r)} ${n(cx)} ${n(cy - r)} c ` +
        `${n(cx + k)} ${n(cy - r)} ${n(cx + r)} ${n(cy - k)} ${n(cx + r)} ${n(cy)} c f 0 g`,
    );
    return this;
  }

  /** 圆角矩形：正中间一个十字矩形，四角各补一个 1/4 圆，省掉逐点算路径 */
  roundedRect(x, y, w, h, radius, opts = {}) {
    const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
    if (r <= 0.01) return this.rect(x, y, w, h, opts);
    this.rect(x + r, y, w - 2 * r, h, opts);
    this.rect(x, y + r, r, h - 2 * r, opts);
    this.rect(x + w - r, y + r, r, h - 2 * r, opts);
    this.circle(x + r, y + r, r, opts);
    this.circle(x + w - r, y + r, r, opts);
    this.circle(x + r, y + h - r, r, opts);
    this.circle(x + w - r, y + h - r, r, opts);
    return this;
  }

  /**
   * 文字。size 是字号（pt），align 支持 left / center / right。
   * Courier 字宽固定 0.6em，所以居中不需要测量字体。
   */
  text(str, x, y, { size = 8, gray = 0, align = 'left', maxChars = 0 } = {}) {
    let out = asciiFold(str);
    if (maxChars > 0 && out.length > maxChars) out = `${out.slice(0, Math.max(0, maxChars - 3))}..`;
    if (!out.trim()) return this;
    const width = out.length * size * 0.6;
    const left = align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;
    this.#push(`BT ${gray.toFixed(3)} g /F1 ${this.#n(size)} Tf 1 0 0 1 ${this.#n(left)} ${this.#n(y)} Tm (${escapeText(out)}) Tj ET 0 g`);
    return this;
  }

  /** 一段文字按 maxChars 折成多行 */
  textWrap(str, x, y, { size = 7, lineHeight = 0, gray = 0, align = 'left', maxChars = 40 } = {}) {
    const words = asciiFold(str).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length > maxChars) {
        if (line) lines.push(line);
        line = word.slice(0, maxChars);
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
    const lh = lineHeight || size * 1.25;
    lines.forEach((text, i) => this.text(text, x, y - i * lh, { size, gray, align, maxChars }));
    return lines.length;
  }

  #n(value) {
    const v = Number(value) || 0;
    return String(Math.round(v * 1000) / 1000);
  }

  /** 输出 PDF 字节 */
  build() {
    if (!this.pages.length) this.addPage();
    const objects = [];
    const add = (body) => {
      objects.push(body);
      return objects.length; // 1-based 对象号
    };
    const pageIds = [];
    const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
    // 先占位目录与页树，编号在最后回填
    const catalogId = add('');
    const pagesId = add('');

    for (const ops of this.pages) {
      const raw = Buffer.from(ops.join('\n'), 'latin1');
      const packed = zlib.deflateSync(raw, { level: 9 });
      const contentId = add({ stream: packed, dict: `/Filter /FlateDecode /Length ${packed.length}` });
      pageIds.push(
        add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${this.#n(this.width)} ${this.#n(this.height)}]
  /Resources << /Font << /F1 ${fontId} 0 R >> >>
  /Contents ${contentId} 0 R >>`),
      );
    }

    objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objects[pagesId - 1] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`;

    const infoId = add(
      `<< /Title ${pdfString(this.meta.title)} /Creator ${pdfString(this.meta.creator)} /Subject ${pdfString(this.meta.subject)} /Producer (HighURL) >>`,
    );

    const chunks = [];
    const offsets = [];
    let offset = 0;
    const put = (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
      chunks.push(buf);
      offset += buf.length;
    };
    put('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
    objects.forEach((body, index) => {
      offsets[index] = offset;
      const id = index + 1;
      if (body && typeof body === 'object' && body.stream) {
        put(`${id} 0 obj\n<< ${body.dict} >>\nstream\n`);
        put(body.stream);
        put('\nendstream\nendobj\n');
      } else {
        put(`${id} 0 obj\n${body}\nendobj\n`);
      }
    });
    const xrefAt = offset;
    const total = objects.length + 1;
    let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
    for (let i = 1; i < total; i += 1) {
      xref += `${String(offsets[i - 1]).padStart(10, '0')} 00000 n \n`;
    }
    put(xref);
    put(`trailer\n<< /Size ${total} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
    return Buffer.concat(chunks);
  }
}
