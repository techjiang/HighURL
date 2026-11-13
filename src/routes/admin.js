import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { HttpError, parseFormBody, parseJsonBody, sendHtml, sendJson, redirect, readBody } from '../lib/http.js';
import { clientIp, parseCookies } from '../lib/util.js';
import { renderLogin, renderInstall, renderAdminShell } from '../pages/admin.js';
import { serialize, statsFor, overviewStats } from './api.js';
import { shortUrl } from './public.js';
import { checkOrigin } from './public.js';
import { SESSION_COOKIE } from '../services/auth.js';
import { detectFormat, parseByFormat, planImport, applyImport } from '../services/migrate.js';
import { compileRule } from '../services/ua-filter.js';
import { parseQrStyle } from '../services/qr-style.js';
import { dateKey } from '../lib/util.js';
import { qrSvg, qrPng, resolveStyle, QR_PRESETS } from '../services/qr.js';
import { zipStore } from '../lib/zip.js';
import { buildQrSheetPdf, sheetStyleFromQuery } from '../services/qr-sheet.js';
import { GroupService } from '../services/groups.js';
import { normalizeTags } from '../services/links.js';
import { serializeTarget } from '../services/targets.js';
import { funnelRows, funnelSummary } from '../services/funnel.js';
import { maskIp } from '../services/stream.js';
import { buildDigest } from '../services/insights.js';
import { inspectBackup, restoreBackup } from '../services/restore.js';
import { buildBackup, listBackups, backupPath, verifyBackup, KEEP_AUTO_BACKUPS } from '../services/backup.js';

/**
 * 热点榜的字段名统一成 camelCase 再出门。
 * 直接吐 SQL 列名会让前端在 `clicks`（窗口内）和 `total_clicks`（累计）之间反复搞混，
 * 而这两个数在界面上并排出现，混一次就是一条错结论。
 */
function serializeHot(rows) {
  return rows.map((r) => ({
    code: r.code,
    title: r.title,
    group: r.group_id ? { id: r.group_id, name: r.group_name || '' } : null,
    windowClicks: r.window_clicks,
    windowViews: r.window_views,
    totalClicks: r.total_clicks,
    lastClickAt: r.last_click_at,
  }));
}

export function registerAdminRoutes(router, ctx) {
  const { store, settings, auth, links, cache, logger, counter } = ctx;
  const groups = ctx.groups || new GroupService({ store, logger });

  const session = (req) => auth.verifySession(parseCookies(req.headers.cookie || '')[SESSION_COOKIE]);

  function requireSession(req) {
    const s = session(req);
    if (!s) throw new HttpError(401, '请先登录', 'unauthorized');
    return s;
  }

  // ---------- 页面 ----------
  router.get('/login', (req, res) => {
    if (session(req)) return redirect(res, '/admin', 302);
    if (!auth.hasAdmin()) return redirect(res, '/install', 302);
    sendHtml(res, 200, renderLogin(ctx, { error: '' }), { 'Cache-Control': 'no-store' });
  });

  router.post('/login', async (req, res) => {
    const body = await parseFormBody(req, ctx.config.maxBodyBytes);
    const ip = clientIp(req, settings.get('trustProxy'));
    const limit = ctx.createLimiter.take(`login:${ip}`, 1);
    if (!limit.allowed) {
      sendHtml(res, 429, renderLogin(ctx, { error: '尝试过于频繁，请稍后再试' }), { 'Cache-Control': 'no-store' });
      return;
    }
    try {
      const { cookie } = auth.login(body.username, body.password, { ip });
      res.setHeader('Set-Cookie', cookie);
      redirect(res, '/admin', 303);
    } catch (err) {
      sendHtml(res, 401, renderLogin(ctx, { error: err instanceof HttpError ? err.message : '登录失败' }), { 'Cache-Control': 'no-store' });
    }
  });

  router.post('/logout', (req, res) => {
    res.setHeader('Set-Cookie', auth.clearCookie());
    redirect(res, '/login', 303);
  });

  router.get('/install', (req, res) => {
    if (auth.hasAdmin()) return redirect(res, '/login', 302);
    sendHtml(res, 200, renderInstall(ctx), { 'Cache-Control': 'no-store' });
  });

  router.post('/install', async (req, res) => {
    if (auth.hasAdmin()) throw new HttpError(403, '系统已完成初始化', 'already_installed');
    const body = await parseFormBody(req, ctx.config.maxBodyBytes);
    const result = auth.createAdmin(body.username, body.password);
    try {
      if (body.siteName) settings.update({ siteName: String(body.siteName).slice(0, 60) });
      if (body.baseUrl) settings.update({ baseUrl: String(body.baseUrl) });
      settings.update({ allowRegistration: false });
    } catch (err) {
      logger.warn('[install] 站点设置写入失败', err.message);
    }
    const { cookie } = auth.login(result.username, body.password, { ip: clientIp(req) });
    res.setHeader('Set-Cookie', cookie);
    store.sql.insertAudit.run(Date.now(), result.username, 'install', 'init admin');
    redirect(res, '/admin', 303);
  });

  router.get('/admin', (req, res) => {
    if (!auth.hasAdmin()) return redirect(res, '/install', 302);
    const s = session(req);
    if (!s) return redirect(res, '/login', 302);
    sendHtml(res, 200, renderAdminShell(ctx, s), { 'Cache-Control': 'no-store' });
  });

  // ---------- 管理 API ----------
  const api = async (req, res, fn) => {
    const me = requireSession(req);
    if (req.method !== 'GET') checkOrigin(req, settings.get('baseUrl'));
    const data = await fn(me, req);
    sendJson(res, 200, { ok: true, ...data });
  };

  router.get('/admin/api/me', (req, res) => api(req, res, (me) => ({ result: { username: me.username, baseUrl: settings.get('baseUrl') } })));

  router.get('/admin/api/overview', (req, res) =>
    api(req, res, () => {
      const days = 14;
      const stats = overviewStats(store, days);
      const top = store.db
        .prepare('SELECT code, title, url, clicks FROM links WHERE deleted_at IS NULL ORDER BY clicks DESC LIMIT 5')
        .all();
      const today = dateKey();
      const todayClicks = stats.daily.find((d) => d.day === today)?.clicks || 0;
      const recent = store.db
        .prepare('SELECT code, title, url, created_at FROM links WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 5')
        .all();
      return {
        result: {
          ...stats,
          hours: store.hourMatrix(store.sql.globalSlots.all()),
          todayClicks,
          todayNew: store.sql.countLinksSince.get(Date.now() - 86400000).n,
          top,
          recent,
          counter: counter.stats(),
          cache: cache.stats(),
          rules: ctx.uaFilter.summary(),
          activity: store.sql.listAudit.all(6),
          groups: store.listGroupsWithCounts(),
          ungrouped: store.countUngrouped(),
          trashed: store.sql.countDeleted.get().n,
          health: ctx.health?.summary?.() || null,
          visits: ctx.stream?.recent(12) || [],
          hot: serializeHot(store.hotLinks({ hours: 24, limit: 6 }).rows),
          digest: buildDigest(store, { hours: 24 }),
        },
      };
    }),
  );

  /**
   * 运营日报：概览顶部那一条。窗口可调，但只接受小时数——
   * 底层统计都是天粒度，给「最近 3 天半」这种窗口也只会被悄悄取整。
   */
  router.get('/admin/api/digest', (req, res) =>
    api(req, res, () => {
      const q = new URL(req.url, 'http://x').searchParams;
      const hours = Number(q.get('hours')) || 24;
      return { result: buildDigest(store, { hours }) };
    }),
  );

  /** 热点短链：最近 N 小时新增点击最多的一批，带窗口内曝光 */
  router.get('/admin/api/hot', (req, res) =>
    api(req, res, () => {
      const q = new URL(req.url, 'http://x').searchParams;
      const hours = Number(q.get('hours')) || 24;
      const limit = Math.min(50, Math.max(1, Number(q.get('limit')) || 8));
      const out = store.hotLinks({ hours, limit });
      return { result: { ...out, rows: serializeHot(out.rows) } };
    }),
  );

  router.get('/admin/api/links', (req, res) =>
    api(req, res, (me, req) => {
      const q = new URL(req.url, 'http://x').searchParams;
      const page = Math.max(1, Number(q.get('page')) || 1);
      const perPage = Math.min(100, Math.max(1, Number(q.get('perPage')) || 20));
      const { rows, total } = store.listLinks({
        q: q.get('q') || '',
        status: q.get('status') || '',
        tag: q.get('tag') || '',
        group: q.get('group') || '',
        health: q.get('health') || '',
        heat: q.get('heat') || '',
        sort: q.get('sort') || 'created_desc',
        sinceDay: dateKey(new Date(Date.now() - 86400000)),
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
          tags: store.listTags(),
          groups: store.listGroupsWithCounts(),
          ungrouped: store.countUngrouped(),
          health: ctx.health?.summary?.() || null,
        },
      };
    }),
  );

  router.post('/admin/api/links', (req, res) =>
    api(req, res, async (me, req) => {
      const body = await parseJsonBody(req, ctx.config.maxBodyBytes);
      const link = await links.create(body, { actor: me.username });
      cache.invalidate(link.code);
      return { result: serialize(ctx, req, link) };
    }),
  );

  // 批量启停 / 删除：一次性提交选中的短码，单事务内完成
  router.post('/admin/api/links/batch', (req, res) =>
    api(req, res, async (me, req) => {
      const body = await parseJsonBody(req, ctx.config.maxBodyBytes);
      const action = String(body.action || '');
      const ACTIONS = ['enable', 'disable', 'delete', 'restore', 'purge', 'group', 'tags'];
      if (!ACTIONS.includes(action)) {
        throw new HttpError(400, `action 只能是 ${ACTIONS.join(' / ')}`, 'bad_action');
      }
      const codes = Array.isArray(body.codes) ? body.codes.map((c) => String(c)) : [];
      if (!codes.length) throw new HttpError(400, '请先选择短链', 'empty_selection');
      if (codes.length > 500) throw new HttpError(400, '单次最多操作 500 条', 'too_many');

      // 批量改分组的入参先算好：group 为 null/'' 表示「移出分组」
      const targetGroup = action === 'group' ? links.groupIdOf(links.pickGroupInput(body)) : undefined;
      // 批量改标签支持两种语义：merge 追加、replace 覆盖、clear 清空
      const tagMode = action === 'tags' ? String(body.mode || 'merge') : '';
      if (action === 'tags' && !['merge', 'replace', 'clear'].includes(tagMode)) {
        throw new HttpError(400, 'mode 只能是 merge / replace / clear', 'bad_mode');
      }
      const tagInput = action === 'tags' ? body.tags : undefined;

      // restore / purge 要能看见回收站里的记录，其余动作只看正常记录
      const includeDeleted = action === 'restore' || action === 'purge';
      let affected = 0;
      const missing = [];
      store.tx(() => {
        for (const code of codes) {
          // 短码不分大小写，批量操作也要认同一套规则
          const row = store.findLinkByCode(code, { includeDeleted });
          if (!row) {
            missing.push(code);
            continue;
          }
          // 批量操作同样要留档：一次勾 200 条改标签，事后想退回去时
          // 「只记得改了标签」和「知道每条原来是什么」差着一整次人工核对
          if (!['purge', 'restore'].includes(action)) ctx.history?.record(row.id, { action: `batch_${action}`, actor: me.username });
          if (action === 'group') {
            store.sql.setLinkGroup.run(targetGroup ?? null, Date.now(), row.id);
          } else if (action === 'tags') {
            store.sql.updateLink.run(
              row.url, row.title, row.note, mergeTags(row.tags, tagInput, tagMode),
              row.status, row.expire_at, Date.now(), row.id,
            );
          } else if (action === 'purge') {
            store.sql.deleteLinkById.run(row.id);
            store.purgeLinkData(row.code);
          } else if (action === 'restore') {
            if (!row.deleted_at) {
              missing.push(code);
              continue;
            }
            store.sql.restoreById.run(Date.now(), row.id);
          } else if (action === 'delete') {
            // 软删除：记录与统计都留着，短码继续占位，误删可救
            store.sql.softDeleteById.run(Date.now(), Date.now(), row.id);
          } else {
            store.sql.updateLink.run(
              row.url, row.title, row.note, row.tags,
              action === 'enable' ? 'active' : 'disabled',
              row.expire_at, Date.now(), row.id,
            );
          }
          affected += 1;
        }
      });
      cache.invalidate();
      links.audit(me.username, `link.batch_${action}`, `${affected} 条`);
      return { result: { affected, missing } };
    }),
  );

  router.patch('/admin/api/links/:code', (req, res, params) =>
    api(req, res, async (me, req) => {
      const row = store.findLinkByCode(params.code);
      if (!row) throw new HttpError(404, '短链不存在', 'link_not_found');
      const body = await parseJsonBody(req, ctx.config.maxBodyBytes);
      const link = await links.update(row.id, body, { actor: me.username });
      cache.invalidate(link.code);
      return { result: serialize(ctx, req, link) };
    }),
  );

  // 建页单独一个入口：改个开关不该要求把目标地址、标题一起重新提交一遍
  router.patch('/admin/api/links/:code/landing', (req, res, params) =>
    api(req, res, async (me, req) => {
      const row = store.findLinkByCode(params.code);
      if (!row) throw new HttpError(404, '短链不存在', 'link_not_found');
      const body = await parseJsonBody(req, ctx.config.maxBodyBytes);
      const link = links.setLanding(row.id, body, { actor: me.username });
      cache.invalidate(link.code);
      return { result: serialize(ctx, req, link) };
    }),
  );

  /** 二维码样式按短链记：物料是按那套样式印的，换台机器打开不该变回黑白 */
  router.get('/admin/api/qr/styles', (req, res) =>
    api(req, res, () => {
      const map = {};
      for (const row of store.sql.listQrStyles.all()) {
        const parsed = parseQrStyle(row.qr_style);
        if (Object.keys(parsed).length) map[row.code] = parsed;
      }
      return { result: { styles: map } };
    }),
  );

  router.put('/admin/api/links/:code/qr-style', (req, res, params) =>
    api(req, res, async (me, req) => {
      const row = store.findLinkByCode(params.code);
      if (!row) throw new HttpError(404, '短链不存在', 'link_not_found');
      const body = await parseJsonBody(req, ctx.config.maxBodyBytes);
      const json = links.setQrStyle(row.id, body.qrStyle ?? body, { actor: me.username });
      return { result: { code: row.code, qrStyle: json ? JSON.parse(json) : null } };
    }),
  );

  router.delete('/admin/api/links/:code', (req, res, params) =>
    api(req, res, (me) => {
      const row = store.findLinkByCode(params.code);
      if (!row) throw new HttpError(404, '短链不存在', 'link_not_found');
      links.remove(row.id, { actor: me.username });
      cache.invalidate(row.code);
      return { deleted: row.code, trashed: true };
    }),
  );

  // ---------- 回收站 ----------
  router.get('/admin/api/trash', (req, res) =>
    api(req, res, () => {
      const q = new URL(req.url, 'http://x').searchParams;
      const page = Math.max(1, Number(q.get('page')) || 1);
      const perPage = Math.min(100, Math.max(1, Number(q.get('perPage')) || 20));
      const { rows, total, pages } = links.trash({ page, perPage });
      return { result: { items: rows.map((row) => serialize(ctx, req, row)), total, page, perPage, pages } };
    }),
  );

  router.post('/admin/api/trash/empty', (req, res) =>
    api(req, res, (me) => {
      let removed = 0;
      store.tx(() => {
        for (const row of store.sql.listDeleted.all(100000, 0)) {
          store.sql.deleteLinkById.run(row.id);
          store.purgeLinkData(row.code);
          removed += 1;
        }
      });
      links.audit(me.username, 'link.purge_all', `${removed} 条`);
      return { result: { removed } };
    }),
  );

  router.post('/admin/api/trash/:code/restore', (req, res, params) =>
    api(req, res, (me) => {
      const row = store.findLinkByCode(params.code, { includeDeleted: true });
      if (!row) throw new HttpError(404, '短链不存在', 'link_not_found');
      const link = links.restore(row.id, { actor: me.username });
      cache.invalidate(link.code);
      return { result: serialize(ctx, req, link) };
    }),
  );

  router.delete('/admin/api/trash/:code', (req, res, params) =>
    api(req, res, (me) => {
      const row = store.findLinkByCode(params.code, { includeDeleted: true });
      if (!row) throw new HttpError(404, '短链不存在', 'link_not_found');
      links.purge(row.id, { actor: me.username });
      cache.invalidate(row.code);
      return { purged: row.code };
    }),
  );

  // ---------- 分组 ----------
  router.get('/admin/api/groups', (req, res) => api(req, res, () => ({ result: groups.list() })));

  router.post('/admin/api/groups', (req, res) =>
    api(req, res, async (me, req) => {
      const body = await parseJsonBody(req, ctx.config.maxBodyBytes);
      const group = groups.create(body, { actor: me.username });
      return { result: group };
    }),
  );

  router.patch('/admin/api/groups/:id', (req, res, params) =>
    api(req, res, async (me, req) => {
      const body = await parseJsonBody(req, ctx.config.maxBodyBytes);
      const group = groups.update(Number(params.id), body, { actor: me.username });
      cache.invalidate();
      return { result: group };
    }),
  );

  router.delete('/admin/api/groups/:id', (req, res, params) =>
    api(req, res, (me) => ({ result: groups.remove(Number(params.id), { actor: me.username }) })),
  );

  /**
   * 分组维度的点击趋势：一次查出所有分组的每日点击，
   * 前端不用为每个分组各发一次请求。
   */
  router.get('/admin/api/groups/trend', (req, res) =>
    api(req, res, () => {
      const days = Math.min(90, Math.max(7, Number(new URL(req.url, 'http://x').searchParams.get('days')) || 14));
      const since = dateKey(new Date(Date.now() - (days - 1) * 86400000));
      const raw = store.db
        .prepare(`SELECT COALESCE(l.group_id, 0) AS gid, d.day AS day, SUM(d.clicks) AS clicks
          FROM click_daily d JOIN links l ON l.code = d.code
          WHERE d.day >= ? AND l.deleted_at IS NULL
          GROUP BY gid, d.day`)
        .all(since);

      const byGroup = new Map();
      for (const row of raw) {
        if (!byGroup.has(row.gid)) byGroup.set(row.gid, new Map());
        byGroup.get(row.gid).set(row.day, row.clicks);
      }
      const dayKeys = [];
      for (let i = days - 1; i >= 0; i -= 1) dayKeys.push(dateKey(new Date(Date.now() - i * 86400000)));

      const groups = store.listGroupsWithCounts().map((g) => {
        const series = byGroup.get(g.id) || new Map();
        return {
          id: g.id,
          name: g.name,
          color: g.color,
          links: g.links,
          clicks: g.clicks,
          daily: dayKeys.map((day) => ({ day, clicks: series.get(day) || 0 })),
        };
      });
      const ungroupedSeries = byGroup.get(0) || new Map();
      const ungroupedDaily = dayKeys.map((day) => ({ day, clicks: ungroupedSeries.get(day) || 0 }));
      const total = dayKeys.map((day) => ({
        day,
        clicks: groups.reduce((s, g) => s + (g.daily.find((d) => d.day === day)?.clicks || 0), 0)
          + (ungroupedSeries.get(day) || 0),
      }));
      // 层叠图缺一段就会在中间断一截，所以把「已删除分组里还剩的点击」单独成项：
      // 只有归到某个分组才会计入条形高度，但不该因为删了分组就让总量凭空少一块
      const known = new Set([...groups.map((g) => g.id), 0]);
      const orphanSeries = new Map();
      for (const [gid, series] of byGroup) {
        if (known.has(gid)) continue;
        for (const [day, clicks] of series) orphanSeries.set(day, (orphanSeries.get(day) || 0) + clicks);
      }
      const orphanDaily = dayKeys.map((day) => ({ day, clicks: orphanSeries.get(day) || 0 }));
      return {
        result: {
          days,
          daily: dayKeys,
          groups,
          ungrouped: { name: '未分组', daily: ungroupedDaily },
          total,
          ...(orphanSeries.size ? { orphanGroup: { name: '已删除分组', daily: orphanDaily } } : {}),
        },
      };
    }),
  );

  // 单条详情。列表接口只给一页，而这几个写入之后前端手里需要最新的一份
  router.get('/admin/api/links/:code', (req, res, params) =>
    api(req, res, (me, req) => {
      const row = store.findLinkByCode(params.code);
      if (!row) throw new HttpError(404, '短链不存在', 'link_not_found');
      return { result: serialize(ctx, req, row) };
    }),
  );

  router.get('/admin/api/links/:code/stats', (req, res, params) =>
    api(req, res, () => {
      const row = store.findLinkByCode(params.code);
      if (!row) throw new HttpError(404, '短链不存在', 'link_not_found');
      return { result: statsFor(store, row, 30) };
    }),
  );

  // ---------- 分流目标 ----------
  router.get('/admin/api/links/:code/targets', (req, res, params) =>
    api(req, res, () => {
      const row = store.findLinkByCode(params.code);
      if (!row) throw new HttpError(404, '短链不存在', 'link_not_found');
      return { result: { url: row.url, targets: ctx.targets.list(row.id) } };
    }),
  );

  /**
   * 整组提交分流目标。语义是「提交后就是这样」，不是追加：
   * 管理台里删掉一行就该真的删掉，不该还需要调一次 DELETE。
   */
  router.put('/admin/api/links/:code/targets', (req, res, params) =>
    api(req, res, async (me, req) => {
      const row = store.findLinkByCode(params.code);
      if (!row) throw new HttpError(404, '短链不存在', 'link_not_found');
      const body = await parseJsonBody(req, ctx.config.maxBodyBytes);
      ctx.history?.record(row.id, { action: 'targets', actor: me.username });
      const out = ctx.targets.replace(row.id, body.targets);
      cache.invalidate(row.code);
      links.audit(me.username, 'link.targets', `${row.code}:${out.targets.length}`);
      return { result: { targets: out.targets, removed: out.removed } };
    }),
  );

  // ---------- 变更历史 ----------
  router.get('/admin/api/links/:code/history', (req, res, params) =>
    api(req, res, () => {
      const row = store.findLinkByCode(params.code) || store.findLinkByCode(params.code, { includeDeleted: true });
      if (!row) throw new HttpError(404, '短链不存在', 'link_not_found');
      const q = new URL(req.url, 'http://x').searchParams;
      const page = Math.max(1, Number(q.get('page')) || 1);
      const perPage = Math.min(100, Math.max(1, Number(q.get('perPage')) || 20));
      return { result: { code: row.code, ...ctx.history.list(row.id, { page, perPage }) } };
    }),
  );

  /**
   * 两版对比。`to` 传 0（或不传）表示和当前状态比——
   * 「我刚才是不是改坏了」的参照物通常是现在。
   */
  router.get('/admin/api/links/:code/history/diff', (req, res, params) =>
    api(req, res, () => {
      const row = store.findLinkByCode(params.code) || store.findLinkByCode(params.code, { includeDeleted: true });
      if (!row) throw new HttpError(404, '短链不存在', 'link_not_found');
      const q = new URL(req.url, 'http://x').searchParams;
      const from = Number(q.get('from'));
      const to = Number(q.get('to') || 0);
      if (!Number.isFinite(from) || from <= 0) throw new HttpError(400, '请指定要对比的版本', 'from_required');
      return { result: { code: row.code, from, to, ...ctx.history.diff(row.id, from, to) } };
    }),
  );

  /**
   * 回滚到指定版本。
   *
   * 回滚不删历史——它本身就是新的一版，所以「回滚错了」可以再回滚回来。
   */
  router.post('/admin/api/links/:code/history/:id/rollback', (req, res, params) =>
    api(req, res, (me) => {
      const row = store.findLinkByCode(params.code) || store.findLinkByCode(params.code, { includeDeleted: true });
      if (!row) throw new HttpError(404, '短链不存在', 'link_not_found');
      const link = ctx.history.rollback(row.id, Number(params.id), { actor: me.username });
      cache.invalidate(row.code);
      links.audit(me.username, 'link.rollback', `${row.code}#${params.id}`);
      return { result: serialize(ctx, req, link) };
    }),
  );

  router.post('/admin/api/links/:code/password', (req, res, params) =>
    api(req, res, async (me, req) => {
      const row = store.findLinkByCode(params.code);
      if (!row) throw new HttpError(404, '短链不存在', 'link_not_found');
      const body = await parseJsonBody(req, ctx.config.maxBodyBytes);
      const updated = links.setPassword(row.id, body.password ?? '', { actor: me.username });
      cache.invalidate(row.code);
      return { result: { protected: Boolean(updated.protected) } };
    }),
  );

  router.post('/admin/api/links/:code/title', (req, res, params) =>
    api(req, res, async (me) => {
      const row = store.findLinkByCode(params.code);
      if (!row) throw new HttpError(404, '短链不存在', 'link_not_found');
      const title = await ctx.titles.fetch(row.url, { timeout: settings.get('titleTimeout') });
      if (!title) throw new HttpError(422, '未能抓取到标题，请手动填写', 'title_unavailable');
      ctx.history?.record(row.id, { action: 'title', actor: me.username });
      store.sql.updateLink.run(row.url, title, row.note, row.tags, row.status, row.expire_at, Date.now(), row.id);
      cache.invalidate(row.code);
      return { result: { title } };
    }),
  );

  // 手动触发过期回收，方便管理员立刻看到效果而不用等 30s 的心跳
  router.post('/admin/api/links/sweep', (req, res) =>
    api(req, res, (me) => {
      const out = ctx.maintenance?.sweepExpired?.() || { archived: 0, removed: 0 };
      links.audit(me.username, 'link.expire_sweep', `manual:${out.archived + out.removed}`);
      return { result: out };
    }),
  );

  // 全站来源分析：referrer 域名 + 平台分布 + 每日总量
  router.get('/admin/api/sources', (req, res) =>
    api(req, res, () => {
      const q = new URL(req.url, 'http://x').searchParams;
      const days = Math.min(365, Math.max(1, Number(q.get('days')) || 30));
      const stats = overviewStats(store, days);
      // 总数用 links.clicks：refs 只统计上报了 referrer 的点击
      const totalClicks = store.sql.sumClicks.get().n;
      // 空 host 是「浏览器没上报 referrer」的直接访问，单独给一个数。
      // 它混在站点榜里既没法点也没法比，而往往又是最大的一块
      const allRefs = store.sql.globalRefs.all(30);
      // 空 host 是直接访问，会排进榜单里；这里按每一行自己的意思拆开，
      // 而不是去读全局最高的那一行——两者在多站点时分母不同，硬减会算出负数
      const refs = [];
      let direct = 0;
      for (const row of allRefs) {
        if (row.host) refs.push(row);
        else direct = Number(row.clicks) || 0;
      }
      const agents = store.sql.globalAgents.all(12);
      const countries = store.sql.globalCountries.all(20);
      const attributed = refs.reduce((s, r) => s + r.clicks, 0);
      return {
        result: {
          days,
          daily: stats.daily,
          refs,
          agents,
          countries,
          known: attributed,
          direct,
          unknown: Math.max(0, totalClicks - attributed),
          totalClicks,
          hours: store.hourMatrix(store.sql.globalSlots.all()),
        },
      };
    }),
  );

  /**
   * 渠道漏斗：建页被看了多少、点了多少。
   *
   * 和来源分析分开一个接口：那边回答「谁来过」，这边回答「谁看了却没进来」。
   * 这两个问题在投放复盘里是一前一后，但混在一页会让人误以为它们是同一件事。
   */
  router.get('/admin/api/funnel', (req, res) =>
    api(req, res, () => {
      const q = new URL(req.url, 'http://x').searchParams;
      const code = String(q.get('code') || '').trim();
      const link = code ? store.findLinkByCode(code) : null;
      const rows = funnelRows(store, { code: link ? link.code : '', limit: 30 });
      const summary = code
        ? (() => {
            const views = rows.reduce((s, r) => s + r.views, 0);
            const clicks = rows.reduce((s, r) => s + r.clicks, 0);
            return { views, clicks, rate: views ? clicks / views : null };
          })()
        : funnelSummary(store);
      return { result: { code: link ? link.code : null, summary, rows } };
    }),
  );

  /** 举报队列：列表 + 处理结论。举报只报告，不自动停链 */
  router.get('/admin/api/reports', (req, res) =>
    api(req, res, () => {
      const q = new URL(req.url, 'http://x').searchParams;
      const out = ctx.reports.list({
        page: q.get('page'),
        perPage: q.get('perPage'),
        status: String(q.get('status') || ''),
      });
      return {
        result: {
          ...out,
          // IP 是举报人的，界面里只留网段，够定位来源就够了
          items: out.items.map((r) => ({ ...r, ip: maskIp(r.ip) })),
        },
      };
    }),
  );

  router.post('/admin/api/reports/:id', (req, res, params) =>
    api(req, res, async (me, req) => {
      const body = await parseJsonBody(req, ctx.config.maxBodyBytes);
      const row = ctx.reports.handle(Number(params.id), { status: body.status, actor: me.username });
      if (!row) throw new HttpError(404, '举报记录不存在', 'report_not_found');
      links.audit(me.username, 'report.handle', `#${row.id} ${row.code} ${row.status}`);
      return { result: { id: row.id, status: row.status } };
    }),
  );

  router.delete('/admin/api/reports/:id', (req, res, params) =>
    api(req, res, (me) => {
      const removed = store.db.prepare('DELETE FROM reports WHERE id = ?').run(Number(params.id)).changes || 0;
      links.audit(me.username, 'report.delete', `#${params.id}`);
      return { result: { removed } };
    }),
  );

  /**
   * 访问时段热力图：星期 × 小时。
   *
   * 数据是累计的，没有「最近 N 天」这个维度——click_slots 不存日期，
   * 存了就是每天 168 行 × N 天的膨胀，而这个问题的答案不需要那么细。
   * 界面上要如实写「累计」，不能含含糊糊画一个像「近 30 天」的图。
   */
  router.get('/admin/api/hours', (req, res) =>
    api(req, res, () => {
      const q = new URL(req.url, 'http://x').searchParams;
      const code = String(q.get('code') || '').trim();
      const rows = code ? store.sql.linkSlots.all(store.findLinkByCode(code)?.code || code) : store.sql.globalSlots.all();
      return { result: { code: code || null, ...store.hourMatrix(rows) } };
    }),
  );

  /**
   * 分组 × 时段。
   *
   * 中间这层原来缺着：全站和单链都有热力图，但「某个分组的人什么时候活跃」
   * 只能靠人肉对着两张图心算。这里按分组给出 7×24 矩阵，未分组单独一格。
   */
  router.get('/admin/api/groups/hours', (req, res) =>
    api(req, res, () => {
      const byGid = new Map(store.groupHours().map((row) => [row.gid ?? 0, row]));
      const meta = new Map(groups.list().items.map((g) => [Number(g.id), g]));
      const items = [];
      for (const [gid, row] of byGid) {
        if (gid && !meta.has(gid)) continue; // 分组已被删掉，数据等着被清理，不展示
        const info = gid ? meta.get(gid) : null;
        items.push({
          id: gid || null,
          name: info ? info.name : '未分组',
          color: info ? info.color : '',
          links: info ? info.links : store.countUngrouped(),
          cells: row.cells,
          peak: row.peak,
          total: row.total,
        });
      }
      for (const [gid, g] of meta) {
        if (byGid.has(gid)) continue;
        items.push({ id: gid, name: g.name, color: g.color, links: g.links, cells: new Array(168).fill(0), peak: 0, total: 0 });
      }
      if (!byGid.has(0) && !items.some((i) => i.id === null) && store.countUngrouped() > 0) {
        items.push({ id: null, name: '未分组', color: '', links: store.countUngrouped(), cells: new Array(168).fill(0), peak: 0, total: 0 });
      }
      // 点击数降序：先看热的，冷的沉到底下
      items.sort((a, b) => b.total - a.total || String(a.name).localeCompare(String(b.name)));
      return { result: { items } };
    }),
  );

  router.get('/admin/api/settings', (req, res) =>
    api(req, res, () => ({
      result: {
        values: settings.all(),
        meta: { dataDir: ctx.config.dataDir, version: ctx.version, hostname: ctx.config.hostname },
      },
    })),
  );

  router.patch('/admin/api/settings', (req, res) =>
    api(req, res, async (me, req) => {
      const body = await parseJsonBody(req, ctx.config.maxBodyBytes);
      const { applied, rejected } = settings.update(body);
      if (applied.rateLimitPerMinute) ctx.limiter.configure(applied.rateLimitPerMinute);
      if (applied.createRateLimitPerMinute) ctx.createLimiter.configure(applied.createRateLimitPerMinute);
      cache.invalidate();
      links.audit(me.username, 'settings.update', Object.keys(applied).join(','));
      return { result: settings.all(), applied, rejected };
    }),
  );

  router.get('/admin/api/keys', (req, res) =>
    api(req, res, () => ({ result: store.sql.listKeys.all() })),
  );

  router.post('/admin/api/keys', (req, res) =>
    api(req, res, async (me, req) => {
      const body = await parseJsonBody(req, ctx.config.maxBodyBytes);
      const scope = body.scope === 'read' ? 'read' : 'read,write';
      const key = auth.createKey(body.name || 'default', scope);
      links.audit(me.username, 'key.create', key.prefix);
      return { result: key };
    }),
  );

  router.delete('/admin/api/keys/:id', (req, res, params) =>
    api(req, res, (me) => {
      store.sql.deleteKey.run(Number(params.id));
      links.audit(me.username, 'key.delete', params.id);
      return { deleted: Number(params.id) };
    }),
  );

  router.patch('/admin/api/keys/:id', (req, res, params) =>
    api(req, res, async (me, req) => {
      const body = await parseJsonBody(req, ctx.config.maxBodyBytes);
      store.sql.toggleKey.run(body.enabled ? 1 : 0, Number(params.id));
      return { result: { id: Number(params.id), enabled: Boolean(body.enabled) } };
    }),
  );

  router.get('/admin/api/rules', (req, res) =>
    api(req, res, () => ({ result: { items: store.sql.listRules.all(), ...ctx.uaFilter.summary() } })),
  );

  router.post('/admin/api/rules', (req, res) =>
    api(req, res, async (me, req) => {
      const body = await parseJsonBody(req, ctx.config.maxBodyBytes);
      const pattern = String(body.pattern || '').trim();
      const kind = body.kind === 'ip' ? 'ip' : 'ua';
      try {
        compileRule(pattern);
      } catch (err) {
        throw new HttpError(400, `规则不合法：${err.message}`, 'rule_invalid');
      }
      store.sql.insertRule.run(kind, pattern, String(body.note || '').slice(0, 120), body.enabled === false ? 0 : 1, Date.now());
      ctx.uaFilter.reload();
      links.audit(me.username, 'rule.create', `${kind}:${pattern}`);
      return { result: store.sql.listRules.all() };
    }),
  );

  router.delete('/admin/api/rules/:id', (req, res, params) =>
    api(req, res, (me) => {
      store.sql.deleteRule.run(Number(params.id));
      ctx.uaFilter.reload();
      links.audit(me.username, 'rule.delete', params.id);
      return { deleted: Number(params.id) };
    }),
  );

  router.patch('/admin/api/rules/:id', (req, res, params) =>
    api(req, res, async (me, req) => {
      const body = await parseJsonBody(req, ctx.config.maxBodyBytes);
      store.sql.toggleRule.run(body.enabled ? 1 : 0, Number(params.id));
      ctx.uaFilter.reload();
      return { result: store.sql.listRules.all() };
    }),
  );

  // ---------- 迁移 ----------
  router.post('/admin/api/migrate/preview', (req, res) =>
    api(req, res, async (me, req) => {
      const body = await parseJsonBody(req, Math.max(ctx.config.maxBodyBytes, 64 * 1024 * 1024));
      const content = String(body.content || '');
      if (!content) throw new HttpError(400, '请上传或粘贴要迁移的数据', 'empty_payload');
      const format = body.format && body.format !== 'auto' ? body.format : detectFormat(content, body.filename || '');
      if (format === 'unknown') throw new HttpError(400, '无法识别文件格式，请提供 YOURLS 的 .sql 导出或 HighURL 的 .json 导出', 'unknown_format');
      let parsed;
      try {
        parsed = parseByFormat(format, content);
      } catch (err) {
        throw new HttpError(400, err.message, 'parse_failed');
      }
      const plan = planImport(store, parsed, { overwrite: Boolean(body.overwrite) });
      return {
        result: {
          format,
          parsed: parsed.links.length,
          willImport: plan.import.length,
          conflicts: plan.conflict.length,
          invalid: plan.invalid.length,
          samples: plan.import.slice(0, 10),
          conflictSamples: plan.conflict.slice(0, 10),
          invalidSamples: plan.invalid.slice(0, 10),
        },
      };
    }),
  );

  router.post('/admin/api/migrate/apply', (req, res) =>
    api(req, res, async (me, req) => {
      const body = await parseJsonBody(req, Math.max(ctx.config.maxBodyBytes, 64 * 1024 * 1024));
      const content = String(body.content || '');
      if (!content) throw new HttpError(400, '请上传或粘贴要迁移的数据', 'empty_payload');
      const format = body.format && body.format !== 'auto' ? body.format : detectFormat(content, body.filename || '');
      if (format === 'unknown') throw new HttpError(400, '无法识别文件格式', 'unknown_format');
      const parsed = parseByFormat(format, content);
      const plan = planImport(store, parsed, { overwrite: Boolean(body.overwrite) });
      const stats = applyImport(store, plan);
      cache.invalidate();
      links.audit(me.username, 'migrate.apply', `${format}:${stats.created}+${stats.updated}`);
      return { result: { ...stats, conflicts: plan.conflict.length, invalid: plan.invalid.length } };
    }),
  );

  // ---------- 备份 / 恢复 ----------
  router.get('/admin/api/backup', (req, res) => {
    requireSession(req);
    // 带上 manifest（校验和、来源机器、程序版本）：恢复前才有东西可核对
    const payload = Buffer.from(JSON.stringify(buildBackup(store, { hostname: ctx.config.hostname }), null, 2));
    const day = dateKey();
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="highurl-${day}.json"`,
      'Content-Length': payload.length,
      'Cache-Control': 'no-store',
    });
    res.end(payload);
  });

  // 自动备份列表：文件在不在、坏没坏，一并给出
  router.get('/admin/api/backups', (req, res) =>
    api(req, res, () => ({
      result: {
        dir: ctx.config.backupDir,
        items: listBackups(ctx.config.backupDir),
        retention: KEEP_AUTO_BACKUPS,
      },
    })),
  );

  // 下载某一份自动备份。文件名走白名单，不允许拼路径跳出去
  router.get('/admin/api/backups/:name', (req, res, params) => {
    requireSession(req);
    const file = backupPath(ctx.config.backupDir, params.name);
    if (!file) throw new HttpError(404, '备份文件不存在', 'backup_not_found');
    const payload = fs.readFileSync(file);
    const type = file.endsWith('.gz') ? 'application/gzip' : 'application/json; charset=utf-8';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Disposition': `attachment; filename="${path.basename(file)}"`,
      'Content-Length': payload.length,
      'Cache-Control': 'no-store',
    });
    res.end(payload);
  });

  // 现场复核某一份自动备份的校验和。列表里的状态来自缓存，这里是「现在、真的」再算一次
  router.get('/admin/api/backups/:name/verify', (req, res, params) =>
    api(req, res, () => {
      const file = backupPath(ctx.config.backupDir, params.name);
      if (!file) throw new HttpError(404, '备份文件不存在', 'backup_not_found');
      if (file.endsWith('.gz')) return { result: { status: 'unchecked', reason: 'SQL 备份按 gzip 校验，不做内容级校验' } };
      const v = verifyBackup(fs.readFileSync(file, 'utf8'));
      return { result: { status: v.status, reason: v.reason, actual: v.actual, expected: v.expected, counts: v.counts } };
    }),
  );

  router.get('/admin/api/backup/sql', (req, res) => {
    requireSession(req);
    const raw = Buffer.from(dumpSql(store));
    const gz = zlib.gzipSync(raw, { level: 9 });
    const day = dateKey();
    res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="highurl-${day}.sql.gz"`,
      'Content-Length': gz.length,
      'Cache-Control': 'no-store',
    });
    res.end(gz);
  });

  router.get('/admin/api/export.csv', (req, res) => {
    requireSession(req);
    const rows = store.db
      .prepare(`SELECT code, url, title,
          (SELECT name FROM groups WHERE groups.id = links.group_id) AS group_name,
          tags, note, status, clicks, created_at, last_click_at, expire_at
        FROM links WHERE deleted_at IS NULL ORDER BY id`)
      .all();
    // 表头保持 group（对外格式不变，已有脚本按列名取），但值必须从 group_name 取。
    // 以前的写法是 `header.map(k => r[k])`，而 SQL 里那一列叫 group_name，
    // 于是 r['group'] 恒为 undefined：列在、值没了，比整列缺失更难发现
    const columns = [
      ['code', 'code'], ['url', 'url'], ['title', 'title'], ['group', 'group_name'],
      ['tags', 'tags'], ['note', 'note'], ['status', 'status'], ['clicks', 'clicks'],
      ['created_at', 'created_at'], ['last_click_at', 'last_click_at'], ['expire_at', 'expire_at'],
    ];
    const csv = [columns.map(([head]) => head).join(',')]
      .concat(rows.map((r) => columns.map(([, key]) => csvCell(r[key])).join(',')))
      .join('\n');
    const payload = Buffer.from(`\uFEFF${csv}`);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="highurl-${dateKey()}.csv"`,
      'Content-Length': payload.length,
    });
    res.end(payload);
  });

  // 恢复前预检：先把「这份备份会变成什么」算出来，再决定要不要动数据
  router.post('/admin/api/restore/preview', (req, res) =>
    api(req, res, async (me, req) => {
      const body = await parseJsonBody(req, Math.max(ctx.config.maxBodyBytes, 128 * 1024 * 1024));
      const content = String(body.content || '');
      if (!content) throw new HttpError(400, '备份内容为空', 'empty_payload');
      return { result: inspectBackup(content, store) };
    }),
  );

  /**
   * 恢复。与命令行走同一套 services/restore.js——
   * 两边各写一遍的结果是：管理台漏恢复分组，CLI 漏恢复分流目标。
   */
  router.post('/admin/api/restore', (req, res) =>
    api(req, res, async (me, req) => {
      const body = await parseJsonBody(req, Math.max(ctx.config.maxBodyBytes, 128 * 1024 * 1024));
      const content = String(body.content || '');
      if (!content) throw new HttpError(400, '备份内容为空', 'empty_payload');
      const mode = body.mode === 'replace' ? 'replace' : 'merge';
      const out = restoreBackup(store, content, {
        mode,
        withSettings: Boolean(body.withSettings),
        force: Boolean(body.force),
      });
      cache.invalidate();
      if (out.settings) settings.reload();
      ctx.uaFilter.reload();
      links.audit(me.username, 'restore', `${mode}:${out.restored}`);
      return { result: out };
    }),
  );

  /** 从查询串里取二维码样式参数，非法值一律回落默认，不让样式参数变成 500 的来源 */
  const styleFromQuery = (q) => resolveStyle({
    preset: q.get('preset') || '',
    dotStyle: q.get('dot') || '',
    dark: q.get('dark') || '',
    light: q.get('light') || '',
    gradient: q.get('gradient') || '',
    ecc: q.get('ecc') || '',
  });

  router.get('/admin/api/qr/presets', (req, res) => {
    requireSession(req);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, max-age=600' });
    res.end(JSON.stringify({ ok: true, result: QR_PRESETS }));
  });

  router.get('/admin/api/qr.svg', (req, res) => {
    requireSession(req);
    const q = new URL(req.url, 'http://x').searchParams;
    const text = q.get('text') || '';
    if (!text) throw new HttpError(400, '缺少 text 参数', 'text_required');
    const style = styleFromQuery(q);
    const svg = qrSvg(text, { margin: 2, dark: '#0f172a', light: '#ffffff', ...style });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'private, max-age=300' });
    res.end(svg);
  });

  // 位图二维码：服务端直接出 PNG，批量打包与管理台下载都用它
  router.get('/admin/api/qr.png', (req, res) => {
    requireSession(req);
    const q = new URL(req.url, 'http://x').searchParams;
    const text = q.get('text') || '';
    if (!text) throw new HttpError(400, '缺少 text 参数', 'text_required');
    const scale = Math.min(24, Math.max(2, Number(q.get('scale')) || 8));
    const { png } = qrPng(text, { scale, ...styleFromQuery(q) });
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': png.length,
      'Cache-Control': 'private, max-age=300',
    });
    res.end(png);
  });

  /**
   * 批量二维码打包成 ZIP：印物料时一次拿全套，不用逐条点下载。
   * 支持显式 codes（勾选）与按筛选条件取全量，单次上限 1000 条。
   */
  router.get('/admin/api/qr.zip', (req, res) => {
    const me = requireSession(req);
    const q = new URL(req.url, 'http://x').searchParams;
    const codes = String(q.get('codes') || '').split(',').map((c) => c.trim()).filter(Boolean);
    const scope = q.get('scope') || (codes.length ? 'codes' : 'filter');
    const LIMIT = 1000;

    let rows = [];
    if (scope === 'codes') {
      if (!codes.length) throw new HttpError(400, '请先选择要导出的短链', 'empty_selection');
      if (codes.length > LIMIT) throw new HttpError(400, `单次最多导出 ${LIMIT} 条`, 'too_many');
      rows = codes.map((code) => store.findLinkByCode(code)).filter(Boolean);
    } else {
      const listed = store.listLinks({
        q: q.get('q') || '',
        status: q.get('status') || '',
        tag: q.get('tag') || '',
        group: q.get('group') || '',
        health: q.get('health') || '',
        sort: q.get('sort') || 'created_desc',
        page: 1,
        perPage: LIMIT,
      });
      rows = listed.rows;
    }
    if (!rows.length) throw new HttpError(404, '没有可导出的短链', 'nothing_to_export');

    // 批量导出也吃样式参数：上一版只有单条能选样式，印一批物料时还得一张张下
    const style = styleFromQuery(q);
    const entries = [];
    const index = ['code,short_url,target_url,title'];
    for (const row of rows) {
      const url = shortUrl(ctx, row.code, req);
      const { png } = qrPng(url, { scale: 10, ...style });
      entries.push({ name: `qr/${row.code}.png`, data: png });
      index.push([row.code, url, row.url, row.title || ''].map(csvCell).join(','));
    }
    // 附一份对照表，扫码前先能肉眼确认哪张图是哪条
    entries.push({ name: 'codes.csv', data: Buffer.from(`\uFEFF${index.join('\n')}\n`) });
    const zip = zipStore(entries);
    links.audit(me.username, 'link.qr_export', `${rows.length} 条`);

    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="highurl-qr-${dateKey()}.zip"`,
      'Content-Length': zip.length,
      'Cache-Control': 'no-store',
    });
    res.end(zip);
  });

  /**
   * 二维码 A4 拼版 PDF：给「印一批物料」这件事收尾。
   * 上一轮只能拿到一堆 PNG，还得自己拖进排版软件里拼页；
   * 这里直接给出按行列排好、带裁切线的可打印 PDF。
   */
  router.get('/admin/api/qr.pdf', (req, res) => {
    const me = requireSession(req);
    const q = new URL(req.url, 'http://x').searchParams;
    const codes = String(q.get('codes') || '').split(',').map((c) => c.trim()).filter(Boolean);
    const scope = q.get('scope') || (codes.length ? 'codes' : 'filter');
    const LIMIT = 500;

    let rows = [];
    if (scope === 'codes') {
      if (!codes.length) throw new HttpError(400, '请先选择要导出的短链', 'empty_selection');
      if (codes.length > LIMIT) throw new HttpError(400, `单次最多排版 ${LIMIT} 条`, 'too_many');
      rows = codes.map((code) => store.findLinkByCode(code)).filter(Boolean);
    } else {
      rows = store.listLinks({
        q: q.get('q') || '',
        status: q.get('status') || '',
        tag: q.get('tag') || '',
        group: q.get('group') || '',
        health: q.get('health') || '',
        sort: q.get('sort') || 'created_desc',
        page: 1,
        perPage: LIMIT,
      }).rows;
    }
    if (!rows.length) throw new HttpError(404, '没有可排版的短链', 'nothing_to_export');

    const pdf = buildQrSheetPdf(
      rows.map((row) => ({
        code: row.code,
        shortUrl: shortUrl(ctx, row.code, req),
        title: row.title,
        url: row.url,
      })),
      {
        paper: q.get('paper') || 'a4',
        cols: q.get('cols') || 0,
        siteName: settings.get('siteName'),
        showTitle: q.get('title') !== '0',
        showCutLines: q.get('cut') !== '0',
        style: sheetStyleFromQuery((k) => q.get(k)),
      },
    );
    links.audit(me.username, 'link.qr_sheet', `${rows.length} 条`);

    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="highurl-qr-${dateKey()}.pdf"`,
      'Content-Length': pdf.length,
      'Cache-Control': 'no-store',
    });
    res.end(pdf);
  });

    /**
   * 统计一致性自检：短链被彻底删除后，click_* 三张表里可能留下孤儿行
   * （历史版本没有级联清理）。这里只报告不擅自修改，清理交给下面的 collect 接口。
   */
  router.get('/admin/api/doctor', (req, res) =>
    api(req, res, () => {
      const orphans = (table) =>
        store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE code NOT IN (SELECT code FROM links)`).get().n;
      const daily = orphans('click_daily');
      const refs = orphans('click_refs');
      const agents = orphans('click_agents');
      const countries = orphans('click_countries');
      const slots = orphans('click_slots');
      const history = orphans('link_history');
      const landing = orphans('landing_views');
      const targetOrphans = store.db
        .prepare('SELECT COUNT(*) AS n FROM link_targets WHERE link_id NOT IN (SELECT id FROM links)').get().n;
      // 点击数被拆成两份是 v1.2 之前的短码大小写问题，这里一并查出来
      const dupCodes = store.db
        .prepare('SELECT code FROM links GROUP BY code COLLATE NOCASE HAVING COUNT(*) > 1')
        .all().length;
      const schemaVersion = Number(store.db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get()?.value || 0);
      return {
        result: {
          orphans: { daily, refs, agents, countries, slots, history, landing, targets: targetOrphans, total: daily + refs + agents + countries + slots + history + landing + targetOrphans },
          duplicateCodes: dupCodes,
          schemaVersion,
          counters: counter.stats(),
          cache: cache.stats(),
          dedupe: ctx.deduper?.stats?.() || null,
        },
      };
    }),
  );

  /** 清掉孤儿统计行。只影响已经不存在的短码，不会碰任何现存数据 */
  router.post('/admin/api/doctor/collect', (req, res) =>
    api(req, res, (me) => {
      let removed = 0;
      store.tx(() => {
        removed += store.sql.purgeOrphanDaily.run().changes || 0;
        removed += store.sql.purgeOrphanRefs.run().changes || 0;
        removed += store.sql.purgeOrphanAgents.run().changes || 0;
        removed += store.sql.purgeOrphanCountries.run().changes || 0;
        removed += store.sql.purgeOrphanSlots.run().changes || 0;
        removed += store.sql.purgeOrphanHistory.run().changes || 0;
        removed += store.sql.purgeOrphanLanding.run().changes || 0;
        removed += store.sql.purgeOrphanTargets.run().changes || 0;
      });
      if (removed) links.audit(me.username, 'stats.collect_orphans', `${removed} 行`);
      return { result: { removed } };
    }),
  );

  // ---------- 实时访问流 ----------
  /**
   * SSE 推送。管理台的实时面板挂在这上面。
   * 注意这是长连接：不能走 api() 包装（它会 sendJson 然后结束响应）。
   */
  router.get('/admin/api/stream', (req, res) => {
    requireSession(req);
    const stream = ctx.stream;
    if (!stream) throw new HttpError(503, '实时流未启用', 'stream_disabled');
    stream.attach(res);
  });

  /** 一次性取最近访问，SSE 被代理挡住时前端可以退化成轮询这个接口 */
  router.get('/admin/api/stream/recent', (req, res) =>
    api(req, res, (me, req) => {
      const n = Math.min(100, Math.max(1, Number(new URL(req.url, 'http://x').searchParams.get('limit')) || 20));
      return { result: { items: ctx.stream?.recent(n) || [], stats: ctx.stream?.stats() || null } };
    }),
  );

  // ---------- 目标链接健康 ----------
  router.get('/admin/api/health', (req, res) =>
    api(req, res, () => ({
      result: {
        ...(ctx.health?.summary?.() || { counts: { ok: 0, warn: 0, dead: 0, unknown: 0 }, total: 0, broken: [] }),
        intervalMin: settings.get('healthCheckIntervalMin') || 0,
        timeout: settings.get('healthCheckTimeout') || 8000,
      },
    })),
  );

  /**
   * 立刻跑一轮巡检。默认只测「最久没测过」的一批，
   * 传 codes 就只测点名的那几条（行内「检测」按钮走这条）。
   */
  router.post('/admin/api/health/check', (req, res) =>
    api(req, res, async (me, req) => {
      if (!ctx.health) throw new HttpError(503, '巡检未启用', 'health_disabled');
      const body = await parseJsonBody(req, ctx.config.maxBodyBytes).catch(() => ({}));
      const codes = Array.isArray(body.codes) ? body.codes.map((c) => String(c)).filter(Boolean).slice(0, 200) : null;
      const limit = Math.min(1000, Math.max(1, Number(body.limit) || 200));
      const timeout = Number(settings.get('healthCheckTimeout')) || 8000;
      const out = await ctx.health.run({ limit, timeout, only: codes });
      if (!codes) links.audit(me.username, 'link.health_check', `manual:${out.checked}`);
      return { result: out };
    }),
  );

  router.get('/admin/api/audit', (req, res) =>
    api(req, res, () => {
      const q = new URL(req.url, 'http://x').searchParams;
      const page = Math.max(1, Number(q.get('page')) || 1);
      const perPage = Math.min(200, Math.max(1, Number(q.get('perPage')) || 50));
      const filter = String(q.get('filter') || '').trim();
      const like = filter ? `${filter}%` : '%';
      const total = store.sql.countAuditByAction.get(like).n;
      const rows = store.sql.listAuditByAction.all(like, perPage, (page - 1) * perPage);
      return {
        result: {
          items: rows,
          total,
          page,
          perPage,
          pages: Math.max(1, Math.ceil(total / perPage)),
          actions: store.db.prepare('SELECT action, COUNT(*) AS n FROM audit_log GROUP BY action ORDER BY n DESC').all(),
        },
      };
    }),
  );

  router.post('/admin/api/password', (req, res) =>
    api(req, res, async (me, req) => {
      const body = await parseJsonBody(req, ctx.config.maxBodyBytes);
      auth.changePassword(me.id, body.oldPassword, body.newPassword);
      return { result: true };
    }),
  );

  router.post('/admin/api/flush', (req, res) =>
    api(req, res, async () => {
      const flushed = await counter.flush();
      ctx.uaFilter.flushHits();
      return { result: { flushed, ...counter.stats() } };
    }),
  );
}

/** 批量改标签：merge 追加去重、replace 覆盖、clear 清空 */
function mergeTags(current, input, mode) {
  if (mode === 'clear') return '';
  const incoming = normalizeTags(input);
  if (mode === 'replace') return incoming;
  const merged = [];
  for (const tag of String(current || '').split(',').concat(incoming.split(','))) {
    const t = tag.trim();
    if (t && !merged.includes(t)) merged.push(t);
    if (merged.length >= 10) break;
  }
  return merged.join(',');
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 生成标准 SQL dump，方便用 sqlite3 / 其它工具接管。
 *
 * 表名从 sqlite_master 里现取，不写死名单：原先是一张手写清单，
 * 加 groups 那版漏了它、加 click_slots 这版又会漏——而漏掉的表不会报错，
 * 只会让「整库备份」安静地少一类数据。要排除的表也只在需要时排除。
 */
export function dumpSql(store) {
  const skip = new Set(['sqlite_sequence']);
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY rowid")
    .all()
    .map((r) => r.name)
    .filter((name) => !skip.has(name) && !name.startsWith('sqlite_'));
  const out = ['-- HighURL SQL dump', `-- generated ${new Date().toISOString()}`, 'PRAGMA foreign_keys=OFF;', 'BEGIN TRANSACTION;'];
  for (const table of tables) {
    const schema = store.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(table);
    if (!schema?.sql) continue;
    out.push(`DROP TABLE IF EXISTS "${table}";`, `${schema.sql};`);
    const rows = store.db.prepare(`SELECT * FROM "${table}"`).all();
    for (const row of rows) {
      const keys = Object.keys(row);
      const values = keys.map((k) => sqlValue(row[k])).join(',');
      out.push(`INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${values});`);
    }
  }
  // 索引和触发器也一起带走：只 dump 表结构的话，恢复出来的库虽然能读，
  // 但短码 NOCASE 唯一索引、健康/分组索引全没了——「能跑」和「一样」是两件事
  const extras = store.db
    .prepare("SELECT sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY rowid")
    .all();
  for (const { sql } of extras) out.push(`${sql};`);
  out.push('COMMIT;');
  return out.join('\n');
}

function sqlValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}
