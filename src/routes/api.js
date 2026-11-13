import { HttpError, parseJsonBody, sendJson } from '../lib/http.js';
import { clientIp } from '../lib/util.js';
import { shortUrl, baseUrl, checkOrigin } from './public.js';
import { SESSION_COOKIE } from '../services/auth.js';
import { dateKey } from '../lib/util.js';
import { serializeTarget } from '../services/targets.js';

export function registerApiRoutes(router, ctx) {
  const { store, settings, auth, links, cache, logger } = ctx;

  /** API 鉴权：Bearer Token（管理 API），或站点开启公开创建时的匿名调用 */
  function requireApi(req, scope = 'read') {
    const raw = auth.extractKey(req);
    if (raw) {
      const key = auth.verifyKey(raw);
      if (!key) throw new HttpError(401, 'API 密钥无效或已停用', 'invalid_api_key');
      const scopes = String(key.scope || '').split(',').map((s) => s.trim());
      if (!scopes.includes(scope) && !scopes.includes('write')) {
        throw new HttpError(403, `密钥缺少 ${scope} 权限`, 'insufficient_scope');
      }
      return { kind: 'api', name: key.name };
    }
    // 无密钥时允许用管理员会话。
    // 这里必须按 Cookie 名把值取出来再验签：直接把整个 Cookie 对象丢给
    // verifySession，它拿到的不是 token 字符串，签名校验必然失败，
    // 于是「带会话调 API」这条路径其实是 401——文档里写了却一直不生效。
    const session = ctx.auth.verifySession(parseCookie(req.headers.cookie || '')[SESSION_COOKIE]);
    if (session) return { kind: 'session', name: session.username };
    throw new HttpError(401, '需要 API 密钥或管理员登录', 'unauthorized');
  }

  const handler = (scope, fn) => async (req, res, params) => {
    const actor = requireApi(req, scope);
    req.actor = actor;
    const data = await fn(req, res, params);
    sendJson(res, 200, { ok: true, ...data });
  };

  router.get('/api/v1/links', handler('read', async (req, res, params) => {
    const url = new URL(req.url, 'http://x');
    const q = url.searchParams;
    const page = Math.max(1, Number(q.get('page')) || 1);
    const perPage = Math.min(200, Math.max(1, Number(q.get('perPage')) || 20));
    const { rows, total } = store.listLinks({
      q: q.get('q') || '',
      status: q.get('status') || '',
      tag: q.get('tag') || '',
      group: q.get('group') || '',
      health: q.get('health') || '',
      sort: q.get('sort') || 'created_desc',
      page,
      perPage,
    });
    return {
      result: {
        items: rows.map((row) => serialize(ctx, req, row)),
        total,
        page,
        perPage,
        pages: Math.max(1, Math.ceil(total / perPage)),
      },
    };
  }));

  router.get('/api/v1/links/:code', handler('read', async (req, res, params) => {
    const row = store.findLinkByCode(params.code);
    if (!row) throw new HttpError(404, '短链不存在', 'link_not_found');
    return { result: serialize(ctx, req, row) };
  }));

  router.get('/api/v1/links/:code/stats', handler('read', async (req, res, params) => {
    const row = store.findLinkByCode(params.code);
    if (!row) throw new HttpError(404, '短链不存在', 'link_not_found');
    const days = Math.min(365, Math.max(1, Number(new URL(req.url, 'http://x').searchParams.get('days')) || 30));
    return { result: statsFor(store, row, days) };
  }));

  router.post('/api/v1/links', async (req, res) => {
    const actor = requireApi(req, 'write');
    checkOrigin(req, settings.get('baseUrl'));
    const body = await parseJsonBody(req, ctx.config.maxBodyBytes);
    const link = await links.create(body, { actor: `${actor.kind}:${actor.name}` });
    cache.invalidate(link.code);
    sendJson(res, 201, { ok: true, result: serialize(ctx, req, link, { includePassword: false }) });
  });

  router.patch('/api/v1/links/:code', async (req, res, params) => {
    const actor = requireApi(req, 'write');
    checkOrigin(req, settings.get('baseUrl'));
    const row = store.findLinkByCode(params.code);
    if (!row) throw new HttpError(404, '短链不存在', 'link_not_found');
    const body = await parseJsonBody(req, ctx.config.maxBodyBytes);
    const link = await links.update(row.id, body, { actor: `${actor.kind}:${actor.name}` });
    cache.invalidate(link.code);
    sendJson(res, 200, { ok: true, result: serialize(ctx, req, link) });
  });

  router.delete('/api/v1/links/:code', async (req, res, params) => {
    const actor = requireApi(req, 'write');
    checkOrigin(req, settings.get('baseUrl'));
    const row = store.findLinkByCode(params.code);
    if (!row) throw new HttpError(404, '短链不存在', 'link_not_found');
    links.remove(row.id, { actor: `${actor.kind}:${actor.name}` });
    cache.invalidate(row.code);
    sendJson(res, 200, { ok: true, deleted: row.code });
  });

  router.get('/api/v1/stats', handler('read', async (req) => {
    const days = Math.min(365, Math.max(1, Number(new URL(req.url, 'http://x').searchParams.get('days')) || 30));
    return { result: overviewStats(store, days) };
  }));
}

/** 拆 Cookie 头。重名取后者，与浏览器行为一致 */
function parseCookie(header) {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

export function serialize(ctx, req, row, { includePassword = false } = {}) {
  return {
    id: row.id,
    code: row.code,
    shortUrl: shortUrl(ctx, row.code, req),
    url: row.url,
    title: row.title,
    note: row.note,
    tags: row.tags ? String(row.tags).split(',') : [],
    group: row.group_id ? { id: row.group_id, name: row.group_name || '' } : null,
    status: row.status,
    health: {
      status: row.health_status || 'unknown',
      code: row.health_code ?? null,
      at: row.health_at ?? null,
      ms: row.health_ms ?? null,
      error: row.health_error || '',
      miss: row.health_miss || 0,
    },
    protected: Boolean(row.protected),
    // 建页：1 开 / 0 关，创建时已按站点默认值落库，所以这里永远是个确定的布尔
    landing: {
      enabled: Boolean(row.interstitial),
      theme: row.landing_theme || 'auto',
      note: row.interstitial_note || '',
    },
    qrStyle: row.qr_style ? safeJson(row.qr_style) : null,
    targetCount: row.target_count ?? 0,
    clicks: row.clicks,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastClickAt: row.last_click_at,
    expireAt: row.expire_at,
    deletedAt: row.deleted_at || null,
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function statsFor(store, row, days = 30) {
  const since = dateKey(new Date(Date.now() - (days - 1) * 86400000));
  const daily = store.sql.linkDaily.all(row.code, since);
  const map = new Map(daily.map((d) => [d.day, d.clicks]));
  const series = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = dateKey(new Date(Date.now() - i * 86400000));
    series.push({ day: key, clicks: map.get(key) || 0 });
  }
  return {
    code: row.code,
    clicks: row.clicks,
    lastClickAt: row.last_click_at,
    daily: series,
    hours: store.hourMatrix(store.sql.linkSlots.all(row.code)),
    referrers: store.sql.linkRefs.all(row.code, 10),
    platforms: store.sql.linkAgents.all(row.code, 10),
    countries: store.sql.linkCountries.all(row.code, 12),
    targets: store.listTargets(row.id).map(serializeTarget),
    // 建页曝光：和点击分开统计，混在一起会让「点击数」和漏斗对不上
    views: store.db
      .prepare(`SELECT COALESCE(SUM(views), 0) AS n FROM landing_views WHERE code = ? AND day >= ?`)
      .get(row.code, since).n,
  };
}

export function overviewStats(store, days = 30) {
  const since = dateKey(new Date(Date.now() - (days - 1) * 86400000));
  const overview = store.statsOverview(since);
  const map = new Map(overview.daily.map((d) => [d.day, d.clicks]));
  const series = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = dateKey(new Date(Date.now() - i * 86400000));
    series.push({ day: key, clicks: map.get(key) || 0 });
  }
  return {
    total: overview.total,
    hours: store.hourMatrix(store.sql.globalSlots.all()),
    active: overview.active,
    disabled: overview.disabled,
    expired: overview.expired,
    clicks: overview.clicks,
    daily: series,
  };
}
