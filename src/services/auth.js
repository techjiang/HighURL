import { HttpError } from '../lib/http.js';
import { hmac, randomId, safeEqual, scrypt, scryptVerify, sha256 } from '../lib/util.js';

const SESSION_TTL = 7 * 24 * 3600 * 1000;
const COOKIE = 'highurl_session';

export class AuthService {
  constructor({ store, secret, logger = console }) {
    this.store = store;
    this.secret = secret;
    this.logger = logger;
  }

  // ---------- 管理员账号 ----------
  hasAdmin() {
    return this.store.sql.countAdmins.get().n > 0;
  }

  createAdmin(username, password) {
    const name = String(username || '').trim();
    if (!/^[a-zA-Z0-9_.@-]{3,32}$/.test(name)) {
      throw new HttpError(400, '用户名需为 3–32 位字母、数字或 _ . @ -', 'username_invalid');
    }
    const pwd = String(password || '');
    if (pwd.length < 8) throw new HttpError(400, '密码至少 8 位', 'password_weak');
    if (this.store.sql.getAdmin.get(name)) throw new HttpError(409, '用户名已存在', 'username_taken');
    this.store.sql.insertAdmin.run(name, scrypt(pwd), Date.now());
    return { username: name };
  }

  login(username, password, { ip = '' } = {}) {
    const admin = this.store.sql.getAdmin.get(String(username || '').trim());
    const ok = admin && scryptVerify(password, admin.password_hash);
    if (!ok) {
      this.store.sql.insertAudit.run(Date.now(), ip || 'unknown', 'auth.login_failed', truncateUser(username));
      throw new HttpError(401, '用户名或密码错误', 'bad_credentials');
    }
    this.store.sql.touchAdminLogin.run(Date.now(), admin.id);
    this.store.sql.insertAudit.run(Date.now(), admin.username, 'auth.login', ip);
    return this.issueSession({ id: admin.id, username: admin.username });
  }

  changePassword(id, oldPassword, newPassword) {
    const admin = this.store.sql.getAdminById.get(Number(id));
    if (!admin) throw new HttpError(404, '账号不存在', 'admin_not_found');
    const full = this.store.sql.getAdmin.get(admin.username);
    if (!scryptVerify(oldPassword, full.password_hash)) {
      throw new HttpError(401, '原密码不正确', 'bad_credentials');
    }
    if (String(newPassword || '').length < 8) throw new HttpError(400, '新密码至少 8 位', 'password_weak');
    this.store.sql.updateAdminPassword.run(scrypt(newPassword), admin.id);
    this.store.sql.insertAudit.run(Date.now(), admin.username, 'auth.password_change', '');
    return true;
  }

  // ---------- 会话（无状态签名 Cookie）----------
  issueSession(admin) {
    const payload = { id: admin.id, u: admin.username, exp: Date.now() + SESSION_TTL };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = hmac(this.secret, body);
    const token = `${body}.${sig}`;
    return { token, cookie: this.cookie(token, SESSION_TTL) };
  }

  cookie(token, ttl = SESSION_TTL) {
    const parts = [
      `${COOKIE}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(ttl / 1000)}`,
    ];
    return parts.join('; ');
  }

  clearCookie() {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  verifySession(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const idx = token.lastIndexOf('.');
    const body = token.slice(0, idx);
    const sig = token.slice(idx + 1);
    if (!safeEqual(sig, hmac(this.secret, body))) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (!payload?.exp || payload.exp < Date.now()) return null;
      const admin = this.store.sql.getAdminById.get(payload.id);
      if (!admin) return null;
      return { id: admin.id, username: admin.username };
    } catch {
      return null;
    }
  }

  // ---------- API Key ----------
  createKey(name, scope = 'read,write') {
    const label = String(name || '').trim().slice(0, 60) || 'default';
    const raw = `hu_${randomId(24)}`;
    const prefix = raw.slice(0, 11);
    this.store.sql.insertKey.run(label, prefix, sha256(raw), scope, Date.now());
    const row = this.store.db.prepare('SELECT last_insert_rowid() AS id').get();
    return { id: row.id, name: label, key: raw, prefix, scope };
  }

  verifyKey(raw) {
    if (!raw) return null;
    const row = this.store.sql.getKeyByHash.get(sha256(String(raw).trim()));
    if (!row) return null;
    this.store.sql.touchKey.run(Date.now(), row.id);
    return { id: row.id, name: row.name, scope: row.scope };
  }

  extractKey(req) {
    const header = req.headers.authorization;
    if (typeof header === 'string' && /^bearer\s+/i.test(header)) return header.replace(/^bearer\s+/i, '').trim();
    const custom = req.headers['x-api-key'];
    if (typeof custom === 'string' && custom.trim()) return custom.trim();
    return '';
  }
}

function truncateUser(name) {
  return String(name || '').slice(0, 40);
}

/** 令牌桶限流：单进程内存实现，够用且无抖动 */
export class RateLimiter {
  constructor({ windowMs = 60000, max = 600, maxKeys = 50000 } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.maxKeys = maxKeys;
    this.buckets = new Map();
    this.timer = setInterval(() => this.sweep(), windowMs).unref?.();
  }

  configure(max) {
    this.max = Math.max(1, Number(max) || this.max);
  }

  /** @returns {{allowed:boolean, remaining:number, reset:number}} */
  take(key, cost = 1) {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || now - bucket.start >= this.windowMs) {
      bucket = { start: now, count: 0 };
      if (this.buckets.size >= this.maxKeys) this.sweep();
      this.buckets.set(key, bucket);
    }
    bucket.count += cost;
    const allowed = bucket.count <= this.max;
    return {
      allowed,
      remaining: Math.max(0, this.max - bucket.count),
      reset: bucket.start + this.windowMs,
      limit: this.max,
    };
  }

  sweep() {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.start >= this.windowMs) this.buckets.delete(key);
    }
  }

  stop() {
    clearInterval(this.timer);
  }
}

export { COOKIE as SESSION_COOKIE };
