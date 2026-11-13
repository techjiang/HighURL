import test from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer } from './helpers.js';

async function withServer(fn, overrides = {}) {
  const srv = await startTestServer(overrides);
  try {
    return await fn(srv);
  } finally {
    await srv.stop();
  }
}

/** 建管理员并拿到会话 Cookie */
async function login(srv, username = 'admin', password = 'password123') {
  if (!srv.ctx.auth.hasAdmin()) srv.ctx.auth.createAdmin(username, password);
  const res = await srv.fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }).toString(),
  });
  const cookie = (res.headers.getSetCookie?.() || [res.headers.get('set-cookie')])
    .map((c) => String(c).split(';')[0])
    .join('; ');
  return { cookie, res };
}

async function createLink(srv, cookie, body) {
  const { res, body: json } = await srv.json('/admin/api/links', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify(body),
  });
  return { res, json };
}

test('首页与静态资源可访问', () => withServer(async (srv) => {
  const home = await srv.fetch('/');
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /HighURL/);
  assert.match(html, /功能特点/);

  const css = await srv.fetch('/static/app.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  assert.ok(Number(css.headers.get('etag') ? 1 : 0) === 1);

  // ETag 命中应返回 304
  const etag = css.headers.get('etag');
  const cached = await srv.fetch('/static/app.css', { headers: { 'If-None-Match': etag } });
  assert.equal(cached.status, 304);

  assert.equal((await srv.fetch('/docs')).status, 200);
  const favicon = await srv.fetch('/favicon.ico');
  assert.equal(favicon.status, 301);
  assert.equal(favicon.headers.get('location'), '/img/favicon.ico');
  assert.equal((await srv.fetch('/img/favicon.ico')).status, 200);
  assert.equal((await srv.fetch('/img/logo.svg')).status, 200);
}));

test('/health 与 /metrics 输出结构正确', () => withServer(async (srv) => {
  const health = await srv.json('/health');
  assert.equal(health.res.status, 200);
  assert.equal(health.body.status, 'ok');
  assert.ok(health.body.uptime >= 0);
  assert.ok('counters' in health.body);

  const metrics = await srv.fetch('/metrics');
  assert.equal(metrics.status, 200);
  const text = await metrics.text();
  assert.match(text, /highurl_links_total \d+/);
  assert.match(text, /highurl_clicks_pending \d+/);
}));

test('未初始化时 /admin 跳转 /install，初始化后跳 /login', () => withServer(async (srv) => {
  const first = await srv.fetch('/admin');
  assert.equal(first.status, 302);
  assert.ok(first.headers.get('location').endsWith('/install'));

  srv.ctx.auth.createAdmin('admin', 'password123');
  const second = await srv.fetch('/admin');
  assert.equal(second.status, 302);
  assert.ok(second.headers.get('location').endsWith('/login'));
}));

test('安装页创建管理员并可直接登录', () => withServer(async (srv) => {
  const res = await srv.fetch('/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'root', password: 'password123', siteName: '我的短链' }).toString(),
  });
  assert.equal(res.status, 303);
  assert.ok(res.headers.get('set-cookie'));
  assert.equal(srv.ctx.auth.hasAdmin(), true);
  assert.equal(srv.ctx.settings.get('siteName'), '我的短链');

  // 已初始化后禁止再装
  const again = await srv.fetch('/install', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=x&password=yyyyyyyy' });
  assert.equal(again.status, 403);
}));

test('登录失败返回 401，成功后可访问管理台', () => withServer(async (srv) => {
  srv.ctx.auth.createAdmin('admin', 'password123');
  const bad = await srv.fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=admin&password=wrong-pass',
  });
  assert.equal(bad.status, 401);

  const { cookie } = await login(srv);
  const me = await srv.json('/admin/api/me', { headers: { Cookie: cookie } });
  assert.equal(me.body.result.username, 'admin');

  const admin = await srv.fetch('/admin', { headers: { Cookie: cookie } });
  assert.equal(admin.status, 200);
}));

test('未登录访问管理 API 返回 401', () => withServer(async (srv) => {
  srv.ctx.auth.createAdmin('admin', 'password123');
  const { res, body } = await srv.json('/admin/api/overview');
  assert.equal(res.status, 401);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'unauthorized');
}));

test('创建短链并跳转，子路径与 query 透传', () => withServer(async (srv) => {
  const { cookie } = await login(srv);
  const { res, json } = await createLink(srv, cookie, { url: 'https://example.com/base', code: 'go1' });
  assert.equal(res.status, 200);
  assert.equal(json.result.code, 'go1');
  assert.ok(json.result.shortUrl.endsWith('/go1'));

  const jump = await srv.fetch('/go1');
  assert.equal(jump.status, 302);
  assert.equal(jump.headers.get('location'), 'https://example.com/base');

  const withPath = await srv.fetch('/go1/docs/intro?a=1&b=2');
  assert.equal(withPath.status, 302);
  assert.equal(withPath.headers.get('location'), 'https://example.com/base/docs/intro?a=1&b=2');
}));

test('跳转状态码可配置为 301', () => withServer(async (srv) => {
  const { cookie } = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com', code: 'c301' });
  srv.ctx.settings.update({ redirectStatus: 301 });
  const jump = await srv.fetch('/c301');
  assert.equal(jump.status, 301);
  srv.ctx.settings.update({ redirectStatus: 302 });
}));

test('不存在的短码返回 404 页面', () => withServer(async (srv) => {
  const res = await srv.fetch('/nothing-here');
  assert.equal(res.status, 404);
  assert.match(await res.text(), /短链接不存在/);
}));

test('停用与过期短链分别返回 404 / 410', () => withServer(async (srv) => {
  const { cookie } = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com', code: 'off1' });
  await srv.json('/admin/api/links/off1', {
    method: 'PATCH',
    headers: { Cookie: cookie },
    body: JSON.stringify({ status: 'disabled' }),
  });
  assert.equal((await srv.fetch('/off1')).status, 404);

  await createLink(srv, cookie, { url: 'https://example.com', code: 'exp1', expireAt: Date.now() - 1000 });
  assert.equal((await srv.fetch('/exp1')).status, 410);
}));

test('点击计数在跳转后落库（含来源与平台）', () => withServer(async (srv) => {
  const { cookie } = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com', code: 'hit1' });
  await srv.fetch('/hit1', { headers: { Referer: 'https://t.co/abc', 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' } });
  await srv.fetch('/hit1');
  await srv.ctx.counter.flush();
  const link = srv.ctx.store.sql.getLinkByCode.get('hit1');
  assert.equal(link.clicks, 2);
  const refs = srv.ctx.store.sql.linkRefs.all('hit1', 5);
  assert.equal(refs[0].host, 't.co');
  const agents = srv.ctx.store.sql.linkAgents.all('hit1', 5);
  assert.equal(agents[0].platform, 'ios');
}));

test('API Key 鉴权：读、写、scope 与停用', () => withServer(async (srv) => {
  const { cookie } = await login(srv);
  const readOnly = srv.ctx.auth.createKey('只读脚本', 'read');
  const writeKey = srv.ctx.auth.createKey('CI 脚本', 'read,write');

  const created = await srv.json('/api/v1/links', {
    method: 'POST',
    headers: { Authorization: `Bearer ${writeKey.key}` },
    body: JSON.stringify({ url: 'https://example.com/api', code: 'api1' }),
  });
  assert.equal(created.res.status, 201);

  const list = await srv.json('/api/v1/links', { headers: { Authorization: `Bearer ${readOnly.key}` } });
  assert.equal(list.res.status, 200);
  assert.equal(list.body.result.total, 1);

  const denied = await srv.json('/api/v1/links', {
    method: 'POST',
    headers: { Authorization: `Bearer ${readOnly.key}` },
    body: JSON.stringify({ url: 'https://example.com/x' }),
  });
  assert.equal(denied.res.status, 403);
  assert.equal(denied.body.error.code, 'insufficient_scope');

  const bad = await srv.json('/api/v1/links', { headers: { Authorization: 'Bearer hu_not-a-real-key' } });
  assert.equal(bad.res.status, 401);

  // x-api-key 头也支持
  const viaHeader = await srv.json('/api/v1/links', { headers: { 'X-API-Key': readOnly.key } });
  assert.equal(viaHeader.res.status, 200);

  // 删除后失效
  srv.ctx.store.sql.deleteKey.run(writeKey.id);
  const after = await srv.json('/api/v1/links', { headers: { Authorization: `Bearer ${writeKey.key}` } });
  assert.equal(after.res.status, 401);
  assert.ok(cookie);
}));

test('API 修改与删除短链', () => withServer(async (srv) => {
  const { cookie } = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com', code: 'm1' });
  const key = srv.ctx.auth.createKey('脚本', 'read,write');

  const patched = await srv.json('/api/v1/links/m1', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${key.key}` },
    body: JSON.stringify({ url: 'https://example.com/v2', tags: ['a', 'b'] }),
  });
  assert.equal(patched.res.status, 200);
  assert.equal(patched.body.result.url, 'https://example.com/v2');
  assert.deepEqual(patched.body.result.tags, ['a', 'b']);

  const removed = await srv.json('/api/v1/links/m1', { method: 'DELETE', headers: { Authorization: `Bearer ${key.key}` } });
  assert.equal(removed.res.status, 200);
  assert.equal(removed.body.deleted, 'm1');
  assert.equal((await srv.fetch('/m1')).status, 404);
}));

test('API 统计接口返回按天序列', () => withServer(async (srv) => {
  const { cookie } = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com', code: 'st1' });
  await srv.fetch('/st1');
  await srv.ctx.counter.flush();
  const key = srv.ctx.auth.createKey('r', 'read');
  const { res, body } = await srv.json('/api/v1/links/st1/stats?days=7', { headers: { Authorization: `Bearer ${key.key}` } });
  assert.equal(res.status, 200);
  assert.equal(body.result.daily.length, 7);
  assert.equal(body.result.clicks, 1);
}));

test('短码唯一性与保留字校验', () => withServer(async (srv) => {
  const { cookie } = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com', code: 'dup1' });
  const conflict = await createLink(srv, cookie, { url: 'https://example.com/2', code: 'dup1' });
  assert.equal(conflict.res.status, 409);
  assert.equal(conflict.json.error.code, 'code_taken');

  const reserved = await createLink(srv, cookie, { url: 'https://example.com/2', code: 'api' });
  assert.equal(reserved.res.status, 409);
  assert.equal(reserved.json.error.code, 'code_reserved');

  const invalid = await createLink(srv, cookie, { url: 'javascript:alert(1)' });
  assert.equal(invalid.res.status, 400);
}));

test('CSRF：跨站 Origin 的写操作被拒', () => withServer(async (srv) => {
  const { cookie } = await login(srv);
  const res = await srv.json('/admin/api/links', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: 'https://evil.example' },
    body: JSON.stringify({ url: 'https://example.com' }),
  });
  assert.equal(res.res.status, 403);
  assert.equal(res.body.error.code, 'origin_mismatch');
}));

test('密码保护短链：401 → 提交密码 → 带 Cookie 跳转', () => withServer(async (srv) => {
  const { cookie } = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/secret', code: 'sec1' });
  const setPwd = await srv.json('/admin/api/links/sec1/password', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ password: 'letmein' }),
  });
  assert.equal(setPwd.res.status, 200);
  assert.equal(setPwd.body.result.protected, true);

  const locked = await srv.fetch('/sec1');
  assert.equal(locked.status, 401);
  assert.match(await locked.text(), /密码保护/);

  const wrong = await srv.fetch('/sec1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=nope',
  });
  assert.equal(wrong.status, 401);

  const ok = await srv.fetch('/sec1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=letmein',
  });
  assert.equal(ok.status, 302);
  const accessCookie = String(ok.headers.get('set-cookie')).split(';')[0];

  const unlocked = await srv.fetch('/sec1', { headers: { Cookie: accessCookie } });
  assert.equal(unlocked.status, 302);
  assert.equal(unlocked.headers.get('location'), 'https://example.com/secret');
}));

test('UA 屏蔽规则命中返回 403', () => withServer(async (srv) => {
  const { cookie } = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com', code: 'blk1' });
  await srv.json('/admin/api/rules', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ kind: 'ua', pattern: '*EvilBot*', note: '恶意爬虫' }),
  });
  const blocked = await srv.fetch('/blk1', { headers: { 'User-Agent': 'EvilBot/1.0' } });
  assert.equal(blocked.status, 403);
  assert.match(await blocked.text(), /访问已被拦截/);

  const allowed = await srv.fetch('/blk1', { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120' } });
  assert.equal(allowed.status, 302);
}));

test('公开创建开关生效', () => withServer(async (srv) => {
  const off = await srv.json('/api/shorten', { method: 'POST', body: JSON.stringify({ url: 'https://example.com' }) });
  assert.equal(off.res.status, 403);

  srv.ctx.settings.update({ publicCreate: true });
  const on = await srv.json('/api/shorten', { method: 'POST', body: JSON.stringify({ url: 'https://example.com/open' }) });
  assert.equal(on.res.status, 201);
  assert.ok(on.body.result.shortUrl);

  const home = await srv.fetch('/');
  assert.match(await home.text(), /shorten-form/);
}));

test('二维码 SVG 与 CSV 导出', () => withServer(async (srv) => {
  const { cookie } = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/qr', code: 'qr1', title: '二维码' });

  const qr = await srv.fetch('/admin/api/qr.svg?text=https%3A%2F%2Fs.example.com%2Fqr1', { headers: { Cookie: cookie } });
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await qr.text(), /<svg/);

  const csv = await srv.fetch('/admin/api/export.csv', { headers: { Cookie: cookie } });
  assert.equal(csv.status, 200);
  const buf = Buffer.from(await csv.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'CSV 应带 UTF-8 BOM');
  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  assert.match(text, /^code,url,title/);
  assert.match(text, /qr1/);
}));

test('JSON 备份导出与恢复', () => withServer(async (srv) => {
  const { cookie } = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/b1', code: 'bk1', title: '备份一' });
  await srv.fetch('/bk1');
  await srv.ctx.counter.flush();

  const backup = await srv.fetch('/admin/api/backup', { headers: { Cookie: cookie } });
  assert.equal(backup.status, 200);
  const content = await backup.text();
  const parsed = JSON.parse(content);
  assert.equal(parsed.links.length, 1);
  assert.equal(parsed.links[0].code, 'bk1');

  // 删掉再恢复
  await srv.json('/admin/api/links/bk1', { method: 'DELETE', headers: { Cookie: cookie } });
  const restore = await srv.json('/admin/api/restore', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ content, mode: 'merge' }),
  });
  assert.equal(restore.res.status, 200);
  assert.equal(restore.body.result.restored, 1);
  assert.equal((await srv.fetch('/bk1')).status, 302);
}));

test('SQL 备份是合法 gzip', () => withServer(async (srv) => {
  const { cookie } = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com', code: 'sq1' });
  const res = await srv.fetch('/admin/api/backup/sql', { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /\.sql\.gz/);
  const buf = Buffer.from(await res.arrayBuffer());
  const zlib = await import('node:zlib');
  const sql = zlib.gunzipSync(buf).toString('utf8');
  assert.match(sql, /CREATE TABLE/);
  assert.match(sql, /sq1/);
}));

test('迁移预览与导入（YOURLS dump）', () => withServer(async (srv) => {
  const { cookie } = await login(srv);
  const dump = `INSERT INTO \`yourls_url\` VALUES ('https://example.com/old','old1','旧链接','2024-01-02 03:04:05','1.2.3.4',99);`;

  const preview = await srv.json('/admin/api/migrate/preview', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ content: dump, filename: 'yourls.sql' }),
  });
  assert.equal(preview.res.status, 200);
  assert.equal(preview.body.result.format, 'yourls');
  assert.equal(preview.body.result.willImport, 1);

  const apply = await srv.json('/admin/api/migrate/apply', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ content: dump, filename: 'yourls.sql' }),
  });
  assert.equal(apply.res.status, 200);
  assert.equal(apply.body.result.created, 1);

  const jump = await srv.fetch('/old1');
  assert.equal(jump.status, 302);
  assert.equal(srv.ctx.store.sql.getLinkByCode.get('old1').clicks, 99);
}));

test('设置更新走白名单校验', () => withServer(async (srv) => {
  const { cookie } = await login(srv);
  const ok = await srv.json('/admin/api/settings', {
    method: 'PATCH',
    headers: { Cookie: cookie },
    body: JSON.stringify({ siteName: '短链站', redirectStatus: 301, codeLength: 8 }),
  });
  assert.equal(ok.res.status, 200);
  assert.equal(srv.ctx.settings.get('siteName'), '短链站');
  assert.equal(srv.ctx.settings.get('redirectStatus'), 301);
  assert.equal(srv.ctx.settings.get('codeLength'), 8);

  const bad = await srv.json('/admin/api/settings', {
    method: 'PATCH',
    headers: { Cookie: cookie },
    body: JSON.stringify({ redirectStatus: 999, evilKey: 'x' }),
  });
  assert.equal(bad.res.status, 200);
  assert.equal(srv.ctx.settings.get('redirectStatus'), 301, '非法值不应写入');
}));

test('概览接口返回 KPI 与趋势', () => withServer(async (srv) => {
  const { cookie } = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com', code: 'ov1' });
  await srv.fetch('/ov1');
  await srv.ctx.counter.flush();
  const { body } = await srv.json('/admin/api/overview', { headers: { Cookie: cookie } });
  assert.equal(body.result.total, 1);
  assert.equal(body.result.clicks, 1);
  assert.ok(Array.isArray(body.result.daily));
  assert.ok(Array.isArray(body.result.top));
  assert.ok(body.result.counter);
  assert.ok(body.result.cache);
}));

test('robots.txt 与 sitemap.xml 输出', () => withServer(async (srv) => {
  const { cookie } = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com', code: 'sm1' });
  const robots = await srv.fetch('/robots.txt');
  assert.equal(robots.status, 200);
  assert.match(await robots.text(), /Sitemap:/);

  const sitemap = await srv.fetch('/sitemap.xml');
  assert.equal(sitemap.status, 200);
  assert.match(await sitemap.text(), /\/sm1<\/loc>/);
}));

test('changing password 后旧会话仍有效但需新密码登录', () => withServer(async (srv) => {
  const { cookie } = await login(srv);
  const res = await srv.json('/admin/api/password', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ oldPassword: 'password123', newPassword: 'newpassword456' }),
  });
  assert.equal(res.res.status, 200);

  const oldLogin = await srv.fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=admin&password=password123',
  });
  assert.equal(oldLogin.status, 401);

  const newLogin = await srv.fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=admin&password=newpassword456',
  });
  assert.equal(newLogin.status, 303);
}));

test('限流触发 429', () => withServer(async (srv) => {
  srv.ctx.settings.update({ rateLimitPerMinute: 5 });
  srv.ctx.limiter.max = 5;
  let blocked = 0;
  for (let i = 0; i < 12; i += 1) {
    const res = await srv.fetch('/health');
    if (res.status === 429) blocked += 1;
  }
  assert.ok(blocked > 0, '超过阈值后应返回 429');
}));

test('API 请求错误返回 JSON 而非 HTML', () => withServer(async (srv) => {
  const { res, body } = await srv.json('/api/v1/links/notexist');
  assert.equal(res.status, 401);
  assert.equal(body.ok, false);

  const key = srv.ctx.auth.createKey('r', 'read');
  const missing = await srv.json('/api/v1/links/notexist', { headers: { Authorization: `Bearer ${key.key}` } });
  assert.equal(missing.res.status, 404);
  assert.equal(missing.body.error.code, 'link_not_found');
}));

test('标签筛选与标签计数', () => withServer(async (srv) => {
  const { cookie } = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/1', code: 'tag1', tags: '推广,活动' });
  await createLink(srv, cookie, { url: 'https://example.com/2', code: 'tag2', tags: '文档' });

  const all = await srv.json('/admin/api/links', { headers: { Cookie: cookie } });
  const tags = all.body.result.tags.map((t) => t.tag);
  assert.deepEqual(tags.sort(), ['活动', '推广', '文档'].sort());

  const filtered = await srv.json(`/admin/api/links?tag=${encodeURIComponent('推广')}`, { headers: { Cookie: cookie } });
  assert.equal(filtered.body.result.total, 1);
  assert.equal(filtered.body.result.items[0].code, 'tag1');

  const none = await srv.json(`/admin/api/links?tag=${encodeURIComponent('不存在')}`, { headers: { Cookie: cookie } });
  assert.equal(none.body.result.total, 0);
  // 标签过滤不能把 % 当通配符吃掉
  const wildcard = await srv.json('/admin/api/links?tag=%25', { headers: { Cookie: cookie } });
  assert.equal(wildcard.body.result.total, 0);
}));

test('批量启停与批量删除', () => withServer(async (srv) => {
  const { cookie } = await login(srv);
  for (const code of ['b1', 'b2', 'b3']) await createLink(srv, cookie, { url: `https://example.com/${code}`, code });

  const disabled = await srv.json('/admin/api/links/batch', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ action: 'disable', codes: ['b1', 'b2', 'ghost'] }),
  });
  assert.equal(disabled.body.result.affected, 2);
  assert.deepEqual(disabled.body.result.missing, ['ghost']);
  // 停用后跳转要失效
  assert.equal((await srv.fetch('/b1')).status, 404);

  const enabled = await srv.json('/admin/api/links/batch', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ action: 'enable', codes: ['b1', 'b2'] }),
  });
  assert.equal(enabled.body.result.affected, 2);
  assert.equal((await srv.fetch('/b1')).status, 302);

  const deleted = await srv.json('/admin/api/links/batch', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ action: 'delete', codes: ['b1', 'b2', 'b3'] }),
  });
  assert.equal(deleted.body.result.affected, 3);
  const left = await srv.json('/admin/api/links', { headers: { Cookie: cookie } });
  assert.equal(left.body.result.total, 0);

  const badAction = await srv.json('/admin/api/links/batch', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ action: 'drop', codes: ['b1'] }),
  });
  assert.equal(badAction.res.status, 400);
  assert.equal(badAction.body.error.code, 'bad_action');

  const empty = await srv.json('/admin/api/links/batch', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ action: 'delete', codes: [] }),
  });
  assert.equal(empty.res.status, 400);
  assert.equal(empty.body.error.code, 'empty_selection');
}));

test('批量操作需要登录', () => withServer(async (srv) => {
  const res = await srv.json('/admin/api/links/batch', {
    method: 'POST',
    body: JSON.stringify({ action: 'delete', codes: ['x'] }),
  });
  assert.equal(res.res.status, 401);
}));

test('审计日志分页与过滤', () => withServer(async (srv) => {
  const { cookie } = await login(srv);
  for (const code of ['a1', 'a2', 'a3']) await createLink(srv, cookie, { url: `https://example.com/${code}`, code });

  // 登录本身也会写一条审计
  const page1 = await srv.json('/admin/api/audit?perPage=2&filter=link.create', { headers: { Cookie: cookie } });
  assert.equal(page1.body.result.total, 3);
  assert.equal(page1.body.result.pages, 2);
  assert.equal(page1.body.result.items.length, 2);
  assert.equal(page1.body.result.items[0].action, 'link.create');

  const page2 = await srv.json('/admin/api/audit?perPage=2&page=2&filter=link.create', { headers: { Cookie: cookie } });
  assert.equal(page2.body.result.items.length, 1);

  const all = await srv.json('/admin/api/audit?perPage=2', { headers: { Cookie: cookie } });
  assert.ok(all.body.result.actions.some((a) => a.action === 'auth.login'));

  const onlyLogin = await srv.json('/admin/api/audit?filter=auth.login', { headers: { Cookie: cookie } });
  assert.ok(onlyLogin.body.result.items.every((i) => i.action === 'auth.login'));
}));

test('概览包含今日新增与最近操作', () => withServer(async (srv) => {
  const { cookie } = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com', code: 'ov1' });
  const { body } = await srv.json('/admin/api/overview', { headers: { Cookie: cookie } });
  assert.equal(body.result.todayNew, 1);
  assert.ok(Array.isArray(body.result.recent));
  assert.ok(Array.isArray(body.result.activity));
  assert.equal(body.result.activity[0].action, 'link.create');
}));

test('非法百分号编码不产生 500', () => withServer(async (srv) => {
  const { cookie } = await login(srv);
  const res = await srv.fetch('/admin/api/links/%zz', { headers: { Cookie: cookie } });
  assert.ok(res.status < 500, `期望 4xx，实际 ${res.status}`);
}));

test('恢复备份时坏 JSON 返回 400', () => withServer(async (srv) => {
  const { cookie } = await login(srv);
  const res = await srv.json('/admin/api/restore', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ content: 'not json at all', mode: 'merge' }),
  });
  assert.equal(res.res.status, 400);
  assert.equal(res.body.error.code, 'bad_backup');
}));
