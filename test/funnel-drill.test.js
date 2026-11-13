import test from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, cleanupTmp } from './helpers.js';
import { hostDrilldown } from '../src/services/funnel.js';

test.after(() => cleanupTmp());

const PASS = 'Passw0rd!23';

async function login(srv) {
  const res = await srv.fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: PASS }),
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
  await srv.ctx.auth.createAdmin('admin', PASS);
  try {
    await fn(srv);
  } finally {
    await srv.stop();
  }
}

function seedLink(store, code, title = '') {
  const now = Date.now();
  store.sql.insertLink.run(code, `https://example.com/${code}`, title, '', '', 'active', null, now, now, null, null);
}

test('下钻：曝光和落地都按同一个渠道过滤', () => withServer(async (srv) => {
  const { store } = srv.ctx;
  seedLink(store, 'dr1');
  seedLink(store, 'dr2');
  // dr1 在 news.example 上被看 100 次、落地 10 次；在 twitter.com 上被看 5 次、落地 4 次
  store.sql.upsertLanding.run('dr1', '2026-01-01', 'news.example', 100);
  store.sql.upsertRef.run('dr1', 'news.example', 10);
  store.sql.upsertLanding.run('dr1', '2026-01-01', 'twitter.com', 5);
  store.sql.upsertRef.run('dr1', 'twitter.com', 4);
  // dr2 只在 news.example 上曝光，一次都没落地
  store.sql.upsertLanding.run('dr2', '2026-01-01', 'news.example', 30);

  const rows = hostDrilldown(store, 'news.example');
  const byCode = Object.fromEntries(rows.map((r) => [r.code, r]));
  assert.equal(byCode.dr1.views, 100);
  assert.equal(byCode.dr1.clicks, 10, '落地必须只算 news.example 的那 10 次，不能把 twitter 的 4 次并进来');
  assert.equal(byCode.dr1.rate, 0.1);
  assert.equal(byCode.dr1.lost, 90);

  assert.equal(byCode.dr2.views, 30);
  assert.equal(byCode.dr2.clicks, 0);
  assert.equal(byCode.dr2.rate, 0);
  assert.equal(byCode.dr2.lost, 30);

  // twitter.com 的视角是另一组数字，说明两边确实都做了过滤
  const tw = hostDrilldown(store, 'twitter.com');
  assert.equal(tw.length, 1);
  assert.equal(tw[0].clicks, 4);
  assert.equal(tw[0].rate, 0.8);
}));

test('下钻：按「没进去」倒序，人多却没往下走的排在前面', () => withServer(async (srv) => {
  const { store } = srv.ctx;
  for (const code of ['a', 'b', 'c']) seedLink(store, code);
  store.sql.upsertLanding.run('a', '2026-01-01', 'h.com', 10);
  store.sql.upsertRef.run('a', 'h.com', 9); // 丢 1
  store.sql.upsertLanding.run('b', '2026-01-01', 'h.com', 200);
  store.sql.upsertRef.run('b', 'h.com', 20); // 丢 180
  store.sql.upsertLanding.run('c', '2026-01-01', 'h.com', 40); // 丢 40
  const rows = hostDrilldown(store, 'h.com');
  assert.deepEqual(rows.map((r) => r.code), ['b', 'c', 'a']);
}));

test('下钻：回收站里的短链不出现', () => withServer(async (srv) => {
  const { store } = srv.ctx;
  seedLink(store, 'trash1');
  store.sql.upsertLanding.run('trash1', '2026-01-01', 'h.com', 50);
  store.sql.softDeleteById.run(Date.now(), Date.now(), store.sql.getLinkByCode.get('trash1').id);
  assert.equal(hostDrilldown(store, 'h.com').length, 0);
}));

test('下钻：没有标题的短链不报错，标题只作展示', () => withServer(async (srv) => {
  const { store } = srv.ctx;
  seedLink(store, 'notitle');
  store.sql.upsertLanding.run('notitle', '2026-01-01', 'h.com', 3);
  const rows = hostDrilldown(store, 'h.com');
  assert.equal(rows[0].title, '');
  assert.equal(rows[0].gone, false);
}));

test('HTTP：/admin/api/funnel?host= 返回该渠道的下钻', () => withServer(async (srv) => {
  const cookie = await login(srv);
  const created = await adminJson(srv, cookie, '/admin/api/links', {
    method: 'POST',
    body: JSON.stringify({ url: 'https://example.com/hx', code: 'hx', fetchTitle: false, interstitial: true }),
  });
  assert.equal(created.res.status, 200, created.text);
  srv.ctx.store.sql.upsertLanding.run('hx', '2026-01-01', 'news.example', 64);
  srv.ctx.store.sql.upsertRef.run('hx', 'news.example', 8);

  const noHost = await adminJson(srv, cookie, '/admin/api/funnel');
  assert.equal(noHost.res.status, 200);
  assert.equal(noHost.body.result.drill, null, '不传 host 就不下钻，省一次全表读');

  const out = await adminJson(srv, cookie, '/admin/api/funnel?host=news.example');
  assert.equal(out.res.status, 200, out.text);
  assert.equal(out.body.result.host, 'news.example');
  const row = out.body.result.drill.find((r) => r.code === 'hx');
  assert.equal(row.views, 64);
  assert.equal(row.clicks, 8);
  assert.equal(row.rate, 0.125);
}));

test('HTTP：渠道里没有数据时返回空数组而不是报错', () => withServer(async (srv) => {
  const cookie = await login(srv);
  const out = await adminJson(srv, cookie, '/admin/api/funnel?host=nobody.example');
  assert.equal(out.res.status, 200);
  assert.deepEqual(out.body.result.drill, []);
}));
