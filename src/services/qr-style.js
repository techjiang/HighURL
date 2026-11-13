import { HttpError } from '../lib/http.js';
import { resolveStyle, DOT_STYLES } from './qr.js';

const HEX = /^#?[0-9a-f]{3,8}$/i;

/**
 * 每条短链记住自己的二维码样式。
 *
 * 样式原本只存在浏览器 localStorage 里，换台机器、换个浏览器就回到默认黑白。
 * 可二维码是印在物料上的东西——同一批海报和下一次导出必须长得一样。
 * 样式本来就属于这条短链，落库才对得上。
 *
 * 只收白名单字段，且逐项校验：这一列会被原样拼进接口返回与导出流程，
 * 存个奇怪的 JSON 进去，坏的是之后每一次生成。
 */
export function normalizeQrStyle(input) {
  if (input === null || input === undefined || input === '') return '';
  let raw = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new HttpError(400, '二维码样式不是合法的 JSON', 'qr_style_invalid');
    }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, '二维码样式必须是对象', 'qr_style_invalid');
  }
  const out = {};
  const { preset = '', dotStyle = '', dark = '', light = '', gradient = '', ecc = '' } = raw;
  if (preset) {
    const resolved = resolveStyle({ preset: String(preset) });
    if (!Object.keys(resolved).length) throw new HttpError(400, '未知的二维码预设', 'qr_style_invalid');
    out.preset = String(preset);
  }
  if (dotStyle) {
    if (!DOT_STYLES.includes(String(dotStyle))) throw new HttpError(400, '未知的码点形状', 'qr_style_invalid');
    out.dotStyle = String(dotStyle);
  }
  for (const key of ['dark', 'light']) {
    const value = String(raw[key] ?? '').trim();
    if (!value) continue;
    if (value === 'transparent' && key === 'light') {
      out.light = 'transparent';
      continue;
    }
    if (!HEX.test(value)) throw new HttpError(400, `${key === 'dark' ? '码点' : '底色'}不是合法颜色`, 'qr_style_invalid');
    out[key] = value.startsWith('#') ? value : `#${value}`;
  }
  if (Array.isArray(gradient) && gradient.length === 2) {
    const pair = gradient.map((c) => String(c).trim());
    if (!pair.every((c) => HEX.test(c))) throw new HttpError(400, '渐变颜色不合法', 'qr_style_invalid');
    out.gradient = pair.map((c) => (c.startsWith('#') ? c : `#${c}`));
  }
  if (ecc) {
    const level = String(ecc).toUpperCase();
    if (!['L', 'M', 'Q', 'H'].includes(level)) throw new HttpError(400, '纠错等级只能是 L/M/Q/H', 'qr_style_invalid');
    out.ecc = level;
  }
  if (!Object.keys(out).length) return '';
  const json = JSON.stringify(out);
  // 一列 TEXT 不该被塞进任意大的东西
  if (json.length > 500) throw new HttpError(400, '二维码样式过于复杂', 'qr_style_invalid');
  return json;
}

export function parseQrStyle(raw) {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** 品牌色：优先取渐变起点，其次取码点色；太浅的颜色（白码）不适合当强调色 */
export function accentOfStyle(raw) {
  const style = parseQrStyle(raw);
  if (Array.isArray(style.gradient) && style.gradient[0]) return style.gradient[0];
  if (style.dark && HEX.test(style.dark) && accentOk(style.dark)) return style.dark;
  return '#8b5cf6';
}

function accentOk(color) {
  const hex = String(color).replace('#', '');
  if (hex.length < 6) return true;
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  // 白 / 极浅的码点色在暗色底上会变成一片惨白，当强调色不好看
  return (r + g + b) / 3 < 220;
}
