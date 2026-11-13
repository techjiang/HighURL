import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { startTestServer, tmpDir } from './helpers.js';
import { LinkService, parseExpire } from '../src/services/links.js';
import { makeStore, silentLogger } from './helpers.js';
import { Settings } from '../src/services/settings.js';
import { TitleFetcher } from '../src/services/titles.js';
import { SCHEMA_VERSION } from '../src/lib/db.js';

const run = promisify(execFile);
const CLI = new URL('../src/cli.js', import.meta.url).pathname;

async function withServer(fn) {
  const srv = await startTestServer();
  try {
    return await fn(srv);
  } finally {
    await srv.stop();
  }
}

async function login(srv) {
  if (!srv.ctx.auth.hasAdmin()) srv.ctx.auth.createAdmin('admin', 'password123');
  const res = await srv.fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'password123' }).toString(),
  });
  return (res.headers.getSetCookie?.() || [res.headers.get('set-cookie')])
    .map((c) => String(c).split(';')[0])
    .join('; ');
}

const post = (srv, cookie, path, body) =>
  srv.json(path, { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify(body) });

test('恢复备份时大小写不同的同码走覆盖，不再 500', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await post(srv, cookie, '/admin/api/links', { url: 'https://a.com', code: 'abc' });
  const r = await post(srv, cookie, '/admin/api/restore', {
    content: JSON.stringify({ links: [{ code: 'ABC', url: 'https://b.com' }] }),
    mode: 'merge',
  });
  assert.equal(r.res.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result.restored, 1);
  assert.equal(srv.ctx.store.findLinkByCode('abc').url, 'https://b.com');
  assert.equal(srv.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM links').get().n, 1, '没有多出一条重复的');
}));

test('YOURLS / 备份导入的大小写冲突项按冲突处理而不是硬塞', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await post(srv, cookie, '/admin/api/links', { url: 'https://a.com', code: 'dup1' });
  const preview = await post(srv, cookie, '/admin/api/migrate/preview', {
    content: JSON.stringify({ links: [{ code: 'DUP1', url: 'https://b.com' }] }),
    filename: 'x.json',
  });
  assert.equal(preview.res.status, 200);
  assert.equal(preview.body.result.conflicts, 1);
  assert.equal(preview.body.result.willImport, 0);
}));

test('覆盖导入大小写不同的短码更新到同一条记录', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await post(srv, cookie, '/admin/api/links', { url: 'https://a.com', code: 'ovr1' });
  const apply = await post(srv, cookie, '/admin/api/migrate/apply', {
    content: JSON.stringify({ links: [{ code: 'OVR1', url: 'https://b.com' }] }),
    filename: 'x.json',
    overwrite: true,
  });
  assert.equal(apply.res.status, 200, JSON.stringify(apply.body));
  assert.equal(apply.body.result.updated, 1);
  assert.equal(srv.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM links').get().n, 1);
  assert.equal(srv.ctx.store.findLinkByCode('ovr1').url, 'https://b.com');
}));

test('恢复备份带上来源与平台统计', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await post(srv, cookie, '/admin/api/links', { url: 'https://a.com', code: 'ref1' });
  srv.ctx.store.sql.upsertRef.run('ref1', 'google.com', 5);
  srv.ctx.store.sql.upsertAgent.run('ref1', 'ios', 5);
  srv.ctx.store.sql.upsertDaily.run('ref1', '2026-01-01', 5);
  const backup = srv.ctx.store.exportAll();

  await post(srv, cookie, '/admin/api/restore', { content: JSON.stringify(backup), mode: 'replace' });
  const sources = await srv.json('/admin/api/sources', { headers: { Cookie: cookie } });
  assert.equal(sources.body.result.refs.length, 1);
  assert.equal(sources.body.result.refs[0].host, 'google.com');
  assert.equal(sources.body.result.agents.length, 1);
  assert.equal(sources.body.result.agents[0].platform, 'ios');
}));

test('恢复备份时指向不存在分组的 group_id 落成 null', () => withServer(async (srv) => {
  const cookie = await login(srv);
  const r = await post(srv, cookie, '/admin/api/restore', {
    content: JSON.stringify({ links: [{ code: 'ghost', url: 'https://g.com', group_id: 4242 }] }),
    mode: 'merge',
  });
  assert.equal(r.res.status, 200);
  assert.equal(srv.ctx.store.findLinkByCode('ghost').group_id, null);
  const list = await srv.json('/admin/api/links', { headers: { Cookie: cookie } });
  assert.equal(list.body.result.items[0].group, null, '不会渲染出没有名字的分组');
}));

test('手术式自检：报告并清理孤儿统计，不动现存数据', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await post(srv, cookie, '/admin/api/links', { url: 'https://a.com', code: 'live1' });
  srv.ctx.store.sql.upsertDaily.run('live1', '2026-01-01', 2);
  srv.ctx.store.sql.upsertDaily.run('ghost1', '2026-01-01', 9);
  srv.ctx.store.sql.upsertRef.run('ghost1', 'x.com', 9);
  srv.ctx.store.sql.upsertAgent.run('ghost1', 'ios', 9);

  const before = await srv.json('/admin/api/doctor', { headers: { Cookie: cookie } });
  assert.deepEqual(before.body.result.orphans, { daily: 1, refs: 1, agents: 1, countries: 0, slots: 0, history: 0, landing: 0, targets: 0, total: 3 });
  assert.equal(before.body.result.duplicateCodes, 0);
  assert.equal(before.body.result.schemaVersion, SCHEMA_VERSION);

  const cleared = await srv.json('/admin/api/doctor/collect', { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(cleared.body.result.removed, 3);

  const after = await srv.json('/admin/api/doctor', { headers: { Cookie: cookie } });
  assert.equal(after.body.result.orphans.total, 0);
  assert.equal(srv.ctx.store.db.prepare("SELECT SUM(clicks) AS n FROM click_daily WHERE code = 'live1'").get().n, 2, '现存数据不受影响');
}));

test('纯日期有效期按当天结束算，选今天不会立刻过期', () => withServer(async (srv) => {
  const cookie = await login(srv);
  const today = new Date();
  const text = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const created = await post(srv, cookie, '/admin/api/links', { url: 'https://a.com', code: 'today1', expireAt: text });
  assert.equal(created.res.status, 200);
  assert.ok(created.body.result.expireAt > Date.now(), '当天 23:59:59 之后才过期');
  assert.equal((await srv.fetch('/today1')).status, 302);
}));

test('parseExpire 对纯日期与 ISO 的行为', () => {
  const end = parseExpire('2030-06-01');
  const d = new Date(end);
  assert.equal(d.getHours(), 23);
  assert.equal(d.getMinutes(), 59);
  assert.equal(d.getDate(), 1);
  assert.equal(parseExpire('2030-06-01T00:00:00Z'), Date.parse('2030-06-01T00:00:00Z'));
  assert.equal(parseExpire(''), null);
  assert.equal(parseExpire('never'), null);
});

test('CLI restore 也恢复来源与平台统计', async () => {
  const dir = tmpDir();
  await run(process.execPath, [CLI, 'init', '--username', 'admin', '--password', 'password123', '--data', dir]);
  const backupFile = path.join(dir, 'bk.json');
  fs.writeFileSync(backupFile, JSON.stringify({
    links: [{ code: 'cli1', url: 'https://a.com', title: '', clicks: 3 }],
    click_daily: [{ code: 'cli1', day: '2026-01-01', clicks: 3 }],
    click_refs: [{ code: 'cli1', host: 'twitter.com', clicks: 3 }],
    click_agents: [{ code: 'cli1', platform: 'android', clicks: 3 }],
    groups: [],
  }));
  await run(process.execPath, [CLI, 'restore', backupFile, '--data', dir]);

  // 用 stats 读一遍库，确认引用/平台都进去了
  const { stdout } = await run(process.execPath, [CLI, 'stats', '--data', dir]);
  assert.match(stdout, /短链 1 条/);
  const { openDatabase } = await import('../src/lib/db.js');
  const store = openDatabase(path.join(dir, 'highurl.db'));
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM click_refs').get().n, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM click_agents').get().n, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM click_daily').get().n, 1);
  store.close();
});

test('CLI stats --collect-orphans 清理孤儿行', async () => {
  const dir = tmpDir();
  await run(process.execPath, [CLI, 'init', '--username', 'admin', '--password', 'password123', '--data', dir]);
  const { openDatabase } = await import('../src/lib/db.js');
  const store = openDatabase(path.join(dir, 'highurl.db'));
  store.sql.upsertDaily.run('ghost', '2026-01-01', 4);
  store.sql.upsertRef.run('ghost', 'a.com', 4);
  store.close();

  const before = await run(process.execPath, [CLI, 'stats', '--data', dir]);
  assert.match(before.stdout, /失去归属的统计/);
  const after = await run(process.execPath, [CLI, 'stats', '--collect-orphans', '--data', dir]);
  assert.match(after.stdout, /已清理 2 行/);
});

test('设置项 dedupeWindowSec 的边界校验', () => {
  const { store, settings } = makeStore();
  const links = new LinkService({ store, settings, titles: new TitleFetcher({ settings, logger: silentLogger }) });
  void links;
  const ok = settings.update({ dedupeWindowSec: 30 });
  assert.equal(ok.applied.dedupeWindowSec, 30);
  const zero = settings.update({ dedupeWindowSec: 0 });
  assert.equal(zero.applied.dedupeWindowSec, 0);
  const bad = settings.update({ dedupeWindowSec: 999999 });
  assert.deepEqual(bad.rejected, ['dedupeWindowSec']);
  store.close();
  void Settings;
});
