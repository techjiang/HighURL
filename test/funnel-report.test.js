import test from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, cleanupTmp } from './helpers.js';
import { rateOf, funnelRows, funnelSummary } from '../src/services/funnel.js';
import { REASONS } from '../src/services/reports.js';
import { SCHEMA_VERSION } from '../src/lib/db.js';

test.after(() => cleanupTmp());

async function login(srv) {
  const res = await srv.fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'Passw0rd!23' }),
  });
  return String(res.headers.get('set-cookie') || '').split(';')[0];
}

async function adminJson(srv, cookie, pathname, init = {}) {
  const res = await srv.fetch(pathname, {
    ...init,
    headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(init.headers || {}) },
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { res, body, text };
}

async function withServer(fn) {
  const srv = await startTestServer({ titleFetch: false });
  await srv.ctx.auth.createAdmin('admin', 'Passw0rd!23');
  try {
    await fn(srv);
  } finally {
    await srv.stop();
  }
}

async function createLink(srv, cookie, body) {
  const out = await adminJson(srv, cookie, '/admin/api/links', {
    method: 'POST',
    body: JSON.stringify({ fetchTitle: false, ...body }),
  });
  assert.equal(out.res.status, 200, out.text);
  return out.body.result;
}

const form = (srv, path, data, headers = {}) =>
  srv.fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(data).toString(),
  });

test('rateOf：没有曝光返回 null，而不是 0', () => {
  assert.equal(rateOf(0, 5), null, '「没有曝光」和「一次都没点」是两件事');
  assert.equal(rateOf(10, 0), 0);
  assert.equal(rateOf(10, 4), 0.4);
});

test('schema 升到 v9，新表都在', () => {
  assert.equal(SCHEMA_VERSION, 9);
});

test('建页曝光单独计数，不污染点击数', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/f1', code: 'fn1', interstitial: true });

  await srv.fetch('/fn1', { headers: { Referer: 'https://weibo.com/post/1' } });
  await srv.fetch('/fn1', { headers: { Referer: 'https://weibo.com/post/2' } });
  await srv.ctx.counter.flush();

  const link = srv.ctx.store.findLinkByCode('fn1');
  assert.equal(link.clicks, 0, '看建页不算点击');

  const views = srv.ctx.store.db.prepare("SELECT SUM(views) AS n FROM landing_views WHERE code = 'fn1'").get().n;
  assert.equal(views, 2);

  // 点了继续访问才计一次点击
  const go = await srv.fetch('/fn1?go=1', { headers: { Referer: 'https://weibo.com/post/1' } });
  assert.equal(go.status, 302);
  await srv.ctx.counter.flush();

  const out = await adminJson(srv, cookie, '/admin/api/funnel?code=fn1');
  assert.equal(out.res.status, 200);
  assert.equal(out.body.result.summary.views, 2);
  assert.equal(out.body.result.summary.clicks >= 1, true);
  const row = out.body.result.rows.find((r) => r.host === 'weibo.com');
  assert.equal(row.views, 2);
  assert.ok(row.clicks >= 1);
}));

test('漏斗：只有曝光没有落地的渠道照样列出来，并被算进 dead', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/f2', code: 'fn2', interstitial: true });
  srv.ctx.store.sql.upsertLanding.run('fn2', '2026-01-01', 'news.example', 40);
  srv.ctx.store.sql.upsertRef.run('fn2', 'twitter.com', 7);

  const rows = funnelRows(srv.ctx.store, { code: 'fn2' });
  const dead = rows.find((r) => r.host === 'news.example');
  assert.equal(dead.views, 40);
  assert.equal(dead.clicks, 0);
  assert.equal(dead.rate, 0);

  const summary = funnelSummary(srv.ctx.store);
  assert.equal(summary.dead >= 1, true, '零落地渠道要能被一眼数出来');
}));

test('漏斗：回收站里的短链不计入', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/f3', code: 'fn3', interstitial: true });
  srv.ctx.store.sql.upsertLanding.run('fn3', '2026-01-01', 'x.com', 10);
  assert.equal(funnelSummary(srv.ctx.store).views, 10);

  await adminJson(srv, cookie, '/admin/api/links/fn3', { method: 'DELETE' });
  assert.equal(funnelSummary(srv.ctx.store).views, 0, '删掉的链的曝光不该还挂在图里');
}));

test('名片页举报：提交进队列，IP 脱敏后才给出', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/r1', code: 'rp1' });

  const res = await form(srv, '/rp1', { kind: 'report', reason: 'phishing', note: '页面在骗密码' });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /reported=1/);

  const list = await adminJson(srv, cookie, '/admin/api/reports');
  assert.equal(list.body.result.total, 1);
  const item = list.body.result.items[0];
  assert.equal(item.code, 'rp1');
  assert.equal(item.reason, 'phishing');
  assert.equal(item.note, '页面在骗密码');
  assert.equal(item.status, 'open');
  assert.ok(item.ip.includes('*'), 'IP 只给网段');
}));

test('举报：同 IP 同短链一天只收一条', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/r2', code: 'rp2' });

  await form(srv, '/rp2', { kind: 'report', reason: 'spam', note: 'first' });
  const second = await form(srv, '/rp2', { kind: 'report', reason: 'spam', note: 'second' });
  assert.equal(second.status, 303);

  const list = await adminJson(srv, cookie, '/admin/api/reports');
  assert.equal(list.body.result.total, 1, '第二次提交被节流，不写库');
  assert.equal(list.body.result.items[0].note, 'first');
}));

test('举报：未知类型收敛成 other，正文被截断', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/r3', code: 'rp3' });

  await form(srv, '/rp3', { kind: 'report', reason: '<script>', note: 'x'.repeat(900) });
  const list = await adminJson(srv, cookie, '/admin/api/reports');
  const item = list.body.result.items[0];
  assert.equal(item.reason, 'other');
  assert.equal(item.note.length, 500);
  assert.ok(REASONS.includes(item.reason));
}));

test('举报：关掉入口后提交无效', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/r4', code: 'rp4' });
  srv.ctx.settings.update({ allowReport: false });

  const res = await form(srv, '/rp4', { kind: 'report', reason: 'spam' });
  // 没被举报处理接住，会落回密码提交那一支（该链没有密码），最终仍然是 false
  assert.notEqual(res.headers.get('location'), '/rp4+?reported=1');
  const list = await adminJson(srv, cookie, '/admin/api/reports');
  assert.equal(list.body.result.total, 0);
}));

test('名片页：有举报入口，提交后给确认文案', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/r5', code: 'rp5' });

  const page = await srv.fetch('/rp5+');
  const html = await page.text();
  assert.match(html, /这条链接有问题/);
  assert.match(html, /name="kind" value="report"/);

  const after = await srv.fetch('/rp5+?reported=1');
  const done = await after.text();
  assert.match(done, /举报已提交/);
  assert.ok(!done.includes('name="kind" value="report"'), '提交后不再给表单');
}));

test('举报处理：标记已处理后从待处理计数里消失', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/r6', code: 'rp6' });
  await form(srv, '/rp6', { kind: 'report', reason: 'malware' });

  const list = await adminJson(srv, cookie, '/admin/api/reports');
  const id = list.body.result.items[0].id;
  assert.equal(list.body.result.open, 1);

  const out = await adminJson(srv, cookie, `/admin/api/reports/${id}`, {
    method: 'POST',
    body: JSON.stringify({ status: 'handled' }),
  });
  assert.equal(out.res.status, 200);
  assert.equal(out.body.result.status, 'handled');

  const after = await adminJson(srv, cookie, '/admin/api/reports');
  assert.equal(after.body.result.open, 0);
  const open = await adminJson(srv, cookie, '/admin/api/reports?status=open');
  assert.equal(open.body.result.total, 0);
  const handled = await adminJson(srv, cookie, '/admin/api/reports?status=handled');
  assert.equal(handled.body.result.total, 1);
}));

test('举报记录比短链活得久：彻底删除短链后举报还在', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/r7', code: 'rp7' });
  await form(srv, '/rp7', { kind: 'report', reason: 'illegal' });
  await adminJson(srv, cookie, '/admin/api/links/rp7', { method: 'DELETE' });
  // 彻底删除走回收站那条路，不是再删一次
  await adminJson(srv, cookie, '/admin/api/trash/rp7', { method: 'DELETE' });

  const list = await adminJson(srv, cookie, '/admin/api/reports');
  assert.equal(list.body.result.total, 1, '有人投诉过这件事不该凭空消失');
  assert.equal(list.body.result.items[0].link_url, null, '短链没了，LEFT JOIN 出来是空');
}));

test('建页组织级配置：名称、Logo、免责声明、倒数提示都渲染出来', () => withServer(async (srv) => {
  const cookie = await login(srv);
  const patch = await adminJson(srv, cookie, '/admin/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      landingOrgName: '星野工作室',
      landingLogoUrl: '/img/logo.svg',
      landingDisclaimer: '第一行说明\n第二行说明',
      landingCountdown: 5,
    }),
  });
  assert.equal(patch.body.rejected.length, 0, '四项都该被接受');

  await createLink(srv, cookie, { url: 'https://example.com/o1', code: 'og1', interstitial: true });
  const html = await (await srv.fetch('/og1')).text();
  assert.match(html, /星野工作室/);
  assert.match(html, /第一行说明/);
  assert.match(html, /第二行说明/, '换行要分段，不能挤成一段');
  assert.match(html, /留 5 秒确认目标域名/);
}));

test('建页配置：Logo 只认 http(s) 与站内路径，其余被拒', () => withServer(async (srv) => {
  const cookie = await login(srv);

  const bad = await adminJson(srv, cookie, '/admin/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ landingLogoUrl: 'javascript:alert(1)' }),
  });
  assert.deepEqual(bad.body.rejected, ['landingLogoUrl'], 'javascript: 是注入口子，必须拒');

  const dataUrl = await adminJson(srv, cookie, '/admin/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ landingLogoUrl: 'data:image/svg+xml,<svg/>' }),
  });
  assert.deepEqual(dataUrl.body.rejected, ['landingLogoUrl']);

  const good = await adminJson(srv, cookie, '/admin/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ landingLogoUrl: 'https://cdn.example.com/logo.png' }),
  });
  assert.equal(good.body.applied.landingLogoUrl, 'https://cdn.example.com/logo.png');
}));

test('建页配置：倒数提示超范围被拒，未配置时不渲染任何空块', () => withServer(async (srv) => {
  const cookie = await login(srv);
  const over = await adminJson(srv, cookie, '/admin/api/settings', {
    method: 'PATCH',
    body: JSON.stringify({ landingCountdown: 999 }),
  });
  assert.deepEqual(over.body.rejected, ['landingCountdown']);

  await createLink(srv, cookie, { url: 'https://example.com/o2', code: 'og2', interstitial: true });
  const html = await (await srv.fetch('/og2')).text();
  assert.ok(!html.includes('lp-disclaimer'), '没配就不该有空的声明框');
  assert.ok(!html.includes('lp-countdown'), '0 秒不该出现提示');
  assert.ok(!html.includes('lp-org'), '没配组织名就不该有「由 XX 创建」');
}));

test('备份：曝光与举报一起带走，恢复后都在', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/b1', code: 'bk1', interstitial: true });
  srv.ctx.store.sql.upsertLanding.run('bk1', '2026-01-01', 'news.example', 12);
  await form(srv, '/bk1', { kind: 'report', reason: 'spam', note: '备份里的举报' });

  const exportRes = await srv.fetch('/admin/api/backup?mode=json', { headers: { Cookie: cookie } });
  assert.equal(exportRes.status, 200);
  const backup = await exportRes.json();
  assert.equal(Array.isArray(backup.landing_views), true, '曝光要进备份');
  assert.equal(Array.isArray(backup.reports), true, '举报要进备份');

  // 校验走的是同一套 verifyBackup：新集合走 EXTRA，只有文件里带了才核对
  const { verifyBackup } = await import('../src/services/backup.js');
  const verdict = verifyBackup(backup);
  assert.equal(verdict.status, 'ok', verdict.reason);
}));

test('自检：孤儿曝光能被查出来并清掉', () => withServer(async (srv) => {
  const cookie = await login(srv);
  srv.ctx.store.sql.upsertLanding.run('ghost9', '2026-01-01', 'x.com', 3);

  const before = await adminJson(srv, cookie, '/admin/api/doctor');
  assert.equal(before.body.result.orphans.landing, 1);

  await adminJson(srv, cookie, '/admin/api/doctor/collect', { method: 'POST' });
  const after = await adminJson(srv, cookie, '/admin/api/doctor');
  assert.equal(after.body.result.orphans.landing, 0);
}));
