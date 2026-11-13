import fs from 'node:fs';
import path from 'node:path';
import { statSync } from 'node:fs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

export class HttpError extends Error {
  constructor(status, message, code = 'error', extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
};

export function sendJson(res, status, data, headers = {}) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sendText(res, status, text, headers = {}) {
  const body = Buffer.from(String(text));
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    ...headers,
  });
  res.end(body);
}

export function sendHtml(res, status, html, headers = {}) {
  const body = Buffer.from(String(html));
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    ...headers,
  });
  res.end(body);
}

export function sendEmpty(res, status, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end();
}

export function redirect(res, location, status = 302, headers = {}) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    Location: location,
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    ...headers,
  });
  res.end();
}

export async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new HttpError(413, '请求体过大', 'payload_too_large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function parseJsonBody(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw.length) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') {
      throw new HttpError(400, '请求体必须是 JSON 对象', 'bad_json');
    }
    return parsed;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'JSON 解析失败', 'bad_json');
  }
}

export async function parseFormBody(req, limit) {
  const raw = await readBody(req, limit);
  const params = new URLSearchParams(raw.toString('utf8'));
  const out = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

/** 静态文件服务：内存缓存，按 mtime 失效 */
export class StaticServer {
  constructor(rootDir, { maxAge = 300 } = {}) {
    this.root = path.resolve(rootDir);
    this.cache = new Map();
    this.maxAge = maxAge;
  }

  resolve(urlPath) {
    // 非法的百分号编码（/static/%zz）会让 decodeURIComponent 直接抛，
    // 冒到顶层就是个白送的 500。解不开就当原始路径处理，最终按 404 返回。
    let decoded;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      decoded = urlPath;
    }
    const target = path.resolve(this.root, `.${path.posix.normalize(decoded)}`);
    if (!target.startsWith(this.root)) return null;
    return target;
  }

  load(file) {
    const hit = this.cache.get(file);
    try {
      const st = statSync(file);
      if (!st.isFile()) return null;
      if (hit && hit.mtime === st.mtimeMs) return hit;
      const entry = {
        mtime: st.mtimeMs,
        data: fs.readFileSync(file),
        type: MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        etag: `W/"${Math.round(st.mtimeMs).toString(36)}-${st.size.toString(36)}"`,
      };
      this.cache.set(file, entry);
      return entry;
    } catch {
      this.cache.delete(file);
      return null;
    }
  }

  /** @returns {boolean} 是否已处理 */
  serve(req, res, urlPath, { immutable = false } = {}) {
    const file = this.resolve(urlPath);
    if (!file) return false;
    const entry = this.load(file);
    if (!entry) return false;
    const headers = {
      ...SECURITY_HEADERS,
      'Content-Type': entry.type,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : `public, max-age=${this.maxAge}`,
      ETag: entry.etag,
    };
    if (req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, { ...headers, 'Content-Length': entry.data.length });
      res.end();
      return true;
    }
    res.writeHead(200, { ...headers, 'Content-Length': entry.data.length });
    res.end(entry.data);
    return true;
  }
}
