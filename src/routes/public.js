import { HttpError, parseFormBody, parseJsonBody, sendHtml, sendJson, sendText, redirect } from '../lib/http.js';
import { renderLanding } from '../pages/landing.js';
import { renderDocs } from '../pages/docs.js';
import { renderMessage } from '../pages/message.js';
import { dateKey } from '../lib/util.js';

export function registerPublicRoutes(router, ctx) {
  const { store, settings, logger, cache, counter } = ctx;

  router.get('/', (req, res) => {
    const overview = store.statsOverview(dateKey(new Date(Date.now() - 6 * 86400000)));
    const today = dateKey();
    const todayRow = overview.daily.find((d) => d.day === today);
    const latest = settings.get('publicCreate')
      ? store.db.prepare("SELECT code, title, url, clicks FROM links WHERE status='active' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 6").all()
      : [];
    const html = renderLanding(ctx, {
      publicCreate: settings.get('publicCreate'),
      latest,
      stats: { ...overview, today: todayRow?.clicks || 0 },
    });
    sendHtml(res, 200, html, { 'Cache-Control': 'no-cache' });
  });

  router.get('/docs', (req, res) => {
    sendHtml(res, 200, renderDocs(ctx), { 'Cache-Control': 'no-cache' });
  });

  router.get('/health', (req, res) => {
    let dbOk = true;
    try {
      store.db.prepare('SELECT 1').get();
    } catch {
      dbOk = false;
    }
    const uptime = Math.floor((Date.now() - ctx.startedAt) / 1000);
    const status = dbOk ? 200 : 503;
    sendJson(res, status, {
      status: dbOk ? 'ok' : 'degraded',
      version: ctx.version,
      uptime,
      counters: counter.stats(),
      cache: cache.stats(),
      dedupe: ctx.deduper?.stats?.() || null,
      requests: ctx.stats,
    }, { 'Cache-Control': 'no-store' });
  });

  // Prometheus 风格指标，方便接监控
  router.get('/metrics', (req, res) => {
    const overview = store.statsOverview(dateKey(new Date(Date.now() - 29 * 86400000)));
    const s = counter.stats();
    const c = cache.stats();
    const lines = [
      '# HELP highurl_links_total 短链总数',
      '# TYPE highurl_links_total gauge',
      `highurl_links_total ${overview.total}`,
      '# HELP highurl_clicks_total 累计点击（已落库）',
      '# TYPE highurl_clicks_total counter',
      `highurl_clicks_total ${overview.clicks}`,
      '# HELP highurl_clicks_pending 内存中待落库的点击',
      '# TYPE highurl_clicks_pending gauge',
      `highurl_clicks_pending ${s.pendingClicks}`,
      '# HELP highurl_cache_hit_ratio 跳转缓存命中率',
      '# TYPE highurl_cache_hit_ratio gauge',
      `highurl_cache_hit_ratio ${c.hitRate}`,
      '# HELP highurl_requests_total 进程处理的请求数',
      '# TYPE highurl_requests_total counter',
      `highurl_requests_total ${ctx.stats.requests}`,
      '# HELP highurl_process_uptime_seconds 进程运行时长',
      '# TYPE highurl_process_uptime_seconds gauge',
      `highurl_process_uptime_seconds ${Math.floor((Date.now() - ctx.startedAt) / 1000)}`,
      '# HELP highurl_clicks_deduped_total 被去重窗口跳过的点击',
      '# TYPE highurl_clicks_deduped_total counter',
      `highurl_clicks_deduped_total ${ctx.deduper?.stats?.().skipped || 0}`,
      '',
    ];
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(lines.join('\n'));
  });

  // 公开创建接口（服务端二次校验开关）
  router.post('/api/shorten', async (req, res) => {
    if (!settings.get('publicCreate')) {
      throw new HttpError(403, '本站未开启公开创建，请登录管理台', 'public_create_disabled');
    }
    checkOrigin(req, settings.get('baseUrl'));
    const limit = ctx.createLimiter.take(`create:${req.ip || ''}`);
    if (!limit.allowed) {
      throw new HttpError(429, '创建过于频繁，请稍后再试', 'rate_limited');
    }
    const body = await parseJsonBody(req, ctx.config.maxBodyBytes);
    const link = await ctx.links.create({ url: body.url, code: body.code, title: body.title, fetchTitle: true }, { actor: `public:${req.socket?.remoteAddress || ''}` });
    cache.invalidate(link.code);
    sendJson(res, 201, {
      ok: true,
      result: {
        code: link.code,
        shortUrl: shortUrl(ctx, link.code, req),
        url: link.url,
        title: link.title,
      },
    });
  });

  router.get('/robots.txt', (req, res) => {
    const lines = ['User-agent: *'];
    if (settings.get('blockBots')) lines.push('Disallow: /');
    else lines.push('Disallow: /admin', 'Disallow: /api');
    lines.push('', `Sitemap: ${baseUrl(ctx, req)}/sitemap.xml`);
    sendText(res, 200, lines.join('\n'), { 'Cache-Control': 'public, max-age=3600' });
  });

  router.get('/sitemap.xml', (req, res) => {
    const rows = store.db
      .prepare("SELECT code, updated_at FROM links WHERE status='active' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 5000")
      .all();
    const base = baseUrl(ctx, req);
    const urls = rows
      .map((r) => `<url><loc>${base}/${encodeURIComponent(r.code)}</loc><lastmod>${new Date(r.updated_at).toISOString()}</lastmod></url>`)
      .join('');
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
  });

  router.get('/manifest.webmanifest', (req, res) => {
    sendJson(res, 200, {
      name: settings.get('siteName'),
      short_name: settings.get('siteName'),
      description: settings.get('siteDescription'),
      start_url: '/',
      display: 'standalone',
      background_color: '#07070f',
      theme_color: '#0B0A1F',
      icons: [
        { src: '/img/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/img/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/img/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    }, { 'Cache-Control': 'public, max-age=3600' });
  });
}

/** 校验请求来源，防 CSRF 与跨站调用 */
export function checkOrigin(req, baseUrl = '') {
  const origin = req.headers.origin;
  if (!origin) return; // 非浏览器客户端（curl / 服务端）不校验
  const host = req.headers.host;
  try {
    const o = new URL(origin);
    if (host && o.host === host) return;
    if (baseUrl) {
      const b = new URL(baseUrl);
      if (o.host === b.host) return;
    }
  } catch {
    /* fallthrough */
  }
  throw new HttpError(403, '来源校验失败', 'origin_mismatch');
}

export function baseUrl(ctx, req) {
  const configured = ctx.settings.get('baseUrl');
  if (configured) return configured.replace(/\/+$/, '');
  const proto = ctx.settings.get('trustProxy')
    ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http'
    : 'http';
  const host = req.headers.host || `localhost:${ctx.config.port}`;
  return `${proto}://${host}`;
}

export function shortUrl(ctx, code, req) {
  return `${baseUrl(ctx, req)}/${encodeURIComponent(code)}`;
}
