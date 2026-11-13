import test from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, cleanupTmp } from './helpers.js';
import { expireText } from '../src/pages/preview.js';

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

async function createLink(srv, cookie, body) {
  const res = await fetch(`${srv.base}/admin/api/links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ fetchTitle: false, ...body }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).result;
}

test('名片页：露出目标地址、二维码与元信息，且不计数', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/very/long/path?utm=x', code: 'demo', title: '示例站点' });

  const res = await srv.fetch('/demo+');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /示例站点/);
  assert.match(html, /example\.com\/very\/long\/path/, '目标地址要看得见，名片页的意义就在这');
  assert.match(html, /preview-qr[^>]*><svg[^>]*viewBox/, '二维码要真的渲染出来，不能是被转义成文本的 <img>');
  assert.match(html, /noindex/, '名片页不该被搜索引擎收录');

  // 名片页不是访问：点开它不该让点击数涨起来
  const row = srv.ctx.store.findLinkByCode('demo');
  assert.equal(row.clicks, 0);
}));

test('名片页：密码保护的链不露出目标地址', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await createLink(srv, cookie, { url: 'https://secret.example.com/x', code: 'lock' });
  const res = await fetch(`${srv.base}/admin/api/links/lock/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ password: 'p@ssw0rd' }),
  });
  assert.equal(res.status, 200);

  const html = await (await srv.fetch('/lock+')).text();
  assert.doesNotMatch(html, /secret\.example\.com/, '要密码才能看的东西不能印在名片上');
  assert.match(html, /受密码保护/);
}));

test('名片页：短码不存在时回到 404，而不是空白页', () => withServer(async (srv) => {
  const res = await srv.fetch('/nothing-here+');
  assert.equal(res.status, 404);
}));

test('名片页：停用的短链仍能看到目标，方便排查「这条链为什么打不开」', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/off', code: 'off' });
  await fetch(`${srv.base}/admin/api/links/off`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ status: 'disabled' }),
  });
  const res = await srv.fetch('/off+');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /example\.com\/off/);
}));

test('名片页：跳转本身不受影响，路径仍然是短链', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/plain', code: 'plain' });
  const res = await srv.fetch('/plain');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://example.com/plain');
}));

test('expireText：说人话，而不是丢个时间戳', () => {
  const now = new Date(2026, 10, 13, 12, 0, 0).getTime();
  assert.equal(expireText(now - 1000, now), '已过期');
  assert.equal(expireText(now + 3 * 86400000, now), '还有 3 天到期');
  assert.equal(expireText(now + 5 * 3600000, now), '还有 5 小时到期');
  assert.equal(expireText(now + 60000, now), '不到 1 小时到期');
  assert.equal(expireText(null, now), '');
});
