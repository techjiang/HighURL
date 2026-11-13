import { HttpError } from '../lib/http.js';
import { randomCode, hostOf, truncate, scrypt } from '../lib/util.js';
import { normalizeQrStyle } from './qr-style.js';
import { normalizeTheme } from '../pages/landing-page.js';

const CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_URL = 4096;

export function normalizeUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new HttpError(400, '请填写目标链接', 'url_required');
  if (raw.length > MAX_URL) throw new HttpError(400, '链接过长', 'url_too_long');
  let candidate = raw;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) {
    if (/^\/\//.test(candidate)) candidate = `https:${candidate}`;
    else if (/^[\w.-]+\.[a-z]{2,}(?:[/:?#].*)?$/i.test(candidate)) candidate = `https://${candidate}`;
  }
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new HttpError(400, '链接格式不正确', 'url_invalid');
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new HttpError(400, '只支持 http 和 https 链接', 'url_scheme');
  }
  if (!url.hostname || !url.hostname.includes('.')) {
    throw new HttpError(400, '链接域名不合法', 'url_host');
  }
  return url.href;
}

export function normalizeTags(input) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(/[,，\s]+/);
  const out = [];
  for (const item of list) {
    const tag = String(item).trim().replace(/[,\s]/g, '');
    if (!tag) continue;
    if (tag.length > 24) continue;
    if (!out.includes(tag)) out.push(tag);
    if (out.length >= 10) break;
  }
  return out.join(',');
}

/**
 * 解析有效期。
 *
 * `YYYY-MM-DD` 这种纯日期要按「当天结束」算：管理台的日期选择器只给日期，
 * 用户选今天就是想让链接撑到今天为止。按 Date.parse 的原义会解成当天 00:00，
 * 于是「设了有效期」的短链创建出来就已经过期，访问直接 410。
 */
function parseExpire(input) {
  if (input === undefined || input === null || input === '' || input === 'never') return null;
  // 只有字符串才可能是「纯数字日期」。数字类型直接当时间戳：
  // 毫秒时间戳本身由 13 位数字组成，被当成年份解析会得到 Date.now() + 30 天 → NaN，
  // 续期静默变成一个空操作，而这正是「续了期却发现链接还是过期」的那类问题
  if (typeof input === 'number' || /^\d+$/.test(String(input).trim())) {
    const n = Number(input);
    const ms = n < 1e11 ? n * 1000 : n; // 支持秒或毫秒时间戳
    return Number.isFinite(ms) ? ms : null;
  }
  const text = String(input).trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    const end = new Date(Number(y), Number(m) - 1, Number(d), 23, 59, 59, 999);
    return Number.isNaN(end.getTime()) ? null : end.getTime();
  }
  const t = Date.parse(text);
  return Number.isNaN(t) ? null : t;
}

export class LinkService {
  constructor({ store, settings, titles, groups = null, targets = null, history = null, logger = console }) {
    this.store = store;
    this.settings = settings;
    this.titles = titles;
    this.groups = groups;
    this.targets = targets;
    this.history = history;
    this.logger = logger;
  }

  /**
   * 从 patch 里取分组字段。不能写成 `patch.group ?? patch.groupId`：
   * 显式传 null 表示「移出分组」，用 ?? 会被当成没传而忽略掉。
   */
  pickGroupInput(patch) {
    if (Object.prototype.hasOwnProperty.call(patch, 'group')) return patch.group;
    if (Object.prototype.hasOwnProperty.call(patch, 'groupId')) return patch.groupId;
    return undefined;
  }

  /** 分组入参宽松处理：id、名称、空值都接受 */
  groupIdOf(input) {
    if (input === undefined) return undefined;
    if (input === null || input === '' || input === 'none' || input === 0 || input === '0') return null;
    if (!this.groups) return null;
    const group = this.groups.resolve(input);
    return group ? group.id : null;
  }

  validateCode(code) {
    const text = String(code || '').trim();
    if (!CODE_RE.test(text)) {
      throw new HttpError(400, '短码只能包含字母、数字、- 和 _，长度 1–64', 'code_invalid');
    }
    const lower = text.toLowerCase();
    if (this.settings.reservedSet().has(lower)) {
      throw new HttpError(409, `「${text}」是系统保留路径，请换一个短码`, 'code_reserved');
    }
    return text;
  }

  /** 短码大小写不敏感判重：/Abc 和 /abc 在 URL 里就是同一个入口 */
  codeTaken(code) {
    return Boolean(this.store.sql.getLinkByCodeCI.get(code));
  }

  generateCode() {
    const length = Math.max(3, Number(this.settings.get('codeLength')) || 6);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const size = length + Math.floor(attempt / 4);
      const code = randomCode(size);
      if (!this.codeTaken(code) && !this.settings.reservedSet().has(code.toLowerCase())) return code;
    }
    // 极端情况下退化到更长的随机串，保证不会失败
    for (let i = 0; i < 5; i += 1) {
      const code = randomCode(12);
      if (!this.codeTaken(code)) return code;
    }
    throw new HttpError(500, '短码分配失败，请重试', 'code_alloc_failed');
  }

  /**
   * 创建短链
   * @param {{url:string,code?:string,title?:string,note?:string,tags?:string|string[],expireAt?:any,fetchTitle?:boolean}} input
   */
  async create(input, { actor = 'admin' } = {}) {
    const url = normalizeUrl(input.url);
    const code = input.code ? this.validateCode(input.code) : this.generateCode();
    if (this.codeTaken(code)) throw new HttpError(409, `短码「${code}」已被占用`, 'code_taken');
    if (this.settings.reservedSet().has(code.toLowerCase())) {
      throw new HttpError(409, `短码「${code}」是系统保留路径`, 'code_reserved');
    }
    const tags = normalizeTags(input.tags);
    const note = String(input.note ?? '').slice(0, 500);
    const expireAt = parseExpire(input.expireAt);
    const groupId = this.groupIdOf(input.group ?? input.groupId) ?? null;
    // 建页默认值来自站点设置：新建时就把结论落库，之后改站点默认值
    // 不会反过来改掉已有短链的行为
    const landing = parseLanding(input);
    const useLanding = landing.enabled === undefined
      ? (this.settings.get('interstitialDefault') ? 1 : 0)
      : (landing.enabled ? 1 : 0);
    const qrStyle = normalizeQrStyle(input.qrStyle);

    let title = String(input.title ?? '').trim().slice(0, 300);
    if (!title && this.settings.get('titleFetch') && input.fetchTitle !== false) {
      title = await this.titles.fetch(url);
    }

    const ts = Date.now();
    try {
      this.store.sql.insertLink.run(code, url, title, note, tags, 'active', null, ts, ts, expireAt, groupId);
    } catch (err) {
      if (/UNIQUE/i.test(String(err.message))) {
        throw new HttpError(409, `短码「${code}」已被占用`, 'code_taken');
      }
      throw err;
    }
    // 创建时就能带一组分流目标：API 调用方应该一次把事说完，
    // 而不是「创建完再 PUT 一次」，中间那一步失败了就留下半配置
    const targetInput = Array.isArray(input.targets) ? input.targets : [];
    if (targetInput.length) {
      const created = this.store.findLinkByCode(code);
      if (created) this.targets?.replace(created.id, targetInput);
    }
    const createdRow = this.store.sql.getLinkByCodeAny.get(code);
    // 建页主题不能留空：这一列是 NOT NULL，而 parseLanding 在没有显式主题时
    // 返回的是「没表态」而不是 'auto'——两者含义不同，落库要落确定的那个
    const theme = landing.theme || 'auto';
    if (createdRow) {
      this.store.sql.updateLinkLanding.run(useLanding, theme, landing.note || '', ts, createdRow.id);
      if (qrStyle) this.store.sql.updateLinkQrStyle.run(qrStyle, ts, createdRow.id);
    }
    this.audit(actor, 'link.create', `${code} → ${truncate(url, 80)}`);
    const link = this.store.findLinkByCode(code);
    // 初始版本也记一版，回滚列表里才有「刚建出来时」这个基准点
    if (link) this.history?.record(link.id, { action: 'create', actor });
    // 标题可能是异步补全的
    if (!title && this.settings.get('titleFetch') && input.fetchTitle !== false) {
      this.titles.fetch(url).then((t) => {
        if (t) this.store.sql.updateLink.run(link.url, t, link.note, link.tags, link.status, link.expire_at, Date.now(), link.id);
      }).catch(() => {});
    }
    return link;
  }

  async update(id, patch, { actor = 'admin' } = {}) {
    const link = this.store.sql.getLinkById.get(Number(id));
    if (!link) throw new HttpError(404, '短链不存在', 'link_not_found');
    // 先存一版「改之前的样子」：历史记录的意义在于能退回去，
    // 记成改之后的快照等于没有旧值可退
    this.history?.record(link.id, { action: 'update', actor });
    const url = patch.url !== undefined ? normalizeUrl(patch.url) : link.url;
    let title = patch.title !== undefined ? String(patch.title).trim().slice(0, 300) : link.title;
    const note = patch.note !== undefined ? String(patch.note).slice(0, 500) : link.note;
    const tags = patch.tags !== undefined ? normalizeTags(patch.tags) : link.tags;
    let status = patch.status !== undefined ? String(patch.status) : link.status;
    if (!['active', 'disabled'].includes(status)) status = link.status;
    const expireAt = patch.expireAt !== undefined ? parseExpire(patch.expireAt) : link.expire_at;
    const groupId = this.groupIdOf(this.pickGroupInput(patch));

    if (!title && patch.autoTitle && this.settings.get('titleFetch')) {
      title = await this.titles.fetch(url);
    }
    this.store.sql.updateLink.run(url, title, note, tags, status, expireAt, Date.now(), link.id);
    if (groupId !== undefined) this.store.sql.setLinkGroup.run(groupId, Date.now(), link.id);
    this.applyLanding(link, patch);
    if (Object.prototype.hasOwnProperty.call(patch, 'qrStyle')) this.setQrStyle(link.id, patch.qrStyle);
    this.audit(actor, 'link.update', `${link.code}`);
    return this.store.sql.getLinkById.get(link.id);
  }

  /**
   * 单独设置建页。和 update 分开，是因为「改个开关」不该走一遍
   * 目标地址、标题、标签的全量校验——那些字段这次根本没被碰过。
   */
  setLanding(id, input, { actor = 'admin' } = {}) {
    const link = this.store.sql.getLinkById.get(Number(id));
    if (!link) throw new HttpError(404, '短链不存在', 'link_not_found');
    // 这个接口的请求体本身就是建页配置，不需要再包一层 landing
    const parsed = parseLanding(input);
    if (!Object.keys(parsed).length) throw new HttpError(400, '没有需要修改的建页配置', 'landing_empty');
    this.history?.record(link.id, { action: 'landing', actor });
    this.applyLanding(link, { landing: parsed });
    this.audit(actor, 'link.landing', `${link.code}:${parsed.enabled === false ? 'off' : 'on'}`);
    return this.store.sql.getLinkById.get(link.id);
  }

  /** 只在 patch 里真的带了建页字段时才动这块，避免普通编辑把它顺手重置 */
  applyLanding(link, patch) {
    const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);
    if (!has('landing') && !has('interstitial') && !has('interstitialNote') && !has('landingTheme')) {
      return null;
    }
    const parsed = has('landing') ? parseLanding(patch.landing || {}) : parseLanding(patch);
    const enabled = parsed.enabled === undefined
      ? (link.interstitial ? 1 : 0)
      : (parsed.enabled ? 1 : 0);
    const theme = parsed.theme || link.landing_theme || 'auto';
    const note = parsed.note !== undefined ? parsed.note : (link.interstitial_note || '');
    const finalTheme = normalizeTheme(theme);
    this.store.sql.updateLinkLanding.run(enabled, finalTheme, note, Date.now(), link.id);
    return enabled;
  }

  setQrStyle(id, input, { actor = '' } = {}) {
    const link = this.store.sql.getLinkById.get(Number(id));
    if (!link) throw new HttpError(404, '短链不存在', 'link_not_found');
    const json = normalizeQrStyle(input);
    this.store.sql.updateLinkQrStyle.run(json, Date.now(), link.id);
    if (actor) this.audit(actor, 'link.qr_style', link.code);
    return json;
  }

  /** 设置/清除访问密码，空字符串表示清除 */
  setPassword(id, password, { actor = 'admin' } = {}) {
    const link = this.store.sql.getLinkById.get(Number(id));
    if (!link) throw new HttpError(404, '短链不存在', 'link_not_found');
    const pwd = String(password ?? '');
    if (pwd && pwd.length < 4) throw new HttpError(400, '访问密码至少 4 位', 'password_weak');
    this.history?.record(link.id, { action: 'password', actor });
    this.store.sql.updateLinkPassword.run(pwd ? scrypt(pwd) : null, Date.now(), link.id);
    this.audit(actor, 'link.password', `${link.code}:${pwd ? 'set' : 'clear'}`);
    return this.store.sql.getLinkById.get(link.id);
  }

  /**
   * 续期：把有效期往后推，或者改成永久。
   *
   * 为什么要单独一个入口而不是走 update：批量续期只该动 expire_at 一个字段。
   * 走 update 意味着把 url / title / tags / group 一起重新提交一遍，
   * 只要下拉框里拿到的是一份十秒前读出来的快照，就有覆盖别人改动的机会。
   *
   * 状态怎么办：过期后被自动停用的（status_before_expire 有值）恢复成过期前的样子；
   * 本来就停用的保持停用。这两件事必须分开——把管理员自己关掉的链接
   * 在续期时顺手打开，是比不续期更糟的结果。
   */
  renew(id, input = {}, { actor = 'admin' } = {}) {
    const link = this.store.sql.getLinkById.get(Number(id));
    if (!link) throw new HttpError(404, '短链不存在', 'link_not_found');
    const now = Date.now();
    // 只给了 days 的话，从现在起算。给的是 undefined 会走到 parseExpire 的
    // 「永久」分支——「续 30 天」变成「改成永久」，是错得最安静的一种
    const days = Number(input.days) || 0;
    const given = input.expireAt ?? input.expire_at ?? input.until;
    let expireAt;
    if (given !== undefined) expireAt = parseExpire(given);
    else if (days > 0) expireAt = now + days * 86400000;
    else expireAt = null;
    // 推到过去等于让它立刻再次过期，除了手滑没有别的解释
    if (expireAt !== null && expireAt <= now) {
      throw new HttpError(400, '新的有效期必须晚于当前时间', 'expire_in_past');
    }
    const restore = String(link.status_before_expire || '');
    let status = link.status;
    if (restore === 'active' || restore === 'disabled') {
      status = restore;
    } else if (expireAt === null && link.status === 'disabled' && link.expire_at && link.expire_at < now) {
      // 老数据没有 status_before_expire（v10 之前被自动停用的）：
      // 只在「确实已经过期、又改成永久」时恢复到启用，这是唯一能推断出意图的情形
      status = 'active';
    }
    this.history?.record(link.id, { action: 'renew', actor });
    this.store.sql.setLinkExpire.run(expireAt, status, now, link.id);
    this.audit(actor, 'link.renew', `${link.code}:${expireAt ? new Date(expireAt).toISOString().slice(0, 10) : 'never'}`);
    return this.store.sql.getLinkById.get(link.id);
  }

  /**
   * 批量续期。days 往后推几天，或者 until 一个具体日期；不传两者就是「永久」。
   *
   * 以「现在」为基准而不是以原有效期为基础往后加：一批链接可能已经过期三天，
   * 在过期时间上 +30 天得到的只是「过期了 27 天」，和运营者说的「再放一个月」不是一回事。
   * 原有效期还在未来的，则从原有效期接着延，避免提前续期反而缩短了有效期。
   */
  renewMany(codes, input = {}, { actor = 'admin' } = {}) {
    const list = Array.isArray(codes) ? codes.map(String) : [];
    if (!list.length) throw new HttpError(400, '请先选择短链', 'empty_selection');
    if (list.length > 500) throw new HttpError(400, '单次最多操作 500 条', 'too_many');
    const now = Date.now();
    const days = input.days === undefined || input.days === null || input.days === '' ? null : Number(input.days);
    if (days !== null && (!Number.isFinite(days) || days <= 0)) {
      throw new HttpError(400, 'days 必须是正数', 'bad_days');
    }
    const forever = !days && (input.expireAt === undefined || input.expireAt === null || input.expireAt === '');
    const until = forever ? null : (days ? null : parseExpire(input.expireAt));
    if (!forever && !days && until === null) {
      throw new HttpError(400, '请给出 days、expireAt，或显式指定永久', 'bad_expire');
    }
    if (until !== null && until <= now) throw new HttpError(400, '新的有效期必须晚于当前时间', 'expire_in_past');

    let affected = 0;
    const missing = [];
    this.store.tx(() => {
      for (const code of list) {
        const row = this.store.findLinkByCode(code);
        if (!row) {
          missing.push(code);
          continue;
        }
        const base = row.expire_at && row.expire_at > now ? row.expire_at : now;
        const next = days ? base + days * 86400000 : until;
        this.history?.record(row.id, { action: 'renew', actor });
        const restore = String(row.status_before_expire || '');
        const status = restore === 'active' || restore === 'disabled' ? restore : row.status;
        this.store.sql.setLinkExpire.run(next, status, Date.now(), row.id);
        affected += 1;
      }
    });
    this.audit(actor, 'link.batch_renew', `${affected} 条${forever ? ' → 永久' : ''}`);
    return { affected, missing, forever, days: days || 0, until };
  }

  /**
   * 删除 = 进回收站。软删除的好处是误删能救回来，
   * 短码仍然占位，避免刚删掉就被人抢注走掉流量。
   */
  remove(id, { actor = 'admin' } = {}) {
    const link = this.store.sql.getLinkById.get(Number(id));
    if (!link) throw new HttpError(404, '短链不存在', 'link_not_found');
    this.history?.record(link.id, { action: 'delete', actor });
    this.store.sql.softDeleteById.run(Date.now(), Date.now(), link.id);
    this.audit(actor, 'link.delete', link.code);
    return link;
  }

  /** 从回收站彻底删除，统计一并清掉 */
  purge(id, { actor = 'admin' } = {}) {
    const link = this.store.sql.getLinkByIdAny.get(Number(id));
    if (!link) throw new HttpError(404, '短链不存在', 'link_not_found');
    this.store.tx(() => {
      this.store.sql.deleteLinkById.run(link.id);
      this.store.purgeLinkData(link.code);
    });
    this.audit(actor, 'link.purge', link.code);
    return link;
  }

  restore(id, { actor = 'admin' } = {}) {
    const link = this.store.sql.getLinkByIdAny.get(Number(id));
    if (!link) throw new HttpError(404, '短链不存在', 'link_not_found');
    if (!link.deleted_at) throw new HttpError(409, '该短链不在回收站', 'link_not_deleted');
    this.store.sql.restoreById.run(Date.now(), link.id);
    this.audit(actor, 'link.restore', link.code);
    return this.store.sql.getLinkById.get(link.id);
  }

  trash({ page = 1, perPage = 20 } = {}) {
    const total = this.store.sql.countDeleted.get().n;
    const rows = this.store.sql.listDeleted.all(perPage, (page - 1) * perPage);
    return { rows, total, page, perPage, pages: Math.max(1, Math.ceil(total / perPage)) };
  }

  detail(id) {
    const link = this.store.sql.getLinkById.get(Number(id));
    if (!link) throw new HttpError(404, '短链不存在', 'link_not_found');
    return link;
  }

  audit(actor, action, detail) {
    try {
      this.store.sql.insertAudit.run(Date.now(), actor, action, detail);
    } catch {
      /* 审计失败不影响主流程 */
    }
  }
}

/**
 * 建页入参归一。三种写法都认：
 *   { interstitial: true, landingTheme: 'dark', interstitialNote: '…' }
 *   { landing: { enabled: true, theme: 'dark', note: '…' } }
 *   { landing: false }  ← 只关掉，不动主题和说明
 *
 * `enabled` 返回 undefined 表示「没表态」，调用方决定是沿用旧值还是走站点默认。
 */
export function parseLanding(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const nested = src.landing;
  const out = {};
  const themeOf = (v) => (['auto', 'dark', 'light'].includes(String(v)) ? String(v) : '');

  if (typeof nested === 'boolean') out.enabled = nested;
  else if (nested && typeof nested === 'object') {
    if (nested.enabled !== undefined) out.enabled = Boolean(nested.enabled);
    const t = themeOf(nested.theme);
    if (t) out.theme = t;
    if (nested.note !== undefined) out.note = String(nested.note).slice(0, 200);
  }
  if (src.interstitial !== undefined) out.enabled = Boolean(src.interstitial);
  const flatTheme = themeOf(src.landingTheme);
  if (flatTheme) out.theme = flatTheme;
  if (src.interstitialNote !== undefined) out.note = String(src.interstitialNote).slice(0, 200);
  // 扁平写法：landing 端点与创建接口都接受 { enabled, theme, note } 这种直给的形式
  if (nested === undefined) {
    if (src.enabled !== undefined) out.enabled = Boolean(src.enabled);
    const t = themeOf(src.theme);
    if (t) out.theme = t;
    if (src.note !== undefined) out.note = String(src.note).slice(0, 200);
  }
  return out;
}

export { parseExpire };
export const linkHost = hostOf;
