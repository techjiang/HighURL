import test from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, cleanupTmp } from './helpers.js';

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

/** 直接往时段表塞数据：跳转一次只涨一格，验证聚合要造可预期的分布 */
function seedSlots(store, code, rows) {
  for (const [dow, hour, clicks] of rows) store.sql.upsertSlot.run(code, dow, hour, clicks);
}

async function createLink(srv, cookie, body) {
  const res = await fetch(`${srv.base}/admin/api/links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ fetchTitle: false, ...body }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).result;
}

async function createGroup(srv, cookie, name) {
  const res = await fetch(`${srv.base}/admin/api/groups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).result;
}

test('分组时段：按分组汇总成 7×24 矩阵，未分组单独一格', () => withServer(async (srv) => {
  const cookie = await login(srv);
  const g = await createGroup(srv, cookie, '官网');
  await createLink(srv, cookie, { url: 'https://example.com/a', code: 'ga', group: g.id });
  await createLink(srv, cookie, { url: 'https://example.com/b', code: 'gb', group: g.id });
  await createLink(srv, cookie, { url: 'https://example.com/c', code: 'loose' });
  seedSlots(srv.ctx.store, 'ga', [[1, 9, 3], [1, 10, 5]]);
  seedSlots(srv.ctx.store, 'gb', [[1, 9, 2]]);
  seedSlots(srv.ctx.store, 'loose', [[6, 23, 7]]);

  const res = await fetch(`${srv.base}/admin/api/groups/hours`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const { result } = await res.json();
  const byName = new Map(result.items.map((it) => [it.name, it]));

  const group = byName.get('官网');
  assert.equal(group.id, g.id);
  assert.equal(group.cells.length, 168, '矩阵固定 7×24');
  assert.equal(group.cells[1 * 24 + 9], 5, '两条短链同一格要相加');
  assert.equal(group.cells[1 * 24 + 10], 5);
  assert.equal(group.total, 10);
  assert.equal(group.peak, 5);
  assert.equal(group.links, 2);

  const loose = byName.get('未分组');
  assert.equal(loose.id, null);
  assert.equal(loose.cells[6 * 24 + 23], 7);
  assert.equal(loose.total, 7);
  assert.equal(byName.has('官网'), true);
}));

test('分组时段：没有点击的分组也返回补零矩阵，而不是消失', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await createGroup(srv, cookie, '空的');
  const res = await fetch(`${srv.base}/admin/api/groups/hours`, { headers: { Cookie: cookie } });
  const { result } = await res.json();
  const empty = result.items.find((it) => it.name === '空的');
  assert.ok(empty, '没有点击的分组应当出现');
  assert.equal(empty.total, 0);
  assert.equal(empty.cells.length, 168);
  assert.ok(empty.cells.every((v) => v === 0));
}));

test('分组时段：回收站里的短链不计入', () => withServer(async (srv) => {
  const cookie = await login(srv);
  const g = await createGroup(srv, cookie, '活动');
  await createLink(srv, cookie, { url: 'https://example.com/x', code: 'xx', group: g.id });
  seedSlots(srv.ctx.store, 'xx', [[2, 8, 4]]);
  const del = await fetch(`${srv.base}/admin/api/links/xx`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(del.status, 200);

  const res = await fetch(`${srv.base}/admin/api/groups/hours`, { headers: { Cookie: cookie } });
  const { result } = await res.json();
  const row = result.items.find((it) => it.name === '活动');
  assert.equal(row.total, 0, '删掉的短链不该还挂在分组的活跃时段里');
}));

test('分组时段：按点击量降序，热的排前面', () => withServer(async (srv) => {
  const cookie = await login(srv);
  const cold = await createGroup(srv, cookie, '冷');
  const hot = await createGroup(srv, cookie, '热');
  await createLink(srv, cookie, { url: 'https://example.com/cold', code: 'cold', group: cold.id });
  await createLink(srv, cookie, { url: 'https://example.com/hot', code: 'hot', group: hot.id });
  seedSlots(srv.ctx.store, 'cold', [[3, 3, 1]]);
  seedSlots(srv.ctx.store, 'hot', [[3, 3, 9]]);
  const res = await fetch(`${srv.base}/admin/api/groups/hours`, { headers: { Cookie: cookie } });
  const { result } = await res.json();
  assert.equal(result.items[0].name, '热');
}));

test('分组趋势：不认识的 group_id 归到「已删除分组」，不让总量凭空少一块', () => withServer(async (srv) => {
  const cookie = await login(srv);
  const g = await createGroup(srv, cookie, '临时');
  await createLink(srv, cookie, { url: 'https://example.com/t', code: 'tt', group: g.id });
  const today = new Date().toISOString().slice(0, 10);
  srv.ctx.store.sql.upsertDaily.run('tt', today, 3);

  const before = await (await fetch(`${srv.base}/admin/api/groups/trend?days=7`, { headers: { Cookie: cookie } })).json();
  assert.equal(before.result.orphanGroup, undefined, '分组还在时不该有孤立段');

  // 直接造一条指向不存在分组的短链：分组被硬删、导入外部数据都会留下这种行
  srv.ctx.store.db.prepare("UPDATE links SET group_id = 9999 WHERE code = 'tt'").run();
  const after = await (await fetch(`${srv.base}/admin/api/groups/trend?days=7`, { headers: { Cookie: cookie } })).json();
  assert.equal(after.result.orphanGroup?.name, '已删除分组');
  // 按日期键逐项比，不按下标取最后一位——服务器本地时区可能已经跨天
  assert.equal(after.result.orphanGroup.daily.find((d) => d.day === today)?.clicks, 3, '今天的 3 次点击要落进孤立段');
  const sum = after.result.total.reduce((s, d) => s + d.clicks, 0);
  const bars = after.result.groups.reduce((s, gg) => s + gg.daily.reduce((a, d) => a + d.clicks, 0), 0)
    + after.result.ungrouped.daily.reduce((a, d) => a + d.clicks, 0)
    + after.result.orphanGroup.daily.reduce((a, d) => a + d.clicks, 0);
  // orphan 段本来就只含孤立数据，跟分组段的总量比没有意义——
  // 真正要守的是「孤立的那 3 次没有从图上消失」
  assert.equal(bars - sum, 3, '孤立段多出来的正好是那 3 次点击');
}));
