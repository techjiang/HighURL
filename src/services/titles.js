import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import zlib from 'node:zlib';

const MAX_BYTES = 256 * 1024;
const CACHE_TTL = 10 * 60 * 1000;

/** 判断一个 IP 是否属于内网/保留段，用于阻断 SSRF */
export function isPrivateIp(ip) {
  const addr = String(ip).replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIPv6(addr)) {
    const s = addr.toLowerCase();
    if (s === '::' || s === '::1') return true;
    if (s.startsWith('fc') || s.startsWith('fd')) return true;
    if (s.startsWith('fe80')) return true;
    return false;
  }
  return false;
}

export async function assertPublicHost(hostname) {
  const host = String(hostname).toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error('禁止访问内网地址');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('禁止访问内网地址');
    return;
  }
  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length) throw new Error('域名解析失败');
  for (const record of records) {
    if (isPrivateIp(record.address)) throw new Error('禁止访问内网地址');
  }
}

function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
  return String(text)
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
      if (entity[0] === '#') {
        const code = entity[1] === 'x' || entity[1] === 'X'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
        if (Number.isFinite(code) && code > 0 && code < 0x10ffff) {
          try {
            return String.fromCodePoint(code);
          } catch {
            return match;
          }
        }
        return match;
      }
      return named[entity] ?? match;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从 HTML 中抽标题：优先 og:title / twitter:title，再退回 <title> */
export function extractTitle(html) {
  if (!html) return '';
  const meta = /<meta[^>]+(?:property|name)\s*=\s*["'](?:og:title|twitter:title)["'][^>]*>/i.exec(html);
  if (meta) {
    const content = /content\s*=\s*["']([^"']*)["']/i.exec(meta[0]);
    if (content?.[1]) {
      const title = decodeEntities(content[1]);
      if (title) return clamp(title);
    }
  }
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (match?.[1]) {
    const title = decodeEntities(match[1].replace(/<[^>]*>/g, ''));
    if (title) return clamp(title);
  }
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (h1?.[1]) {
    const title = decodeEntities(h1[1].replace(/<[^>]*>/g, ''));
    if (title) return clamp(title);
  }
  return '';
}

function clamp(title) {
  const t = String(title).trim();
  return t.length > 200 ? `${t.slice(0, 200)}…` : t;
}

function charsetOf(contentType = '', html = '') {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType);
  if (fromHeader) return fromHeader[1].toLowerCase();
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(html.slice(0, 4096));
  return fromMeta ? fromMeta[1].toLowerCase() : 'utf-8';
}

function decodeBuffer(buffer, contentType) {
  const head = buffer.subarray(0, 4096).toString('latin1');
  const charset = charsetOf(contentType, head);
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

function decompress(buffer, encoding = '') {
  try {
    if (/gzip/i.test(encoding)) return zlib.gunzipSync(buffer);
    if (/deflate/i.test(encoding)) return zlib.inflateSync(buffer);
    if (/br/i.test(encoding)) return zlib.brotliDecompressSync(buffer);
  } catch {
    return buffer;
  }
  return buffer;
}

export class TitleFetcher {
  constructor({ settings, logger = console }) {
    this.settings = settings;
    this.logger = logger;
    this.cache = new Map();
    this.inflight = new Map();
  }

  async fetch(url, { timeout } = {}) {
    if (!this.settings.get('titleFetch')) return '';
    const key = String(url);
    const cached = this.cache.get(key);
    if (cached && cached.exp > Date.now()) return cached.title;
    if (this.inflight.has(key)) return this.inflight.get(key);

    const task = this.#fetchOnce(url, timeout ?? this.settings.get('titleTimeout') ?? 5000)
      .catch((err) => {
        this.logger.warn?.(`[title] ${key} 抓取失败: ${err.message}`);
        return '';
      })
      .then((title) => {
        this.cache.set(key, { title, exp: Date.now() + CACHE_TTL });
        this.inflight.delete(key);
        if (this.cache.size > 2000) {
          const firstKey = this.cache.keys().next().value;
          this.cache.delete(firstKey);
        }
        return title;
      });
    this.inflight.set(key, task);
    return task;
  }

  async #fetchOnce(target, timeout) {
    let url = target;
    for (let hop = 0; hop < 4; hop += 1) {
      await assertPublicHost(new URL(url).hostname);
      const { status, headers, body } = await this.#request(url, timeout);
      if (status >= 300 && status < 400 && headers.location) {
        url = new URL(headers.location, url).href;
        continue;
      }
      if (status >= 400) return '';
      const html = decodeBuffer(body, headers['content-type'] || '').slice(0, 200000);
      return extractTitle(html);
    }
    return '';
  }

  #request(url, timeout) {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https:') ? https : http;
      const req = mod.request(
        url,
        {
          method: 'GET',
          timeout,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; HighURL/1.0; +https://github.com/highurl)',
            Accept: 'text/html,application/xhtml+xml',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
          },
        },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BYTES) {
              res.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            const raw = Buffer.concat(chunks);
            resolve({
              status: res.statusCode || 0,
              headers: res.headers,
              body: decompress(raw, res.headers['content-encoding']),
            });
          });
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error('抓取超时')));
      req.on('error', reject);
      req.end();
    });
  }
}
