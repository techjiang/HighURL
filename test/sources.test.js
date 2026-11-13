import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { startTestServer } from './helpers.js';
import { ROOT } from '../src/lib/util.js';

async function withServer(fn, overrides = {}) {
  const srv = await startTestServer(overrides);
  try {
    return await fn(srv);
  } finally {
    await srv.stop();
  }
}

async function login(srv, username = 'admin', password = 'password123') {
  if (!srv.ctx.auth.hasAdmin()) srv.ctx.auth.createAdmin(username, password);
  const res = await srv.fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }).toString(),
  });
  const cookie = (res.headers.getSetCookie?.() || [res.headers.get('set-cookie')])
    .map((c) => String(c).split(';')[0])
    .join('; ');
  return cookie;
}

function seedLink(store, { code, clicks = 0, expireAt = null, status = 'active' }) {
  const ts = Date.now() - 86400000;
  store.db
    .prepare(`INSERT INTO links (code, url, title, note, tags, status, password, clicks, created_at, updated_at, expire_at)
      VALUES (?, 'https://example.com', '', '', '', ?, NULL, ?, ?, ?, ?)`)
    .run(code, status, clicks, ts, ts, expireAt);
}

test('来源分析接口需要登录', () => withServer(async (srv) => {
  const res = await srv.json('/admin/api/sources');
  assert.equal(res.res.status, 401);
}));

test('来源分析返回来源站点、平台与占比数据', () => withServer(async (srv) => {
  const { auth, store } = srv.ctx;
  auth.createAdmin('admin', 'password123');
  auth.createKey('k', 'read,write');
  const cookie = await login(srv);

  seedLink(store, { code: 'src1', clicks: 6 });
  seedLink(store, { code: 'src2', clicks: 4 });
  store.sql.upsertRef.run('src1', 't.co', 4);
  store.sql.upsertRef.run('src1', 'news.ycombinator.com', 2);
  store.sql.upsertRef.run('src2', 't.co', 4);
  store.sql.upsertAgent.run('src1', 'ios', 5);
  store.sql.upsertAgent.run('src1', 'android', 1);
  store.sql.upsertAgent.run('src2', 'windows', 4);

  const { res, body } = await srv.json('/admin/api/sources?days=7', { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const r = body.result;
  assert.equal(r.days, 7);
  assert.equal(r.daily.length, 7);
  assert.equal(r.totalClicks, 10);
  assert.equal(r.known, 10);
  assert.equal(r.unknown, 0);
  // t.co 合并了两个短码的点击
  assert.equal(r.refs[0].host, 't.co');
  assert.equal(r.refs[0].clicks, 8);
  assert.equal(r.refs[0].links, 2);
  assert.equal(r.agents[0].platform, 'ios');
  assert.equal(r.agents[0].clicks, 5);
}));

test('无来源的点击计入 unknown 而不是凭空消失', () => withServer(async (srv) => {
  srv.ctx.auth.createAdmin('admin', 'password123');
  const cookie = await login(srv);
  seedLink(srv.ctx.store, { code: 'dir1', clicks: 5 });
  srv.ctx.store.sql.upsertRef.run('dir1', 't.co', 2);
  const { body } = await srv.json('/admin/api/sources', { headers: { Cookie: cookie } });
  assert.equal(body.result.totalClicks, 5);
  assert.equal(body.result.known, 2);
  assert.equal(body.result.unknown, 3);
}));

test('过期回收：disable 策略停用并保留记录', () => withServer(async (srv) => {
  const { auth, store, settings } = srv.ctx;
  auth.createAdmin('admin', 'password123');
  const cookie = await login(srv);
  settings.update({ expiredPolicy: 'disable', expiredGraceDays: 0 });
  seedLink(store, { code: 'old1', expireAt: Date.now() - 3600000 });
  seedLink(store, { code: 'live1', expireAt: Date.now() + 3600000 });

  const { body } = await srv.json('/admin/api/links/sweep', { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(body.result.archived, 1);
  assert.equal(body.result.removed, 0);

  const row = store.sql.getLinkByCode.get('old1');
  assert.ok(row, '停用策略不应删除记录');
  assert.equal(row.status, 'disabled');
  assert.equal(store.sql.getLinkByCode.get('live1').status, 'active');
  assert.equal((await srv.fetch('/old1')).status, 404);
}));

test('过期回收：delete 策略连统计一起删干净', () => withServer(async (srv) => {
  const { auth, store, settings } = srv.ctx;
  auth.createAdmin('admin', 'password123');
  const cookie = await login(srv);
  settings.update({ expiredPolicy: 'delete', expiredGraceDays: 0 });
  seedLink(store, { code: 'gone1', expireAt: Date.now() - 3600000 });
  store.sql.upsertRef.run('gone1', 't.co', 1);
  store.sql.upsertDaily.run('gone1', '2026-01-01', 1);

  const { body } = await srv.json('/admin/api/links/sweep', { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(body.result.removed, 1);
  assert.equal(store.sql.getLinkByCode.get('gone1'), undefined);
  assert.equal(store.sql.linkRefs.all('gone1', 5).length, 0);
  assert.equal(store.sql.linkDaily.all('gone1', '2026-01-01').length, 0);
}));

test('过期回收：宽限期内不动手', () => withServer(async (srv) => {
  const { auth, store, settings } = srv.ctx;
  auth.createAdmin('admin', 'password123');
  const cookie = await login(srv);
  settings.update({ expiredPolicy: 'disable', expiredGraceDays: 7 });
  seedLink(store, { code: 'recent', expireAt: Date.now() - 86400000 });
  seedLink(store, { code: 'ancient', expireAt: Date.now() - 9 * 86400000 });

  const { body } = await srv.json('/admin/api/links/sweep', { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(body.result.archived, 1);
  assert.equal(store.sql.getLinkByCode.get('recent').status, 'active');
  assert.equal(store.sql.getLinkByCode.get('ancient').status, 'disabled');
}));

test('过期回收默认关闭，不会误删数据', () => withServer(async (srv) => {
  const { auth, store } = srv.ctx;
  auth.createAdmin('admin', 'password123');
  const cookie = await login(srv);
  seedLink(store, { code: 'keep1', expireAt: Date.now() - 30 * 86400000 });
  const { body } = await srv.json('/admin/api/links/sweep', { method: 'POST', headers: { Cookie: cookie } });
  assert.deepEqual(body.result, { archived: 0, removed: 0 });
  assert.ok(store.sql.getLinkByCode.get('keep1'));
}));

test('过期回收写入审计日志', () => withServer(async (srv) => {
  const { auth, store, settings } = srv.ctx;
  auth.createAdmin('admin', 'password123');
  const cookie = await login(srv);
  settings.update({ expiredPolicy: 'delete', expiredGraceDays: 0 });
  seedLink(store, { code: 'aud1', expireAt: Date.now() - 1000 });
  await srv.json('/admin/api/links/sweep', { method: 'POST', headers: { Cookie: cookie } });
  const rows = store.sql.listAuditByAction.all('link.expire_sweep%', 10, 0);
  assert.ok(rows.length >= 1);
  assert.match(rows[0].detail, /manual:1/);
}));

test('过期策略设置项只接受白名单值', () => withServer(async (srv) => {
  const { settings } = srv.ctx;
  const ok = settings.update({ expiredPolicy: 'delete' });
  assert.equal(ok.applied.expiredPolicy, 'delete');
  const bad = settings.update({ expiredPolicy: 'explode' });
  assert.ok(bad.rejected.includes('expiredPolicy'));
  assert.equal(settings.get('expiredPolicy'), 'delete');

  settings.update({ expiredGraceDays: '3' });
  assert.equal(settings.get('expiredGraceDays'), 3);
  settings.update({ expiredGraceDays: -1 });
  assert.equal(settings.get('expiredGraceDays'), 3);
}));

test('/health 的版本号与 package.json 一致', () => withServer(async (srv) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const { body } = await srv.json('/health');
  assert.equal(body.version, pkg.version);
}));

test('管理台侧栏版本号来自 package.json', () => withServer(async (srv) => {
  srv.ctx.auth.createAdmin('admin', 'password123');
  const cookie = await login(srv);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const html = await (await srv.fetch('/admin', { headers: { Cookie: cookie } })).text();
  assert.ok(html.includes(`v${pkg.version}`), '侧栏应显示当前版本');
}));
