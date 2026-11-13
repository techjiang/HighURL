import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml, safeUrl } from '../src/lib/html.js';
import { HttpError, sendJson, sendText, sendHtml, redirect, sendEmpty, parseJsonBody, readBody } from '../src/lib/http.js';
import { Router } from '../src/lib/router.js';
import { RateLimiter } from '../src/services/auth.js';
import { LinkCache } from '../src/services/link-cache.js';
import { makeStore } from './helpers.js';

test('escapeHtml 处理五类字符', () => {
  assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  assert.equal(escapeHtml("'"), '&#39;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(0), '0');
});

test('safeUrl 拦截危险协议', () => {
  assert.equal(safeUrl('https://example.com'), 'https://example.com');
  assert.equal(safeUrl('javascript:alert(1)'), '#');
  assert.equal(safeUrl('data:text/html,<script>'), '#');
  assert.equal(safeUrl(''), '#');
});

test('HttpError 携带状态、code 与 extra', () => {
  const err = new HttpError(409, '冲突了', 'conflict', { field: 'code' });
  assert.equal(err.status, 409);
  assert.equal(err.code, 'conflict');
  assert.deepEqual(err.extra, { field: 'code' });
  assert.ok(err instanceof Error);
});

function fakeRes() {
  const out = { headers: {}, status: 0, body: null };
  // 统一用小写 key，方便断言，模拟 Node 的 header 不区分大小写
  out.writeHead = (status, headers) => {
    out.status = status;
    for (const [k, v] of Object.entries(headers || {})) out.headers[k.toLowerCase()] = v;
    return out;
  };
  out.setHeader = (k, v) => {
    out.headers[k.toLowerCase()] = v;
  };
  out.end = (data) => {
    out.body = data ?? null;
  };
  return out;
}

test('sendJson / sendText / sendHtml / sendEmpty / redirect 写头正确', () => {
  const a = fakeRes();
  sendJson(a, 201, { ok: true });
  assert.equal(a.status, 201);
  assert.match(a.headers['content-type'], /application\/json/);
  assert.equal(String(a.body), '{"ok":true}');

  const b = fakeRes();
  sendText(b, 400, 'bad');
  assert.equal(String(b.body), 'bad');

  const c = fakeRes();
  sendHtml(c, 200, '<p>x</p>');
  assert.match(String(c.body), /<p>x<\/p>/);

  const d = fakeRes();
  sendEmpty(d, 204);
  assert.equal(d.status, 204);
  assert.equal(d.body, null);

  const e = fakeRes();
  redirect(e, 'https://example.com', 301);
  assert.equal(e.status, 301);
  assert.equal(e.headers.location, 'https://example.com');
  assert.equal(d.status, 204);
});

test('parseJsonBody 解析与错误处理', async () => {
  const { Readable } = await import('node:stream');
  const make = (payload) => {
    const s = Readable.from([Buffer.from(payload)]);
    s.headers = { 'content-type': 'application/json' };
    return s;
  };
  assert.deepEqual(await parseJsonBody(make('{"a":1}')), { a: 1 });
  assert.deepEqual(await parseJsonBody(make('')), {});
  await assert.rejects(() => parseJsonBody(make('{bad')), /JSON/);
});

test('readBody 超过上限时抛 413', async () => {
  const { Readable } = await import('node:stream');
  const s = Readable.from([Buffer.alloc(2048)]);
  await assert.rejects(() => readBody(s, 1024), (err) => {
    assert.equal(err.status, 413);
    return true;
  });
});

test('Router 匹配静态段、参数与通配符', () => {
  const r = new Router();
  r.get('/a/b', () => 'static');
  r.get('/l/:code', () => 'param');
  r.get('/l/:code/stats', () => 'deep');
  r.get('/files/*', () => 'wild');
  r.post('/only', () => 'post');

  assert.equal(r.match('GET', '/a/b').handler(), 'static');
  assert.equal(r.match('GET', '/l/abc').params.code, 'abc');
  assert.equal(r.match('GET', '/l/abc/stats').handler(), 'deep');
  assert.equal(r.match('GET', '/files/x/y/z').params['*'], 'x/y/z');
  assert.equal(r.match('GET', '/only'), null);
  assert.equal(r.match('POST', '/only').handler(), 'post');
  assert.equal(r.match('HEAD', '/a/b', ['GET']).handler(), 'static');
  assert.equal(r.match('GET', '/nope'), null);
  assert.equal(r.match('GET', '/a/b/c'), null);
});

test('Router 参数支持 URL 解码', () => {
  const r = new Router();
  r.get('/x/:code', () => 1);
  assert.equal(r.match('GET', '/x/a%20b').params.code, 'a b');
});

test('RateLimiter 到阈值后拒绝，窗口滚动后恢复', async () => {
  const limiter = new RateLimiter({ windowMs: 60, max: 2 });
  assert.equal(limiter.take('k').allowed, true);
  assert.equal(limiter.take('k').allowed, true);
  const third = limiter.take('k');
  assert.equal(third.allowed, false);
  assert.ok(third.reset > Date.now() - 1000);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(limiter.take('k').allowed, true);
  limiter.stop();
});

test('RateLimiter 不同 key 互不影响', () => {
  const limiter = new RateLimiter({ windowMs: 60000, max: 1 });
  assert.equal(limiter.take('a').allowed, true);
  assert.equal(limiter.take('a').allowed, false);
  assert.equal(limiter.take('b').allowed, true);
  limiter.stop();
});

test('LinkCache 命中、TTL 过期与失效', async () => {
  const { store } = makeStore();
  store.db.prepare("INSERT INTO links (code, url, created_at, updated_at) VALUES ('c1', 'https://a.com', 1, 1)").run();
  const cache = new LinkCache(store, { ttlMs: 40, max: 2 });

  assert.equal(cache.load('c1').url, 'https://a.com');
  assert.equal(cache.stats().misses, 1);
  assert.equal(cache.load('c1').url, 'https://a.com');
  assert.equal(cache.stats().hits, 1);
  assert.equal(cache.load('missing'), null);

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(cache.get('c1'), null, 'TTL 过后应失效');

  cache.set('x', { code: 'x' });
  cache.invalidate('x');
  assert.equal(cache.get('x'), null);
  cache.set('y', { code: 'y' });
  cache.invalidate();
  assert.equal(cache.stats().size, 0);
  store.close();
});

test('LinkCache 超过上限按 LRU 淘汰', () => {
  const { store } = makeStore();
  const cache = new LinkCache(store, { ttlMs: 60000, max: 2 });
  cache.set('a', { code: 'a' });
  cache.set('b', { code: 'b' });
  cache.get('a'); // a 变新
  cache.set('c', { code: 'c' }); // 淘汰 b
  assert.ok(cache.get('a'));
  assert.equal(cache.get('b'), null);
  assert.ok(cache.get('c'));
  store.close();
});
