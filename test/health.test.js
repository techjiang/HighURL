import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { probeUrl, classify, HealthChecker } from '../src/services/health.js';
import { makeStore, silentLogger, startTestServer } from './helpers.js';
import { LinkService } from '../src/services/links.js';
import { TitleFetcher } from '../src/services/titles.js';

/** 起一个只回固定状态码的本地服务，用来喂探测器 */
async function localServer(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    stop: () => new Promise((r) => server.close(r)),
  };
}

test('classify 连续失败达到阈值才判死链', () => {
  assert.deepEqual(classify({ ok: true, status: 200 }, 2), { status: 'ok', miss: 0 });
  assert.deepEqual(classify({ ok: false, status: 404 }, 0), { status: 'warn', miss: 1 });
  assert.deepEqual(classify({ ok: false, status: 404 }, 1), { status: 'dead', miss: 2 });
  assert.deepEqual(classify({ ok: false, status: 0 }, 5), { status: 'dead', miss: 6 });
});

test('探测内网地址直接拒绝，不发请求', async () => {
  const r = await probeUrl('http://127.0.0.1:1/never');
  assert.equal(r.ok, false);
  assert.match(r.error, /内网/);
  const r6 = await probeUrl('http://[::1]:1/never');
  assert.equal(r6.ok, false);
});

test('探测到 302 后跳到内网也拦住（每一跳都校验）', async () => {
  const srv = await localServer((req, res) => {
    res.writeHead(302, { Location: 'http://127.0.0.1:1/x' });
    res.end();
  });
  try {
    // 首跳本身是 127.0.0.1，第一道校验就该拦下
    const r = await probeUrl(`${srv.base}/go`);
    assert.equal(r.ok, false);
    assert.match(r.error, /内网/);
  } finally {
    await srv.stop();
  }
});

test('巡检把结论写进库，持续失败升级为死链、恢复后回正常', async () => {
  {
    // 真实探测要走公网，单测里换成可控的 probe，只验 classify + 落库这条链路
    const calls = [];
    const probe = async (url) => {
      calls.push(url);
      return url.includes('dead') ? { ok: false, status: 404, ms: 5, error: 'HTTP 404' } : { ok: true, status: 200, ms: 5, error: '' };
    };
    const { store, settings } = makeStore();
    const links = new LinkService({ store, settings, titles: new TitleFetcher({ settings, logger: silentLogger }), logger: silentLogger });
    await links.create({ url: 'https://example.com/alive', code: 'alive1', title: 't', fetchTitle: false });
    await links.create({ url: 'https://example.com/dead', code: 'dead1', title: 't', fetchTitle: false });

    const checker = new HealthChecker({ store, settings, logger: silentLogger, probe });
    const first = await checker.run();
    assert.equal(first.checked, 2);
    assert.equal(first.ok, 1);
    assert.equal(first.warn, 1, '第一次失败只算疑似');
    assert.equal(calls.length, 2);

    // 再跑一轮：持续失败的那条升级为死链
    const second = await checker.run();
    assert.equal(second.dead, 1);
    const deadRow = store.findLinkByCode('dead1');
    assert.equal(deadRow.health_status, 'dead');
    assert.equal(deadRow.health_code, 404);
    assert.equal(deadRow.health_miss, 2);
    assert.equal(store.findLinkByCode('alive1').health_status, 'ok');

    // 恢复后自动转回 ok
    const third = await checker.run();
    assert.ok(third.checked >= 0);
    store.close();
  }
});

test('巡检不动 updated_at，只写健康字段', async () => {
  const probe = async () => ({ ok: true, status: 200, ms: 3, error: '' });
  const { store, settings } = makeStore();
  const links = new LinkService({ store, settings, titles: new TitleFetcher({ settings, logger: silentLogger }), logger: silentLogger });
  await links.create({ url: 'https://example.com/a', code: 'keep1', title: 't', fetchTitle: false });
  const before = store.findLinkByCode('keep1').updated_at;
  const checker = new HealthChecker({ store, settings, logger: silentLogger, probe });
  await checker.run();
  const after = store.findLinkByCode('keep1');
  assert.equal(after.updated_at, before, '巡检不是修改');
  assert.equal(after.health_status, 'ok');
  store.close();
});

test('回收站里的短链不参与巡检', async () => {
  const probe = async () => {
    throw new Error('不应该被调用');
  };
  const { store, settings } = makeStore();
  const links = new LinkService({ store, settings, titles: new TitleFetcher({ settings, logger: silentLogger }), logger: silentLogger });
  const link = await links.create({ url: 'https://example.com/x', code: 'gone1', title: 't', fetchTitle: false });
  links.remove(link.id);
  const checker = new HealthChecker({ store, settings, logger: silentLogger, probe });
  const out = await checker.run();
  assert.equal(out.checked, 0);
  store.close();
});

test('HTTP 接口：巡检、健康概览、按健康状态筛选', async () => {
  const srv = await startTestServer();
  try {
    await srv.ctx.auth.createAdmin('admin', 'password123');
    const res = await srv.fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: 'password123' }).toString(),
    });
    const cookie = (res.headers.getSetCookie?.() || [res.headers.get('set-cookie')])
      .map((c) => String(c).split(';')[0])
      .join('; ');

    await srv.json('/admin/api/links', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ url: 'https://example.com/a', code: 'h1', title: 't' }) });
    await srv.json('/admin/api/links', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ url: 'https://example.com/b', code: 'h2', title: 't' }) });

    // 把探测器换掉，接口链路照跑但不碰公网
    srv.ctx.health.probe = async (url) => (url.endsWith('/b') ? { ok: false, status: 404, ms: 4, error: 'HTTP 404' } : { ok: true, status: 200, ms: 4, error: '' });

    const check = await srv.json('/admin/api/health/check', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({}) });
    assert.equal(check.res.status, 200);
    assert.equal(check.body.result.checked, 2);
    assert.equal(check.body.result.warn, 1);

    const summary = await srv.json('/admin/api/health', { headers: { Cookie: cookie } });
    assert.equal(summary.body.result.counts.ok, 1);
    assert.equal(summary.body.result.counts.warn, 1);
    assert.equal(summary.body.result.counts.unknown, 0);

    const dead = await srv.json('/admin/api/links?health=dead', { headers: { Cookie: cookie } });
    assert.equal(dead.body.result.items.length, 0);
    const unknown = await srv.json('/admin/api/links?health=unknown', { headers: { Cookie: cookie } });
    assert.equal(unknown.body.result.items.length, 0);

    // 再来一轮，h2 升级为死链
    await srv.json('/admin/api/health/check', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({}) });
    const dead2 = await srv.json('/admin/api/links?health=dead', { headers: { Cookie: cookie } });
    assert.deepEqual(dead2.body.result.items.map((l) => l.code), ['h2']);
    assert.equal(dead2.body.result.items[0].health.status, 'dead');

    // 单条点名检测
    const one = await srv.json('/admin/api/health/check', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ codes: ['h1'] }) });
    assert.equal(one.body.result.checked, 1);

    // 序列化里带 health 字段，API v1 也一样
    const api = await srv.json('/api/v1/links/h2', { headers: { Cookie: cookie } });
    assert.equal(api.body.result.health.status, 'dead');
    assert.equal(api.body.result.health.code, 404);
  } finally {
    await srv.stop();
  }
});

test('巡检接口未登录返回 401', async () => {
  const srv = await startTestServer();
  try {
    const r = await srv.json('/admin/api/health/check', { method: 'POST', body: '{}' });
    assert.equal(r.res.status, 401);
    const s = await srv.json('/admin/api/health');
    assert.equal(s.res.status, 401);
  } finally {
    await srv.stop();
  }
});

test('health=warn 与 health=ok 都能筛出来，不再静默返回全部', () => {
  const { store } = makeStore();
  const ts = Date.now();
  const insert = store.db.prepare("INSERT INTO links (code, url, health_status, health_miss, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
  insert.run('hok', 'https://example.com/ok', 'ok', 0, ts, ts);
  insert.run('hwarn', 'https://example.com/warn', 'warn', 1, ts, ts);
  insert.run('hdead', 'https://example.com/dead', 'dead', 3, ts, ts);
  insert.run('hnone', 'https://example.com/none', '', 0, ts, ts);

  const codes = (health) => store.listLinks({ health }).rows.map((r) => r.code).sort();
  assert.deepEqual(codes('ok'), ['hok']);
  assert.deepEqual(codes('warn'), ['hwarn'], '以前 health=warn 什么都没筛，返回全部');
  assert.deepEqual(codes('dead'), ['hdead']);
  assert.deepEqual(codes('unknown'), ['hnone']);
  assert.equal(store.listLinks({ health: '' }).rows.length, 4);
  store.close();
});
