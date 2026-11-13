import test from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, cleanupTmp } from './helpers.js';
import { parseLanding } from '../src/services/links.js';
import { normalizeQrStyle, parseQrStyle, accentOfStyle } from '../src/services/qr-style.js';
import { landingMode } from '../src/routes/redirect.js';

test.after(() => cleanupTmp());

async function login(srv) {
  const res = await srv.fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'Passw0rd!23' }),
  });
  return String(res.headers.get('set-cookie') || '').split(';')[0];
}

/** 管理台写接口走 JSON，直接 fetch 没带 Content-Type 会被当成表单体解析 */
/** 读接口：带上会话 Cookie，否则 401 的响应体里没有 result */
async function adminGet(srv, cookie, pathname) {
  const res = await srv.fetch(pathname, { headers: { Cookie: cookie } });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { res, body, text };
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

async function withServer(fn, overrides = {}) {
  const srv = await startTestServer({ titleFetch: false, ...overrides });
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
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return JSON.parse(text).result;
}

test('建页：开启后落在介绍页，必须点一次才跳转', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/a/b', code: 'lp1', title: '示例页面', interstitial: true });

  const res = await srv.fetch('/lp1');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /example\.com/, '域名要出现在页面上');
  assert.match(html, /示例页面/, '标题要出现');
  assert.match(html, /继续访问/);
  // 目标地址不能直接挂在 href 上，否则预取、扫描、爬虫会顺手点走
  assert.ok(!html.includes('href="https://example.com/a/b"'), '目标地址不应作为链接出现');
  assert.match(html, /action="\/lp1"/);
  assert.match(html, /name="go" value="1"/);

  // 点了「继续访问」才真的 302
  const go = await srv.fetch('/lp1?go=1');
  assert.equal(go.status, 302);
  assert.equal(go.headers.get('location'), 'https://example.com/a/b');
}));

test('建页：默认关闭，未开启时一条请求直接跳', () => withServer(async (srv) => {
  const cookie = await login(srv);
  const link = await createLink(srv, cookie, { url: 'https://example.com/direct', code: 'lp2' });
  assert.equal(link.landing.enabled, false);
  const res = await srv.fetch('/lp2');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://example.com/direct');
}));

test('建页：站点默认值只在创建时生效，之后改设置不动存量', () => withServer(async (srv) => {
  const cookie = await login(srv);
  const old = await createLink(srv, cookie, { url: 'https://example.com/old', code: 'lp3' });
  assert.equal(old.landing.enabled, false);

  const patch = await adminJson(srv, cookie, '/admin/api/settings', { method: 'PATCH', body: JSON.stringify({ interstitialDefault: true }) });
  assert.equal(patch.res.status, 200);

  const fresh = await createLink(srv, cookie, { url: 'https://example.com/new', code: 'lp4' });
  assert.equal(fresh.landing.enabled, true, '新建的跟随站点默认值');

  // 老的：建的时候没开，就不该被悄悄改掉行为
  const oldAgain = await adminJson(srv, cookie, '/admin/api/links/lp3');
  assert.equal(oldAgain.body.result.landing.enabled, false);
}));

test('建页：单条显式关闭可以覆盖站点默认', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await adminJson(srv, cookie, '/admin/api/settings', { method: 'PATCH', body: JSON.stringify({ interstitialDefault: true }) });
  const link = await createLink(srv, cookie, { url: 'https://example.com/x', code: 'lp5', interstitial: false });
  assert.equal(link.landing.enabled, false);
}));

test('建页：分开设置开关、主题与说明，且不需要重传目标地址', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/t', code: 'lp6' });

  const res = await adminJson(srv, cookie, '/admin/api/links/lp6/landing', { method: 'PATCH', body: JSON.stringify({ enabled: true, theme: 'light', note: '本周活动专用' }) });
  assert.equal(res.res.status, 200);
  assert.deepEqual(res.body.result.landing, { enabled: true, theme: 'light', note: '本周活动专用' });
  assert.equal(res.body.result.url, 'https://example.com/t', '目标地址不该被清空');

  const html = await (await srv.fetch('/lp6')).text();
  assert.match(html, /data-theme="light"/);
  assert.match(html, /本周活动专用/);
}));

test('建页：未知主题回落到 auto，而不是写进一个坏值', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/t2', code: 'lp7' });
  const res = await adminJson(srv, cookie, '/admin/api/links/lp7/landing', { method: 'PATCH', body: JSON.stringify({ enabled: true, theme: 'neon' }) });
  assert.equal(res.body.result.landing.theme, 'auto');
}));

test('建页：过期与停用的链在介绍页上说清原因，而不是给一屏 404', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/exp', code: 'lp8', expireAt: Date.now() - 1000, interstitial: true });
  const expired = await srv.fetch('/lp8');
  assert.equal(expired.status, 200);
  const html = await expired.text();
  assert.match(html, /超过有效期/);
  assert.ok(!html.includes('继续访问'), '过期的链不给继续访问按钮');

  await createLink(srv, cookie, { url: 'https://example.com/off', code: 'lp9', interstitial: true });
  await adminJson(srv, cookie, '/admin/api/links/lp9', { method: 'PATCH', body: JSON.stringify({ status: 'disabled' }) });
  const off = await (await srv.fetch('/lp9')).text();
  assert.match(off, /已被管理员停用/);
}));

test('建页：?go=1 之外的多余参数照常透传给目标，不会被吞掉', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/p?x=1', code: 'lpa', interstitial: true });
  const res = await srv.fetch('/lpa?go=1&utm=abc');
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('location'));
  assert.equal(loc.searchParams.get('x'), '1');
  assert.equal(loc.searchParams.get('utm'), 'abc');
  assert.equal(loc.searchParams.get('go'), null, 'go 只是放行标记，不该带给目标站点');
}));

test('建页：计数发生在真正跳转时，介绍页本身不计', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/c', code: 'lpb', interstitial: true });
  await srv.fetch('/lpb');
  await srv.fetch('/lpb');
  await srv.ctx.counter.flush();
  const before = await adminJson(srv, cookie, '/admin/api/links/lpb');
  assert.equal(before.body.result.clicks, 0, '只是看了介绍页，不算访问');

  await srv.fetch('/lpb?go=1');
  await srv.ctx.counter.flush();
  const after = await adminGet(srv, cookie, '/admin/api/links/lpb');
  assert.equal(after.body.result.clicks, 1);
}));

test('建页：密码保护仍要先过密码，不能靠 ?go=1 绕过', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/sec', code: 'lpc', interstitial: true });
  await adminJson(srv, cookie, '/admin/api/links/lpc/password', { method: 'POST', body: JSON.stringify({ password: 'secret123' }) });
  const res = await srv.fetch('/lpc?go=1');
  assert.equal(res.status, 401, '没解锁就该是密码页');
}));

test('parseLanding：三种写法都认，没表态时返回空对象', () => {
  assert.deepEqual(parseLanding({ landing: false }), { enabled: false });
  assert.deepEqual(parseLanding({ landing: { enabled: true, theme: 'dark', note: 'n' } }), { enabled: true, theme: 'dark', note: 'n' });
  assert.deepEqual(parseLanding({ interstitial: 1, landingTheme: 'light', interstitialNote: 'hi' }), { enabled: true, theme: 'light', note: 'hi' });
  assert.deepEqual(parseLanding({}), {});
  assert.deepEqual(parseLanding(null), {});
  // 未知主题忽略，不写坏值
  assert.deepEqual(parseLanding({ landing: { theme: 'neon' } }), {});
  // 说明截断，避免把一列 TEXT 灌满
  assert.equal(parseLanding({ interstitialNote: 'x'.repeat(500) }).note.length, 200);
});

test('landingMode：1 开、0 关、其余都算关', () => {
  assert.equal(landingMode({ interstitial: 1 }), true);
  assert.equal(landingMode({ interstitial: 0 }), false);
  assert.equal(landingMode({ interstitial: null }), false);
  assert.equal(landingMode({}), false);
});

test('normalizeQrStyle：白名单收字段，坏值当场拒绝', () => {
  assert.equal(normalizeQrStyle(null), '');
  assert.equal(normalizeQrStyle({}), '');

  const json = normalizeQrStyle({ preset: 'brand', dotStyle: 'dots', ecc: 'h', light: 'transparent' });
  assert.deepEqual(JSON.parse(json), { preset: 'brand', dotStyle: 'dots', light: 'transparent', ecc: 'H' });

  // 颜色不带 # 也认，统一补成规范形式
  assert.deepEqual(parseQrStyle(normalizeQrStyle({ dark: 'ff0000' })), { dark: '#ff0000' });
  assert.deepEqual(parseQrStyle(normalizeQrStyle({ gradient: ['#8b5cf6', '22d3ee'] })), { gradient: ['#8b5cf6', '#22d3ee'] });

  assert.throws(() => normalizeQrStyle({ preset: 'nope' }), /未知的二维码预设/);
  assert.throws(() => normalizeQrStyle({ dotStyle: 'stars' }), /未知的码点形状/);
  assert.throws(() => normalizeQrStyle({ dark: 'red-ish' }), /不是合法颜色/);
  assert.throws(() => normalizeQrStyle({ ecc: 'X' }), /纠错等级/);
  assert.throws(() => normalizeQrStyle('{bad json'), /不是合法的 JSON/);
  assert.throws(() => normalizeQrStyle('[1,2]'), /必须是对象/);
});

test('二维码样式按短链记住，并跟随短链导出', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/q', code: 'qrs1' });

  const put = await adminJson(srv, cookie, '/admin/api/links/qrs1/qr-style', { method: 'PUT', body: JSON.stringify({ qrStyle: { preset: 'sticker', dotStyle: 'dots' } }) });
  assert.equal(put.res.status, 200);
  assert.deepEqual(put.body.result.qrStyle, { preset: 'sticker', dotStyle: 'dots' });

  const list = await adminJson(srv, cookie, '/admin/api/qr/styles');
  assert.deepEqual(list.body.result.styles.qrs1, { preset: 'sticker', dotStyle: 'dots' });

  // 详情里也要带上，前端打开弹窗时直接就是上次那套
  const detail = await adminGet(srv, cookie, '/admin/api/links/qrs1');
  assert.deepEqual(detail.body.result.qrStyle, { preset: 'sticker', dotStyle: 'dots' });

  // 清空
  const clear = await adminJson(srv, cookie, '/admin/api/links/qrs1/qr-style', { method: 'PUT', body: JSON.stringify({ qrStyle: null }) });
  assert.equal(clear.body.result.qrStyle, null);
  const after = await adminJson(srv, cookie, '/admin/api/qr/styles');
  assert.equal(after.body.result.styles.qrs1, undefined);
}));

test('二维码样式写入非法值返回 400，且不改动已有样式', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/q2', code: 'qrs2', qrStyle: { preset: 'classic' } });
  const bad = await adminJson(srv, cookie, '/admin/api/links/qrs2/qr-style', { method: 'PUT', body: JSON.stringify({ qrStyle: { dotStyle: 'stars' } }) });
  assert.equal(bad.res.status, 400);
  const detail = await adminGet(srv, cookie, '/admin/api/links/qrs2');
  assert.deepEqual(detail.body.result.qrStyle, { preset: 'classic' });
}));

test('accentOfStyle：优先渐变起点，白码点不当强调色', () => {
  assert.equal(accentOfStyle('{"gradient":["#8b5cf6","#22d3ee"]}'), '#8b5cf6');
  assert.equal(accentOfStyle('{"dark":"#0f766e"}'), '#0f766e');
  assert.equal(accentOfStyle('{"dark":"#ffffff"}'), '#8b5cf6');
  assert.equal(accentOfStyle(''), '#8b5cf6');
  assert.equal(accentOfStyle('not json'), '#8b5cf6');
});
