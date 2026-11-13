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

  createAdmin(username, password, { role = 'owner', createdBy = '' } = {}) {
    const name = String(username || '').trim();
    if (!/^[a-zA-Z0-9_.@-]{3,32}$/.test(name)) {
      throw new HttpError(400, '用户名需为 3–32 位字母、数字或 _ . @ -', 'username_invalid');
    }
    const pwd = String(password || '');
    if (pwd.length < 8) throw new HttpError(400, '密码至少 8 位', 'password_weak');
    if (this.store.sql.getAdmin.get(name)) throw new HttpError(409, '用户名已存在', 'username_taken');
    const normalized = normalizeRole(role);
    this.store.sql.insertAdmin.run(name, scrypt(pwd), Date.now(), normalized, String(createdBy || ''));
    return { username: name, role: normalized };
  }

  /** 账号列表：管理员管理页用 */
  listAdmins() {
    return this.store.sql.listAdmins.all().map((row) => ({
      id: row.id,
      username: row.username,
      role: row.role || 'owner',
      created_at: row.created_at,
      created_by: row.created_by || '',
      last_login_at: row.last_login_at,
      disabled: Boolean(row.disabled_at),
    }));
  }

  setRole(id, role, actor = '') {
    const admin = this.getEnabled(Number(id));
    const next = normalizeRole(role);
    // 最后一个能用的 owner 不能被降级：全部降成 viewer 之后，
    // 账号管理、备份恢复、系统设置就再也没人进得去了，只能去改数据库
    if (admin.role === 'owner' && next !== 'owner') this.assertNotLastOwner(admin, '降级');
    this.store.sql.setAdminRole.run(next, admin.id);
    this.store.sql.insertAudit.run(Date.now(), actor || 'system', 'admin.role', `${admin.username}:${admin.role}->${next}`);
    return { username: admin.username, role: next };
  }

  setDisabled(id, disabled, actor = '') {
    const admin = this.store.sql.getAdminById.get(Number(id));
    if (!admin || admin.disabled_at === undefined) throw new HttpError(404, '账号不存在', 'admin_not_found');
    if (disabled && (admin.role || 'owner') === 'owner' && !admin.disabled_at) {
      this.assertNotLastOwner({ ...admin, role: admin.role || 'owner' }, '停用');
    }
    this.store.sql.setAdminDisabled.run(disabled ? Date.now() : null, admin.id);
    // 停用不是删除：账号留着，谁什么时候关的、可以再打开。审计里记一笔
    this.store.sql.insertAudit.run(Date.now(), actor || 'system', disabled ? 'admin.disable' : 'admin.enable', admin.username);
    // 会话是无状态签名 Cookie，停用后旧票仍能验签通过。
    // 所以把「账号是否可用」这一步放在 verifySession 里每次查库，而不是信 Cookie 里的内容
    return { username: admin.username, disabled: Boolean(disabled) };
  }

  removeAdmin(id, actor = '') {
    const admin = this.store.sql.getAdminById.get(Number(id));
    if (!admin) throw new HttpError(404, '账号不存在', 'admin_not_found');
    if ((admin.role || 'owner') === 'owner' && !admin.disabled_at) this.assertNotLastOwner({ ...admin }, '删除');
    this.store.sql.deleteAdmin.run(admin.id);
    this.store.sql.insertAudit.run(Date.now(), actor || 'system', 'admin.remove', admin.username);
    return { username: admin.username };
  }

  getEnabled(id) {
    const admin = this.store.sql.getAdminById.get(Number(id));
    if (!admin) throw new HttpError(404, '账号不存在', 'admin_not_found');
    return { ...admin, role: admin.role || 'owner' };
  }

  assertNotLastOwner(admin, action) {
    if (this.store.sql.countOwners.get().n <= 1) {
      throw new HttpError(400, `这是最后一个管理员账号，不能${action}`, 'last_owner');
    }
  }

  login(username, password, { ip = '' } = {}) {
    const admin = this.store.sql.getAdmin.get(String(username || '').trim());
    const ok = admin && scryptVerify(password, admin.password_hash);
    if (!ok) {
      this.store.sql.insertAudit.run(Date.now(), ip || 'unknown', 'auth.login_failed', truncateUser(username));
      throw new HttpError(401, '用户名或密码错误', 'bad_credentials');
    }
    // 已停用的账号不区分提示：告诉对方「你这个号被停用了」等于确认这个用户名存在
    if (admin.disabled_at) {
      this.store.sql.insertAudit.run(Date.now(), ip || 'unknown', 'auth.login_disabled', truncateUser(username));
      throw new HttpError(401, '用户名或密码错误', 'bad_credentials');
    }
    this.store.sql.touchAdminLogin.run(Date.now(), admin.id);
    this.store.sql.insertAudit.run(Date.now(), admin.username, 'auth.login', ip);
    return this.issueSession({ id: admin.id, username: admin.username, role: admin.role || 'owner' });
  }

  /**
   * 改密码。owner 给自己改要验原密码；owner 给别的账号重置时不用
   * （{ reset: true }）——「忘密码了」正是唯一会用到重置的场景，
   * 要求提供原密码等于把这个功能做成摆设。这条豁免只对 owner 开放，
   * 由调用方先做 requireOwner 判定。
   */
  changePassword(id, oldPassword, newPassword, { reset = false, actor = '' } = {}) {
    const admin = this.store.sql.getAdminById.get(Number(id));
    if (!admin) throw new HttpError(404, '账号不存在', 'admin_not_found');
    const full = this.store.sql.getAdmin.get(admin.username);
    if (!reset && !scryptVerify(oldPassword, full.password_hash)) {
      throw new HttpError(401, '原密码不正确', 'bad_credentials');
    }
    if (String(newPassword || '').length < 8) throw new HttpError(400, '新密码至少 8 位', 'password_weak');
    this.store.sql.updateAdminPassword.run(scrypt(newPassword), admin.id);
    this.store.sql.insertAudit.run(
      Date.now(),
      actor || admin.username,
      reset ? 'admin.password_reset' : 'auth.password_change',
      reset ? admin.username : '',
    );
    return true;
  }

  // ---------- 会话（无状态签名 Cookie）----------
  issueSession(admin) {
    const payload = { id: admin.id, u: admin.username, r: admin.role || 'owner', exp: Date.now() + SESSION_TTL };
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
      // 角色与停用状态每次都从库里读，不信 Cookie 里的那份：
      // 刚被降级或停用的人，手里还揣着 7 天有效的旧票。
      // 每请求一次主键查询，是这个取舍的代价，也是它值得的唯一理由
      const admin = this.store.sql.getAdminById.get(payload.id);
      if (!admin) return null;
      if (admin.disabled_at) return null;
      return { id: admin.id, username: admin.username, role: admin.role || 'owner' };
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

/** 只有两档：owner 能写，viewer 只读。不认识的取值一律按 viewer 处理 */
export function normalizeRole(role) {
  return String(role || '').trim().toLowerCase() === 'owner' ? 'owner' : 'viewer';
}

export const canWrite = (admin) => (admin?.role || 'owner') === 'owner';

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
