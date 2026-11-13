import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';

import { loadConfig, ensureSecret } from './config.js';
import { openDatabase } from './lib/db.js';
import { HttpError, parseJsonBody, parseFormBody, sendJson, sendHtml, sendText, redirect, StaticServer, readBody } from './lib/http.js';
import { clientIp, parseCookies, sleep } from './lib/util.js';
import { Router } from './lib/router.js';

import { Settings } from './services/settings.js';
import { AuthService, RateLimiter, SESSION_COOKIE } from './services/auth.js';
import { LinkService } from './services/links.js';
import { GroupService } from './services/groups.js';
import { TitleFetcher } from './services/titles.js';
import { UaFilter } from './services/ua-filter.js';
import { ClickCounter } from './services/counter.js';
import { ClickDeduper } from './services/dedupe.js';
import { LinkCache } from './services/link-cache.js';
import { HealthChecker } from './services/health.js';
import { TargetService } from './services/targets.js';
import { VisitStream } from './services/stream.js';
import { HistoryService } from './services/history.js';
import { NotifyService } from './services/notify.js';
import { DigestPusher } from './services/digest-push.js';

import { createRedirectHandler, handlePasswordSubmit, handleReportSubmit, verifyAccess, accessCookie } from './routes/redirect.js';
import { ReportBox } from './services/reports.js';
import { registerApiRoutes } from './routes/api.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerPublicRoutes } from './routes/public.js';
import { startMaintenance } from './services/maintenance.js';
import { renderMessage } from './pages/message.js';
import { ROOT } from './lib/util.js';

/** 版本号只维护在 package.json，界面和 /health 都从这里读 */
function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

export function createLogger({ level = 'info' } = {}) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 };
  const min = levels[level] ?? 20;
  const emit = (lvl, args) => {
    if (levels[lvl] < min) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${args.map(fmt).join(' ')}`;
    process.stdout.write(`${line}\n`);
  };
  return {
    debug: (...a) => emit('debug', a),
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
  };
}

function fmt(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export async function createServer(options = {}) {
  const config = loadConfig(options);
  const logger = options.logger || createLogger({ level: process.env.HIGHURL_LOG_LEVEL || 'info' });
  const store = openDatabase(config.dbFile);
  const secret = ensureSecret(config.dataDir);
  const settings = new Settings(store, config);

  const auth = new AuthService({ store, secret, logger });
  const titles = new TitleFetcher({ settings, logger });
  const groups = new GroupService({ store, logger });
  const targets = new TargetService({ store, logger });
  const history = new HistoryService({ store, settings, logger });
  const links = new LinkService({ store, settings, titles, groups, targets, history, logger });
  const uaFilter = new UaFilter(store, settings);
  const counter = new ClickCounter(store, settings, logger).start();
  const deduper = new ClickDeduper({ maxKeys: Math.max(1000, Number(settings.get('countCacheMax')) || 20000) });
  const cache = new LinkCache(store, { ttlMs: 30000, max: 20000 });
  const reports = new ReportBox(store);
  // 通知服务要在巡检之前建好：巡检、举报、备份失败都要往它这儿发事件
  const notify = new NotifyService({ store, settings, logger });
  const health = new HealthChecker({ store, settings, logger, notify });
  // 摘要推送依赖通知服务：它不直接发 HTTP，只往 notify 里塞一条事件，
  // 事件订阅、静默时段、退避重试、投递留底这些都复用同一套
  const digestPush = new DigestPusher({ store, settings, notify, logger });
  const stream = new VisitStream();
  // 历史服务要能失效跳转缓存：回滚之后缓存里的旧链接必须立刻不可见
  history.cache = cache;
  const limiter = new RateLimiter({ max: settings.get('rateLimitPerMinute') });
  const createLimiter = new RateLimiter({ max: settings.get('createRateLimitPerMinute') });

  const ctx = {
    config,
    logger,
    store,
    settings,
    auth,
    groups,
    links,
    targets,
    titles,
    uaFilter,
    counter,
    deduper,
    cache,
    reports,
    health,
    stream,
    history,
    notify,
    digestPush,
    limiter,
    createLimiter,
    secret,
    version: readVersion(),
    startedAt: Date.now(),
    stats: { requests: 0, redirects: 0, blocked: 0, errors: 0 },
  };

  const statics = new StaticServer('./public');
  const router = new Router();
  registerPublicRoutes(router, ctx);
  registerApiRoutes(router, ctx);
  registerAdminRoutes(router, ctx);
  const handleRedirect = createRedirectHandler(ctx);

  const maintenance = startMaintenance(ctx);
  ctx.maintenance = maintenance;

  const server = http.createServer(async (req, res) => {
    const started = process.hrtime.bigint();
    ctx.stats.requests += 1;
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      sendText(res, 400, 'Bad Request');
      return;
    }
    const pathname = decodeSafe(url.pathname);
    const ip = clientIp(req, settings.get('trustProxy'));
    req.ip = ip;

    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      if (ms > 200 || pathname.startsWith('/api')) {
        logger.debug(`${req.method} ${pathname} ${res.statusCode} ${ms.toFixed(1)}ms`);
      }
    });

    try {
      // 1) 静态资源
      if (pathname.startsWith('/static/') || pathname.startsWith('/img/')) {
        // 页面引用这些资源时都带 `?v=<版本号>`，版本一变 URL 就变，
        // 所以可以放心地让浏览器长期缓存。以前这里只给 5 分钟，
        // 结果升级后用户拿着旧 admin.js 对着新接口跑，改了半天的行为看不见——
        // 而真正需要「立刻生效」的场景，恰好是升级之后的那一次刷新
        const fingerprinted = new URL(req.url, 'http://x').searchParams.has('v');
        const served = statics.serve(req, res, pathname.replace(/^\/(static|img)\//, (m) => (m === '/img/' ? '/img/' : '/static/')), {
          immutable: fingerprinted,
        });
        if (served) return;
        throw new HttpError(404, '资源不存在', 'static_not_found');
      }
      // 浏览器会直接嗅探 /favicon.ico，统一指到图标目录
      if (pathname === '/favicon.ico') {
        redirect(res, '/img/favicon.ico', 301);
        return;
      }
      if (pathname === '/favicon.svg' || pathname === '/manifest.webmanifest' || pathname === '/robots.txt') {
        if (statics.serve(req, res, pathname)) return;
      }

      // 2) 限流
      const limit = ctx.limiter.take(`ip:${ip}`);
      if (!limit.allowed) {
        res.writeHead(429, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Retry-After': String(Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000))),
          'X-RateLimit-Limit': String(limit.limit),
          'X-RateLimit-Remaining': '0',
        });
        res.end('请求过于频繁，请稍后再试');
        return;
      }

      // 3) 路由
      const matched = router.match(req.method, pathname, req.method === 'HEAD' ? ['GET'] : []);
      if (matched) {
        await matched.handler(req, res, { ...matched.params, url, ip });
        return;
      }

      // 4) 短链跳转（最后兜底，允许带子路径）
      const segments = pathname.split('/').filter(Boolean);
      const first = segments[0];
      if (first && req.method === 'POST' && segments.length === 1) {
        const form = await parseFormBody(req, ctx.config.maxBodyBytes);
        // 同一个 POST /<code> 上有两种表单：解锁密码、提交举报。按隐藏字段区分，
        // 而不是再加一个路径——短码字符集里没有 `/`，加路径会撞上子路径透传
        if (form.kind === 'report') {
          const handled = await handleReportSubmit(ctx, req, res, { ...form, code: decodeSafe(first) });
          if (handled) return;
        }
        const handled = await handlePasswordSubmit(ctx, req, res, { ...form, code: decodeSafe(first) });
        if (handled) return;
      }
      if (first && req.method !== 'POST') {
        const code = decodeSafe(first);
        const done = await handleRedirect(req, res, code, url);
        if (done === false && req.method === 'GET') {
          sendHtml(res, 404, notFoundPage(ctx, code));
          return;
        }
        if (done) return;
      }

      if (req.method === 'GET') {
        sendHtml(res, 404, notFoundPage(ctx, ''));
        return;
      }
      throw new HttpError(404, '接口不存在', 'not_found');
    } catch (err) {
      handleError(ctx, req, res, err);
    }
  });

  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.requestTimeout = 30000;

  const close = async () => {
    maintenance.stop();
    stream.closeAll();
    counter.stop();
    limiter.stop();
    createLimiter.stop();
    await counter.flush().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    store.close();
  };

  return { server, ctx, close, config, logger };
}

function decodeSafe(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function handleError(ctx, req, res, err) {
  if (err instanceof HttpError) {
    if (err.status >= 500) ctx.stats.errors += 1;
    const wantsJson = wantsJsonResponse(req);
    if (wantsJson) {
      sendJson(res, err.status, { ok: false, error: { code: err.code, message: err.message, ...err.extra } });
      return;
    }
    sendText(res, err.status, err.message);
    return;
  }
  ctx.stats.errors += 1;
  ctx.logger.error(`[500] ${req.method} ${req.url}`, err);
  if (!res.headersSent) {
    if (wantsJsonResponse(req)) sendJson(res, 500, { ok: false, error: { code: 'internal_error', message: '服务器内部错误' } });
    else sendText(res, 500, '服务器内部错误');
    return;
  }
  res.end();
}

/** 接口请求统一回 JSON：/api、/admin/api，或客户端显式要 JSON */
function wantsJsonResponse(req) {
  if ((req.headers.accept || '').includes('application/json')) return true;
  const path = String(req.url || '').split('?')[0];
  return path.startsWith('/api/') || path.startsWith('/admin/api') || path === '/api';
}

function notFoundPage(ctx, code) {
  return renderMessage(ctx, {
    status: 404,
    title: code ? '短链接不存在' : '页面不存在',
    desc: code ? `「/${code}」没有对应的记录，可能已被删除。` : '你访问的页面不存在。',
    code: '',
  });
}

export { HttpError, parseJsonBody, parseFormBody, sendJson, sendHtml, sendText, redirect, readBody, parseCookies, verifyAccess, accessCookie, SESSION_COOKIE, sleep };
