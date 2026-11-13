import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');

export const now = () => Date.now();

export function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** 生成短码：默认去掉易混淆字符的能力可选，默认保留完整 base62 */
const ALPHABET = '23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ'; // 经典友好字符集
const FULL = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function randomCode(length = 6, alphabet = ALPHABET) {
  const chars = [...alphabet];
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += chars[crypto.randomInt(chars.length)];
  }
  return out;
}

export const BASE62 = FULL;

export function scrypt(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function scryptVerify(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const candidate = crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function hmac(secret, text) {
  return crypto.createHmac('sha256', secret).update(text).digest('base64url');
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function daysAgoKey(days) {
  const d = new Date(Date.now() - days * 86400000);
  return dateKey(d);
}

export function dateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function todayKey() {
  return dateKey(new Date());
}

/** 从 User-Agent 粗分平台，够用且零依赖 */
export function platformOf(ua = '') {
  const s = ua.toLowerCase();
  if (!s) return 'unknown';
  if (/iphone|ipad|ipod/.test(s)) return 'ios';
  if (/android/.test(s)) return 'android';
  if (/windows/.test(s)) return 'windows';
  if (/macintosh|mac os x/.test(s)) return 'mac';
  if (/linux/.test(s)) return 'linux';
  if (/bot|spider|crawl|slurp|curl|wget|python|java|go-http/.test(s)) return 'bot';
  return 'other';
}

export function isBotUA(ua = '') {
  return /bot|spider|crawl|slurp|preview|curl\/|wget|python-|go-http-client|okhttp|headless/i.test(ua);
}

export function hostOf(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function truncate(str, len = 120) {
  const s = String(str ?? '');
  return s.length > len ? `${s.slice(0, len)}…` : s;
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    // 头是客户端发的，任何一个 %zz 都能让 decodeURIComponent 抛出来。
    // 这里抛的后果不是「这个 Cookie 无效」，而是整个请求 500 —— 随便一个
    // 手改过 Cookie 的浏览器、一个调试插件，都会得到一屏 500 而不是登录页
    out[key] = safeDecode(String(part.slice(idx + 1)).trim());
  }
  return out;
}

/** 解不开就原样返回：坏编码应当让这一项失效，而不是让整个请求失败 */
export function safeDecode(text) {
  try {
    return decodeURIComponent(String(text));
  } catch {
    return String(text);
  }
}

export function clientIp(req, trustProxy = false) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length) {
      const first = xff.split(',')[0].trim();
      if (first) return normalizeIp(first);
    }
    const real = req.headers['x-real-ip'];
    if (typeof real === 'string' && real.trim()) return normalizeIp(real.trim());
  }
  const raw = req.socket?.remoteAddress || '';
  return normalizeIp(raw);
}

export function normalizeIp(ip) {
  return String(ip).replace(/^::ffff:/, '');
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = Number(bytes) || 0;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}
