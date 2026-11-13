import test from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer } from './helpers.js';

async function withServer(fn) {
  const srv = await startTestServer();
  try {
    return await fn(srv);
  } finally {
    await srv.stop();
  }
}

async function login(srv) {
  if (!srv.ctx.auth.hasAdmin()) srv.ctx.auth.createAdmin('admin', 'password123');
  const res = await srv.fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'password123' }).toString(),
  });
  return (res.headers.getSetCookie?.() || [res.headers.get('set-cookie')])
    .map((c) => String(c).split(';')[0])
    .join('; ');
}

const post = (srv, cookie, path, body) =>
  srv.json(path, { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify(body) });

test('批量改分组：可归组，也可用 null 移出分组', () => withServer(async (srv) => {
  const cookie = await login(srv);
  const g = await post(srv, cookie, '/admin/api/groups', { name: '活动' });
  const gid = g.body.result.id;
  for (const code of ['g1', 'g2']) {
    await post(srv, cookie, '/admin/api/links', { url: `https://example.com/${code}`, code });
  }

  const moved = await post(srv, cookie, '/admin/api/links/batch', { action: 'group', codes: ['g1', 'g2'], group: gid });
  assert.equal(moved.body.result.affected, 2);
  assert.equal(srv.ctx.store.sql.getLinkByCode.get('g1').group_id, gid);
  assert.equal(srv.ctx.store.sql.getLinkByCode.get('g2').group_id, gid);

  const cleared = await post(srv, cookie, '/admin/api/links/batch', { action: 'group', codes: ['g1'], group: null });
  assert.equal(cleared.body.result.affected, 1);
  assert.equal(srv.ctx.store.sql.getLinkByCode.get('g1').group_id, null);
  assert.equal(srv.ctx.store.sql.getLinkByCode.get('g2').group_id, gid, '未选中的不受影响');

  // 不存在的分组要报错，而不是静默写成 null
  const bad = await post(srv, cookie, '/admin/api/links/batch', { action: 'group', codes: ['g1'], group: 99999 });
  assert.equal(bad.res.status, 404);
  assert.equal(bad.body.error.code, 'group_not_found');
}));

test('批量改标签：追加 / 覆盖 / 清空三种语义', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await post(srv, cookie, '/admin/api/links', { url: 'https://example.com/t1', code: 't1', tags: 'old,keep' });
  await post(srv, cookie, '/admin/api/links', { url: 'https://example.com/t2', code: 't2', tags: 'old' });

  const merged = await post(srv, cookie, '/admin/api/links/batch', { action: 'tags', codes: ['t1', 't2'], tags: 'new', mode: 'merge' });
  assert.equal(merged.body.result.affected, 2);
  assert.equal(srv.ctx.store.sql.getLinkByCode.get('t1').tags, 'old,keep,new');
  assert.equal(srv.ctx.store.sql.getLinkByCode.get('t2').tags, 'old,new');

  const replaced = await post(srv, cookie, '/admin/api/links/batch', { action: 'tags', codes: ['t1'], tags: 'only', mode: 'replace' });
  assert.equal(replaced.body.result.affected, 1);
  assert.equal(srv.ctx.store.sql.getLinkByCode.get('t1').tags, 'only');

  const cleared = await post(srv, cookie, '/admin/api/links/batch', { action: 'tags', codes: ['t1', 't2'], mode: 'clear' });
  assert.equal(cleared.body.result.affected, 2);
  assert.equal(srv.ctx.store.sql.getLinkByCode.get('t1').tags, '');
  assert.equal(srv.ctx.store.sql.getLinkByCode.get('t2').tags, '');
}));

test('批量改标签的非法 mode 返回 400', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await post(srv, cookie, '/admin/api/links', { url: 'https://example.com/m1', code: 'm1' });
  const bad = await post(srv, cookie, '/admin/api/links/batch', { action: 'tags', codes: ['m1'], tags: 'x', mode: 'append' });
  assert.equal(bad.res.status, 400);
  assert.equal(bad.body.error.code, 'bad_mode');
}));

test('批量操作支持大小写混杂的短码', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await post(srv, cookie, '/admin/api/links', { url: 'https://example.com/case', code: 'MiXeD' });
  const r = await post(srv, cookie, '/admin/api/links/batch', { action: 'tags', codes: ['mixed'], tags: 'x', mode: 'replace' });
  assert.equal(r.body.result.affected, 1);
  assert.equal(srv.ctx.store.sql.getLinkByCode.get('MiXeD').tags, 'x');
}));

test('批量操作缺省不携带 group 时不误清分组', () => withServer(async (srv) => {
  const cookie = await login(srv);
  const g = await post(srv, cookie, '/admin/api/groups', { name: '保留' });
  await post(srv, cookie, '/admin/api/links', { url: 'https://example.com/k1', code: 'k1', group: g.body.result.id });
  const r = await post(srv, cookie, '/admin/api/links/batch', { action: 'tags', codes: ['k1'], tags: 'x', mode: 'merge' });
  assert.equal(r.body.result.affected, 1);
  assert.equal(srv.ctx.store.sql.getLinkByCode.get('k1').group_id, g.body.result.id);
}));
