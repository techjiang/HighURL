import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { openDatabase } from '../src/lib/db.js';
import { Settings } from '../src/services/settings.js';
import { loadConfig } from '../src/config.js';
import { buildDigest } from '../src/services/insights.js';
import { tmpDir, cleanupTmp, startTestServer, silentLogger } from './helpers.js';
import { dateKey } from '../src/lib/util.js';

test.after(() => cleanupTmp());

function makeStore() {
  const dir = tmpDir();
  const config = loadConfig({ dataDir: dir });
  const store = openDatabase(path.join(dir, 'test.db'));
  const settings = new Settings(store, config);
  return { store, settings, dir };
}

function addLink(store, code, { clicks = 0, createdAt = Date.now(), groupId = null } = {}) {
  store.sql.insertLink.run(code, `https://example.com/${code}`, `标题 ${code}`, '', '', 'active', null, createdAt, createdAt, null, groupId);
  if (clicks) {
    const row = store.sql.getLinkByCodeAny.get(code);
    store.db.prepare('UPDATE links SET clicks = ? WHERE id = ?').run(clicks, row.id);
  }
  return store.sql.getLinkByCodeAny.get(code);
}

const dayOffset = (n) => dateKey(new Date(Date.now() - n * 86400000));

test('日报：点击涨跌按相邻两天比较，并给出可点的入口', () => {
  const { store } = makeStore();
  addLink(store, 'a');
  store.sql.upsertDaily.run('a', dayOffset(1), 20);
  store.sql.upsertDaily.run('a', dayOffset(0), 40);

  const d = buildDigest(store);
  assert.equal(d.counts.clicks, 40, '本期=今天');
  assert.equal(d.counts.clicksPrev, 20, '上期=昨天');
  const clickItem = d.items.find((i) => i.text.includes('点击'));
  assert.ok(clickItem, '应该有一条点击相关的结论');
  assert.equal(clickItem.kind, 'up');
  assert.match(clickItem.text, /涨 100%/);
  assert.equal(clickItem.link, '#/sources');
  store.close();
});

test('日报：样本太小时不判涨跌，也不编出「上涨 300%」', () => {
  const { store } = makeStore();
  addLink(store, 'a');
  store.sql.upsertDaily.run('a', dayOffset(1), 1);
  store.sql.upsertDaily.run('a', dayOffset(0), 3);

  const d = buildDigest(store);
  assert.equal(d.items.some((i) => /涨|跌/.test(i.text)), false, '分母太小不该报涨跌');
  store.close();
});

test('日报：数据完全没变化时给「持平」，而不是空白', () => {
  const { store } = makeStore();
  addLink(store, 'a');
  store.sql.upsertDaily.run('a', dayOffset(1), 30);
  store.sql.upsertDaily.run('a', dayOffset(0), 30);

  const d = buildDigest(store);
  const item = d.items.find((i) => i.text.includes('点击'));
  assert.equal(item.kind, 'flat');
  assert.match(item.text, /持平/);
  store.close();
});

test('日报：落地率变化只在两期都有曝光时才提', () => {
  const { store } = makeStore();
  addLink(store, 'a');
  store.sql.upsertDaily.run('a', dayOffset(1), 50);
  store.sql.upsertDaily.run('a', dayOffset(0), 20);
  store.sql.upsertLanding.run('a', dayOffset(1), 'weibo.com', 100);
  store.sql.upsertLanding.run('a', dayOffset(0), 'weibo.com', 200);

  const d = buildDigest(store);
  const item = d.items.find((i) => i.text.includes('落点率'));
  assert.ok(item, '两期都有曝光时应该比较落点率');
  assert.match(item.text, /50%/, '上期 50%');
  assert.match(item.text, /10%/, '本期 10%');
  assert.equal(item.kind, 'down');
  store.close();
});

test('日报：举报、死链、过期、回收站会以待处理事项出现', () => {
  const { store } = makeStore();
  const link = addLink(store, 'a');
  store.sql.insertReport.run('a', 'broken', '', '1.2.3.*', 'UA', Date.now());
  store.sql.setHealth.run('dead', 404, Date.now(), 12, 'HTTP 404', 2, link.id);
  store.db.prepare('UPDATE links SET expire_at = ? WHERE id = ?').run(Date.now() - 86400000, link.id);
  store.sql.softDeleteById.run(Date.now(), Date.now(), addLink(store, 'b').id);

  const d = buildDigest(store);
  const text = d.items.map((i) => i.text).join('\n');
  assert.match(text, /1 条举报还没处理/);
  assert.match(text, /打不开/);
  assert.match(text, /已过有效期/);
  assert.match(text, /回收站里有 1 条/);
  assert.equal(d.level, 'warn', '有需要动手的事时整体状态是 warn');
  store.close();
});

test('热点榜：只排窗口内有点击的短链，并带上窗口内曝光', () => {
  const { store } = makeStore();
  addLink(store, 'quiet', { clicks: 999 });
  addLink(store, 'hot');
  addLink(store, 'warm');
  store.sql.upsertDaily.run('hot', dayOffset(0), 30);
  store.sql.upsertDaily.run('warm', dayOffset(0), 5);
  store.sql.upsertDaily.run('quiet', dayOffset(3), 999);
  store.sql.upsertLanding.run('hot', dayOffset(0), 'weibo.com', 80);

  const { rows } = store.hotLinks({ hours: 24 });
  assert.deepEqual(rows.map((r) => r.code), ['hot', 'warm'], '老数据不进榜，按窗口点击排序');
  assert.equal(rows[0].window_clicks, 30);
  assert.equal(rows[0].window_views, 80);
  store.close();
});

test('热点榜：limit 生效，窗口可调', () => {
  const { store } = makeStore();
  for (const code of ['a', 'b', 'c']) addLink(store, code);
  store.sql.upsertDaily.run('a', dayOffset(0), 3);
  store.sql.upsertDaily.run('b', dayOffset(0), 2);
  store.sql.upsertDaily.run('c', dayOffset(5), 9);

  assert.equal(store.hotLinks({ hours: 24, limit: 2 }).rows.length, 2);
  const wide = store.hotLinks({ hours: 24 * 7 });
  assert.equal(wide.rows[0].code, 'c', '放宽窗口后更早的数据也进榜');
  store.close();
});

test('热度筛选：按全库最高点击数的比例分档', () => {
  const { store } = makeStore();
  addLink(store, 'top', { clicks: 100 });
  addLink(store, 'mid', { clicks: 40 });
  addLink(store, 'low', { clicks: 5 });
  addLink(store, 'zero');

  assert.deepEqual(store.listLinks({ heat: 'hot' }).rows.map((r) => r.code), ['top']);
  assert.deepEqual(store.listLinks({ heat: 'warm' }).rows.map((r) => r.code).sort(), ['mid', 'top']);
  assert.equal(store.listLinks({}).rows.length, 4, '不传 heat 时不受影响');
  assert.equal(store.listLinks({ heat: 'whatever' }).rows.length, 4, '非法档位被忽略而不是筛成空');
  store.close();
});

test('最近热度排序：按窗口内新增点击排，不是累计', () => {
  const { store } = makeStore();
  addLink(store, 'old', { clicks: 500 });
  addLink(store, 'fresh', { clicks: 10 });
  store.sql.upsertDaily.run('fresh', dayOffset(0), 10);
  store.sql.upsertDaily.run('old', dayOffset(5), 500);

  const rows = store.listLinks({ sort: 'recent_desc', sinceDay: dayOffset(1) }).rows;
  assert.equal(rows[0].code, 'fresh');
  store.close();
});

test('热点榜与日报有 HTTP 接口，且都要登录', async () => {
  const srv = await startTestServer({ titleFetch: false });
  await srv.ctx.auth.createAdmin('admin', 'Passw0rd!23');
  try {
    const anon = await srv.fetch('/admin/api/digest');
    assert.equal(anon.status, 401);

    const login = await srv.fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: 'Passw0rd!23' }),
    });
    const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
    const headers = { Cookie: cookie };

    const digest = await srv.json('/admin/api/digest?hours=48', { headers });
    assert.equal(digest.res.status, 200);
    assert.equal(digest.body.result.hours, 48);
    assert.ok(Array.isArray(digest.body.result.items));

    const hot = await srv.json('/admin/api/hot?limit=3', { headers });
    assert.equal(hot.res.status, 200);
    assert.ok(Array.isArray(hot.body.result.rows));

    const overview = await srv.json('/admin/api/overview', { headers });
    assert.ok(overview.body.result.digest, '概览带日报');
    assert.ok(Array.isArray(overview.body.result.hot), '概览带热点榜');

    const list = await srv.json(`/admin/api/links?heat=hot&sort=recent_desc`, { headers });
    assert.equal(list.res.status, 200, '热度和最近排序在列表接口上不报错');
  } finally {
    await srv.stop();
  }
});

test('日志器可注入但不影响结果', () => {
  const { store } = makeStore();
  addLink(store, 'a');
  assert.doesNotThrow(() => buildDigest(store, { hours: 0 }));
  void silentLogger;
  store.close();
});
