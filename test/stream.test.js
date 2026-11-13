import test from 'node:test';
import assert from 'node:assert/strict';

import { VisitStream, maskIp } from '../src/services/stream.js';
import { startTestServer } from './helpers.js';

test('maskIp 脱敏 IPv4 与 IPv6', () => {
  assert.equal(maskIp('203.0.113.42'), '203.0.113.*');
  assert.equal(maskIp('::ffff:192.168.1.9'), '192.168.1.*', 'IPv4 映射地址先剥前缀');
  assert.equal(maskIp('2001:db8:85a3::8a2e:370:7334'), '2001:db8:…');
  assert.equal(maskIp(''), '');
});

test('环形缓冲只留最新的一批，并统计丢弃数', () => {
  const s = new VisitStream({ max: 3 });
  for (let i = 1; i <= 5; i += 1) s.push({ code: `c${i}`, ip: '1.2.3.4' });
  assert.equal(s.events.length, 3);
  assert.equal(s.recent().map((e) => e.code).join(','), 'c5,c4,c3', '最新的排最前');
  assert.equal(s.stats().dropped, undefined);
  assert.equal(s.dropped, 2);
  assert.equal(s.stats().total, 5);
});

test('没有客户端时 push 不产生任何写操作，且 IP 已在入队前脱敏', () => {
  const s = new VisitStream();
  const ev = s.push({ code: 'abc', ip: '203.0.113.7', ref: 't.co', platform: 'ios' });
  assert.equal(ev.ip, '203.0.113.*');
  assert.equal(s.stats().clients, 0);
});

test('跳转会推进实时流，SSE 接口把历史与新增都发出去', async () => {
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

    await srv.json('/admin/api/links', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ url: 'https://example.com/a', code: 'live', title: 't' }) });
    await srv.fetch('/live', { headers: { Referer: 'https://news.ycombinator.com/item?id=1', 'User-Agent': 'Mozilla/5.0 (iPhone)' } });

    const recent = await srv.json('/admin/api/stream/recent?limit=5', { headers: { Cookie: cookie } });
    assert.equal(recent.res.status, 200);
    const items = recent.body.result.items;
    assert.equal(items.length, 1);
    assert.equal(items[0].code, 'live');
    assert.equal(items[0].ref, 'news.ycombinator.com', 'referer 去掉 www 并只留域名');
    assert.equal(items[0].platform, 'ios');
    assert.equal(items[0].outcome, 'redirect');
    assert.match(items[0].ip, /\*$|…$/, 'IP 必须脱敏');

    // 再点一次，点数是 2（去重默认关闭），流里两条
    await srv.fetch('/live');
    const more = await srv.json('/admin/api/stream/recent?limit=5', { headers: { Cookie: cookie } });
    assert.equal(more.body.result.items.length, 2);
  } finally {
    await srv.stop();
  }
});

test('过期与停用的访问进流时带上对应结果，不伪装成正常跳转', async () => {
  const srv = await startTestServer();
  try {
    await srv.ctx.auth.createAdmin('admin', 'password123');
    const res = await srv.fetch('/login', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: 'password123' }).toString(),
    });
    const cookie = (res.headers.getSetCookie?.() || [res.headers.get('set-cookie')]).map((c) => String(c).split(';')[0]).join('; ');
    await srv.json('/admin/api/links', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ url: 'https://example.com/a', code: 'off1', title: 't' }) });
    // 新建一律是 active，停用得走 PATCH
    await srv.json('/admin/api/links/off1', { method: 'PATCH', headers: { Cookie: cookie }, body: JSON.stringify({ status: 'disabled' }) });
    await srv.fetch('/off1');
    const recent = await srv.json('/admin/api/stream/recent', { headers: { Cookie: cookie } });
    assert.equal(recent.body.result.items[0].outcome, 'disabled');
  } finally {
    await srv.stop();
  }
});

test('实时流接口需要登录', async () => {
  const srv = await startTestServer();
  try {
    const r = await srv.json('/admin/api/stream/recent');
    assert.equal(r.res.status, 401);
  } finally {
    await srv.stop();
  }
});
