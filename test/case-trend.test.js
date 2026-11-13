import test from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer } from './helpers.js';
import { dateKey } from '../src/lib/util.js';

async function withServer(fn, overrides = {}) {
  const srv = await startTestServer(overrides);
  try {
    return await fn(srv);
  } finally {
    await srv.stop();
  }
}

async function login(srv, username = 'admin', password = 'password123') {
  if (!srv.ctx.auth.hasAdmin()) srv.ctx.auth.createAdmin(username, password);
  const res = await srv.fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }).toString(),
  });
  return (res.headers.getSetCookie?.() || [res.headers.get('set-cookie')])
    .map((c) => String(c).split(';')[0])
    .join('; ');
}

async function createLink(srv, cookie, body) {
  const { body: json } = await srv.json('/admin/api/links', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify(body),
  });
  return json.result;
}

test('短码大小写不一致时跳转仍然命中同一条记录', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/a', code: 'MiXeD' });

  for (const path of ['/MiXeD', '/mixed', '/MIXED', '/mIxEd']) {
    const res = await srv.fetch(path);
    assert.equal(res.status, 302, `${path} 应能跳转`);
    assert.equal(res.headers.get('location'), 'https://example.com/a');
  }
}));

test('大小写变体访问会计入同一条短链的点击', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/cnt', code: 'CountMe' });
  await srv.fetch('/countme');
  await srv.fetch('/COUNTME');
  await srv.ctx.counter.flush();

  const { body } = await srv.json('/admin/api/links/countme/stats', { headers: { Cookie: cookie } });
  assert.equal(body.result.code, 'CountMe', '返回的应是库里的规范短码');
  assert.equal(body.result.clicks, 2);
}));

test('编辑后用另一种大小写访问拿到新目标（缓存键统一）', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/old', code: 'CaseEdit' });
  await srv.fetch('/caseedit'); // 先把缓存热起来

  await srv.json('/admin/api/links/CASEEDIT', {
    method: 'PATCH',
    headers: { Cookie: cookie },
    body: JSON.stringify({ url: 'https://example.com/new' }),
  });

  const res = await srv.fetch('/CaseEdit');
  assert.equal(res.headers.get('location'), 'https://example.com/new');
}));

test('管理 API 用任意大小写都能操作同一条短链', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/x', code: 'ApiCase' });

  const patched = await srv.json('/admin/api/links/apicase', {
    method: 'PATCH',
    headers: { Cookie: cookie },
    body: JSON.stringify({ title: '改过了' }),
  });
  assert.equal(patched.res.status, 200);
  assert.equal(patched.body.result.title, '改过了');

  const list = await srv.json('/admin/api/links?q=ApiCase', { headers: { Cookie: cookie } });
  assert.equal(list.body.result.items[0].code, 'ApiCase');
  const stats = await srv.json('/admin/api/links/APICASE/stats', { headers: { Cookie: cookie } });
  assert.equal(stats.body.result.code, 'ApiCase', '统计接口也要认大小写');

  // 批量操作同样认大小写
  const batch = await srv.json('/admin/api/links/batch', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ action: 'delete', codes: ['APICASE'] }),
  });
  assert.equal(batch.body.result.affected, 1);

  const trash = await srv.json('/admin/api/trash', { headers: { Cookie: cookie } });
  assert.equal(trash.body.result.items[0].code, 'ApiCase');
}));

test('密码保护链接用大小写变体也能解锁并跳转', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await createLink(srv, cookie, { url: 'https://example.com/p', code: 'ProtCase' });
  await srv.json('/admin/api/links/protcase/password', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ password: 'pass1234' }),
  });

  const locked = await srv.fetch('/protcase');
  assert.equal(locked.status, 401);

  const submit = await srv.fetch('/protcase', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'pass1234' }).toString(),
  });
  assert.equal(submit.status, 302);
  const setCookie = (submit.headers.getSetCookie?.() || [submit.headers.get('set-cookie')])
    .map((c) => String(c).split(';')[0])
    .join('; ');
  // 用记录里的规范短码跳回去，否则解锁后还会撞上大小写不匹配
  assert.equal(submit.headers.get('location'), '/ProtCase');

  const unlocked = await srv.fetch('/protcase', { headers: { Cookie: setCookie } });
  assert.equal(unlocked.status, 302);
  assert.equal(unlocked.headers.get('location'), 'https://example.com/p');
}));

test('分组趋势：按分组聚合每日点击，回收站不计入', () => withServer(async (srv) => {
  const { store } = srv.ctx;
  const cookie = await login(srv);
  const g = await srv.json('/admin/api/groups', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ name: '官网', color: '#22d3ee' }),
  });
  const gid = g.body.result.id;
  await createLink(srv, cookie, { url: 'https://example.com/g1', code: 'gt1', group: gid });
  await createLink(srv, cookie, { url: 'https://example.com/g2', code: 'gt2' });

  const today = dateKey();
  store.sql.upsertDaily.run('gt1', today, 5);
  store.sql.upsertDaily.run('gt2', today, 3);

  const { res, body } = await srv.json('/admin/api/groups/trend?days=7', { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.equal(body.result.daily.length, 7);
  const group = body.result.groups.find((x) => x.id === gid);
  assert.equal(group.daily.at(-1).clicks, 5);
  assert.equal(body.result.ungrouped.daily.at(-1).clicks, 3);
  assert.equal(body.result.total.at(-1).clicks, 8);

  // 移入回收站后不再出现在趋势里
  await srv.json('/admin/api/links/gt1', { method: 'DELETE', headers: { Cookie: cookie } });
  const after = await srv.json('/admin/api/groups/trend?days=7', { headers: { Cookie: cookie } });
  assert.equal(after.body.result.total.at(-1).clicks, 3);
}));

test('分组趋势需要登录，days 有上下界', () => withServer(async (srv) => {
  assert.equal((await srv.json('/admin/api/groups/trend')).res.status, 401);
  const cookie = await login(srv);
  const big = await srv.json('/admin/api/groups/trend?days=99999', { headers: { Cookie: cookie } });
  assert.equal(big.body.result.days, 90);
  const small = await srv.json('/admin/api/groups/trend?days=1', { headers: { Cookie: cookie } });
  assert.equal(small.body.result.days, 7);
}));
