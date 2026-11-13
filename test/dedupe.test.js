import test from 'node:test';
import assert from 'node:assert/strict';

import { ClickDeduper } from '../src/services/dedupe.js';
import { startTestServer } from './helpers.js';

test('同一 IP 同一条短链窗口内只算一次', () => {
  const d = new ClickDeduper();
  assert.equal(d.isDuplicate('abc', '1.1.1.1', 60), false);
  assert.equal(d.isDuplicate('abc', '1.1.1.1', 60), true);
  assert.equal(d.isDuplicate('ABC', '1.1.1.1', 60), true, '短码不分大小写');
  assert.equal(d.isDuplicate('abc', '2.2.2.2', 60), false, '换 IP 是新的访问');
  assert.equal(d.isDuplicate('other', '1.1.1.1', 60), false, '换短链是新的访问');
  assert.equal(d.stats().skipped, 2);
});

test('窗口为 0 时不去重', () => {
  const d = new ClickDeduper();
  assert.equal(d.isDuplicate('abc', '1.1.1.1', 0), false);
  assert.equal(d.isDuplicate('abc', '1.1.1.1', 0), false);
  assert.equal(d.stats().skipped, 0);
});

test('窗口过期后重新计数', () => {
  const d = new ClickDeduper();
  d.isDuplicate('abc', '1.1.1.1', 1);
  // 把记录时间往前拨，模拟窗口已过
  d.seenAt.set('abc|1.1.1.1', Date.now() - 5000);
  assert.equal(d.isDuplicate('abc', '1.1.1.1', 1), false);
});

test('条目达到上限时不会无限增长', () => {
  const d = new ClickDeduper({ maxKeys: 10 });
  for (let i = 0; i < 200; i += 1) d.isDuplicate(`c${i}`, `1.1.1.${i}`, 60);
  assert.ok(d.seenAt.size <= 10, `实际 ${d.seenAt.size}`);
});

test('开启去重后点击数按窗口合并，跳转照旧', async () => {
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
    await srv.json('/admin/api/links', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: JSON.stringify({ url: 'https://example.com/dd', code: 'dd1' }),
    });

    srv.ctx.settings.update({ dedupeWindowSec: 60 });
    for (let i = 0; i < 5; i += 1) {
      const r = await srv.fetch('/dd1');
      assert.equal(r.status, 302, '去重不影响跳转');
    }
    await srv.ctx.counter.flush();
    assert.equal(srv.ctx.store.sql.getLinkByCode.get('dd1').clicks, 1);
    assert.equal(srv.ctx.deduper.stats().skipped, 4);

    // 关掉去重后每次点击都记
    srv.ctx.settings.update({ dedupeWindowSec: 0 });
    for (let i = 0; i < 3; i += 1) await srv.fetch('/dd1');
    await srv.ctx.counter.flush();
    assert.equal(srv.ctx.store.sql.getLinkByCode.get('dd1').clicks, 4);

    const health = await srv.json('/health');
    assert.equal(health.body.dedupe.skipped, 4);
    const metrics = await srv.fetch('/metrics');
    assert.match(await metrics.text(), /highurl_clicks_deduped_total 4/);
  } finally {
    await srv.stop();
  }
});

test('去重键取真实 IP（trustProxy 打开时走 X-Forwarded-For）', async () => {
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
    await srv.json('/admin/api/links', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: JSON.stringify({ url: 'https://example.com/px', code: 'px1' }),
    });
    srv.ctx.settings.update({ dedupeWindowSec: 60, trustProxy: true });
    await srv.fetch('/px1', { headers: { 'X-Forwarded-For': '9.9.9.9' } });
    await srv.fetch('/px1', { headers: { 'X-Forwarded-For': '8.8.8.8' } });
    await srv.ctx.counter.flush();
    assert.equal(srv.ctx.store.sql.getLinkByCode.get('px1').clicks, 2, '不同来源 IP 各算一次');
  } finally {
    await srv.stop();
  }
});
