import test from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, makeStore, silentLogger } from './helpers.js';
import { ClickCounter } from '../src/services/counter.js';
import { openDatabase } from '../src/lib/db.js';
import { Settings } from '../src/services/settings.js';
import { loadConfig } from '../src/config.js';
import path from 'node:path';
import { tmpDir, cleanupTmp } from './helpers.js';
import { dumpSql } from '../src/routes/admin.js';
import { buildBackup, verifyBackup } from '../src/services/backup.js';
import { restoreBackup } from '../src/services/restore.js';

test.after(() => cleanupTmp());

async function login(srv) {
  const res = await srv.fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'Passw0rd!23' }),
  });
  return String(res.headers.get('set-cookie') || '').split(';')[0];
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

/** 直接建一套 store + counter，验证热路径 → 落库这一段 */
function makeCounter() {
  const dir = tmpDir();
  const config = loadConfig({ dataDir: dir });
  const store = openDatabase(path.join(dir, 'test.db'));
  const settings = new Settings(store, config);
  const counter = new ClickCounter(store, settings, silentLogger);
  return { store, counter, settings };
}

test('时段计数：hit 按本地时间落桶，flush 后能查到', async () => {
  const { store, counter } = makeCounter();
  // 2026-11-13 是周五，本地时间 15:xx
  const fridayAfternoon = new Date(2026, 10, 13, 15, 20, 0).getTime();
  counter.hit('a', { at: fridayAfternoon });
  counter.hit('a', { at: fridayAfternoon });
  counter.hit('a', { at: new Date(2026, 10, 15, 15, 1).getTime() }); // 周日同一小时
  await counter.flush();

  const rows = store.sql.linkSlots.all('a');
  const byKey = new Map(rows.map((r) => [`${r.dow}-${r.hour}`, r.clicks]));
  assert.equal(byKey.get('5-15'), 2, '周五 15 点两次');
  assert.equal(byKey.get('0-15'), 1, '周日同一个小时是另一个桶');
  assert.equal(rows.length, 2);
  store.close();
});

test('时段矩阵：24×7 补齐，峰值与合计正确', async () => {
  const { store } = makeCounter();
  const m = store.hourMatrix([]);
  assert.equal(m.cells.length, 168);
  assert.equal(m.total, 0);
  assert.equal(m.peak, 0);

  const filled = store.hourMatrix([
    { dow: 1, hour: 9, clicks: 4 },
    { dow: 6, hour: 23, clicks: 11 },
  ]);
  assert.equal(filled.cells[1 * 24 + 9], 4);
  assert.equal(filled.cells[6 * 24 + 23], 11);
  assert.equal(filled.total, 15);
  assert.equal(filled.peak, 11);
  store.close();
});

test('接口：概览 / 来源 / 短链统计都带时段矩阵', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await srv.json('/admin/api/links', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ url: 'https://example.com/x', code: 'slot1' }),
  });
  srv.ctx.counter.hit('slot1', { at: new Date(2026, 10, 13, 10, 0, 0).getTime() });
  srv.ctx.counter.hit('slot1', { at: new Date(2026, 10, 13, 11, 0, 0).getTime() });
  await srv.ctx.counter.flush();

  const overview = await srv.json('/admin/api/overview', { headers: { Cookie: cookie } });
  assert.equal(overview.body.result.hours.cells.length, 168);
  assert.equal(overview.body.result.hours.total, 2);
  assert.equal(overview.body.result.hours.peak, 1);

  const sources = await srv.json('/admin/api/sources', { headers: { Cookie: cookie } });
  assert.equal(sources.body.result.hours.total, 2);

  const stats = await srv.json('/admin/api/links/slot1/stats', { headers: { Cookie: cookie } });
  assert.equal(stats.body.result.hours.cells[5 * 24 + 10], 1);

  const one = await srv.json('/admin/api/hours?code=slot1', { headers: { Cookie: cookie } });
  assert.equal(one.body.result.code, 'slot1');
  assert.equal(one.body.result.total, 2);
}));

test('回收站的短链不计入全站时段', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await srv.json('/admin/api/links', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ url: 'https://a.com', code: 'gone' }) });
  await srv.json('/admin/api/links', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ url: 'https://b.com', code: 'kept' }) });
  srv.ctx.counter.hit('gone', { at: new Date(2026, 10, 13, 8, 0, 0).getTime() });
  srv.ctx.counter.hit('kept', { at: new Date(2026, 10, 13, 8, 0, 0).getTime() });
  await srv.ctx.counter.flush();
  await srv.json('/admin/api/links/gone', { method: 'DELETE', headers: { Cookie: cookie } });

  const view = await srv.json('/admin/api/hours', { headers: { Cookie: cookie } });
  assert.equal(view.body.result.total, 1, '口径和其它统计一致，回收站的不算');
}));

test('SQL dump 覆盖所有业务表，并带上索引', async () => {
  const { store } = makeCounter();
  store.sql.insertLink.run('abc', 'https://a.com', '', '', '', 'active', null, Date.now(), Date.now(), null, null);
  const sql = dumpSql(store);
  for (const table of ['links', 'groups', 'link_targets', 'click_slots', 'click_countries', 'settings', 'admins']) {
    assert.ok(sql.includes(`"${table}"`), `dump 里应当有 ${table}`);
  }
  assert.ok(/CREATE UNIQUE INDEX/i.test(sql), '索引要一起导出，否则恢复出来的库少了短码唯一约束');
  store.close();
});

test('dump 出来的 SQL 能直接建库，且短码仍不区分大小写', async () => {
  const { store } = makeCounter();
  store.sql.insertLink.run('abc', 'https://a.com', '', '', '', 'active', null, Date.now(), Date.now(), null, null);
  const sql = dumpSql(store);
  store.close();

  const file = path.join(tmpDir(), 'restored.db');
  const db = openDatabase(file);
  db.db.exec('PRAGMA foreign_keys=OFF');
  db.db.exec(sql);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM links').get().n, 1);
  assert.throws(() => {
    db.db.exec("INSERT INTO links (code, url, title, note, tags, status, created_at, updated_at) VALUES ('ABC','https://b.com','','','','active',1,1)");
  }, /UNIQUE/i, 'NOCASE 唯一索引必须一起恢复');
  db.close();
});

test('备份带时段：校验和与恢复都不丢', async () => {
  const { store, counter } = makeCounter();
  store.sql.insertLink.run('p', 'https://a.com', '', '', '', 'active', null, Date.now(), Date.now(), null, null);
  counter.hit('p', { at: new Date(2026, 10, 13, 9, 0, 0).getTime() });
  counter.hit('p', { at: new Date(2026, 10, 13, 9, 5, 0).getTime() });
  await counter.flush();

  const backup = buildBackup(store, { hostname: 'test-host' });
  assert.equal(backup.click_slots.length, 1);
  assert.equal(backup.manifest.counts.click_slots, 1);
  assert.ok(backup.manifest.extraChecksum, '新集合单独一份摘要');
  assert.equal(verifyBackup(backup).status, 'ok');

  // 改一个时段数字：主校验和不变（老程序仍认），extra 对不上要报出来
  const tampered = JSON.parse(JSON.stringify(backup));
  tampered.click_slots[0].clicks = 99;
  const bad = verifyBackup(tampered);
  assert.equal(bad.status, 'mismatch');
  assert.match(bad.reason, /新集合/);

  const target = makeCounter();
  target.store.sql.insertLink.run('p', 'https://a.com', '', '', '', 'active', null, Date.now(), Date.now(), null, null);
  restoreBackup(target.store, backup, { mode: 'merge' });
  assert.equal(target.store.sql.linkSlots.all('p')[0].clicks, 2);
  store.close();
  target.store.close();
});

test('恢复时丢弃越界的时段行，不污染矩阵', async () => {
  const { store } = makeCounter();
  const backup = buildBackup(store, { hostname: 't' });
  const bogus = {
    ...backup,
    links: [{ code: 'q', url: 'https://q.com', clicks: 1 }],
    click_slots: [
      { code: 'q', dow: 9, hour: 3, clicks: 5 },
      { code: 'q', dow: 1, hour: 25, clicks: 5 },
      { code: 'q', dow: 2, hour: 3, clicks: 4 },
    ],
  };
  const out = restoreBackup(store, bogus, { mode: 'merge', force: true });
  assert.equal(out.stats, 1, '只有合法那一行被写入');
  const rows = store.sql.linkSlots.all('q');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].clicks, 4);
  store.close();
});

test('老备份（没有 extraChecksum）依然判为 ok', async () => {
  const { store } = makeCounter();
  const backup = buildBackup(store, { hostname: 't' });
  delete backup.manifest.extraChecksum;
  const v = verifyBackup(backup);
  assert.equal(v.status, 'ok', '没这一项可核对时，不该把老备份判成损坏');
  store.close();
});

test('坏的 Cookie 编码不再把请求打成 500', async () => withServer(async (srv) => {
  const res = await srv.fetch('/admin/api/me', { headers: { Cookie: 'highurl_session=%zz' } });
  assert.equal(res.status, 401, '解不开的 Cookie 只是无效会话，不是服务器错误');
  const page = await srv.fetch('/admin', { headers: { Cookie: 'highurl_session=%zz' } });
  assert.equal(page.status, 302, '管理台应当跳去登录页');
}));
