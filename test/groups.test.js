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

const post = (srv, cookie, path, body) =>
  srv.json(path, { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify(body) });

test('分组增删改查与短链归组', () => withServer(async (srv) => {
  const cookie = await login(srv);

  const created = await post(srv, cookie, '/admin/api/groups', { name: '官网', color: '#8B5CF6', note: '主站' });
  assert.equal(created.res.status, 200);
  assert.equal(created.body.result.name, '官网');
  assert.equal(created.body.result.color, '#8b5cf6', '颜色统一变小写');

  const dup = await post(srv, cookie, '/admin/api/groups', { name: '官网' });
  assert.equal(dup.res.status, 409);
  assert.equal(dup.body.error.code, 'group_exists');

  const badColor = await post(srv, cookie, '/admin/api/groups', { name: '活动', color: 'red' });
  assert.equal(badColor.res.status, 400);

  const gid = created.body.result.id;
  const link = await post(srv, cookie, '/admin/api/links', {
    url: 'https://example.com/a',
    code: 'g1',
    group: gid,
  });
  assert.equal(link.res.status, 200);
  assert.equal(link.body.result.group.id, gid);
  assert.equal(link.body.result.group.name, '官网');

  const list = await srv.json(`/admin/api/links?group=${gid}`, { headers: { Cookie: cookie } });
  assert.equal(list.body.result.total, 1);
  const other = await srv.json('/admin/api/links?group=none', { headers: { Cookie: cookie } });
  assert.equal(other.body.result.total, 0);

  const groups = await srv.json('/admin/api/groups', { headers: { Cookie: cookie } });
  assert.equal(groups.body.result.items[0].links, 1);

  // 改名
  const renamed = await srv.json(`/admin/api/groups/${gid}`, {
    method: 'PATCH',
    headers: { Cookie: cookie },
    body: JSON.stringify({ name: '官网入口' }),
  });
  assert.equal(renamed.body.result.name, '官网入口');
  const afterRename = await srv.json('/admin/api/links?q=g1', { headers: { Cookie: cookie } });
  assert.equal(afterRename.body.result.items[0].group.name, '官网入口', '改名后链接上的分组名要跟着变');

  // 删分组不删链
  const removed = await srv.json(`/admin/api/groups/${gid}`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(removed.body.result.ungrouped, 1);
  const back = await srv.json('/admin/api/links?q=g1', { headers: { Cookie: cookie } });
  assert.equal(back.body.result.total, 1, '分组删了短链还在');
  assert.equal(back.body.result.items[0].group, null);
}));

test('分组可以通过名称指定', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await post(srv, cookie, '/admin/api/groups', { name: '活动' });
  const link = await post(srv, cookie, '/admin/api/links', { url: 'https://example.com/x', code: 'byName', group: '活动' });
  assert.equal(link.body.result.group.name, '活动');

  const missing = await post(srv, cookie, '/admin/api/links', { url: 'https://example.com/y', group: '不存在的分组' });
  assert.equal(missing.res.status, 404);
  assert.equal(missing.body.error.code, 'group_not_found');
}));

test('分组接口需要登录', () => withServer(async (srv) => {
  assert.equal((await srv.json('/admin/api/groups')).res.status, 401);
  assert.equal((await post(srv, '', '/admin/api/groups', { name: 'x' })).res.status, 401);
}));

test('删除进回收站，短码继续占位且访问 404', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await post(srv, cookie, '/admin/api/links', { url: 'https://example.com/t', code: 'tr1' });
  assert.equal((await srv.fetch('/tr1')).status, 302);

  const del = await srv.json('/admin/api/links/tr1', { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(del.body.deleted, 'tr1');
  assert.equal(del.body.trashed, true);
  assert.equal((await srv.fetch('/tr1')).status, 404);

  const trash = await srv.json('/admin/api/trash', { headers: { Cookie: cookie } });
  assert.equal(trash.body.result.total, 1);
  assert.equal(trash.body.result.items[0].code, 'tr1');
  assert.ok(trash.body.result.items[0].deletedAt > 0);

  // 回收站里仍占着短码，重新创建要报冲突
  const again = await post(srv, cookie, '/admin/api/links', { url: 'https://example.com/t2', code: 'tr1' });
  assert.equal(again.res.status, 409);

  // 恢复后立刻能用
  const restored = await post(srv, cookie, '/admin/api/trash/tr1/restore', {});
  assert.equal(restored.res.status, 200);
  assert.equal((await srv.fetch('/tr1')).status, 302);
  const empty = await srv.json('/admin/api/trash', { headers: { Cookie: cookie } });
  assert.equal(empty.body.result.total, 0);
}));

test('彻底删除清掉统计，清空回收站一次清完', () => withServer(async (srv) => {
  const cookie = await login(srv);
  for (const code of ['p1', 'p2', 'p3']) {
    await post(srv, cookie, '/admin/api/links', { url: `https://example.com/${code}`, code });
    await srv.fetch(`/${code}`);
  }
  await srv.ctx.counter.flush();
  for (const code of ['p1', 'p2', 'p3']) {
    await srv.json(`/admin/api/links/${code}`, { method: 'DELETE', headers: { Cookie: cookie } });
  }

  const purged = await srv.json('/admin/api/trash/p1', { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(purged.body.purged, 'p1');
  assert.equal(srv.ctx.store.sql.getLinkByCodeAny.get('p1'), undefined);
  assert.equal(srv.ctx.store.sql.linkDaily.all('p1', '2000-01-01').length, 0);

  const empty = await post(srv, cookie, '/admin/api/trash/empty', {});
  assert.equal(empty.body.result.removed, 2);
  assert.equal(srv.ctx.store.sql.countDeleted.get().n, 0);
}));

test('回收站的短链不再计入统计与来源', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await post(srv, cookie, '/admin/api/links', { url: 'https://example.com/s1', code: 's1' });
  await post(srv, cookie, '/admin/api/links', { url: 'https://example.com/s2', code: 's2' });
  for (let i = 0; i < 5; i += 1) await srv.fetch('/s1', { headers: { Referer: 'https://t.co/x' } });
  await srv.fetch('/s2');
  await srv.ctx.counter.flush();

  const before = await srv.json('/admin/api/sources', { headers: { Cookie: cookie } });
  assert.equal(before.body.result.totalClicks, 6);

  await srv.json('/admin/api/links/s1', { method: 'DELETE', headers: { Cookie: cookie } });
  const after = await srv.json('/admin/api/sources', { headers: { Cookie: cookie } });
  assert.equal(after.body.result.totalClicks, 1, '回收站的点击不再计入总量');
  assert.equal(after.body.result.refs.length, 0);
  const overview = await srv.json('/admin/api/overview', { headers: { Cookie: cookie } });
  assert.equal(overview.body.result.total, 1);
}));

test('批量恢复与批量彻底删除', () => withServer(async (srv) => {
  const cookie = await login(srv);
  for (const code of ['b1', 'b2']) {
    await post(srv, cookie, '/admin/api/links', { url: `https://example.com/${code}`, code });
    await srv.json(`/admin/api/links/${code}`, { method: 'DELETE', headers: { Cookie: cookie } });
  }
  const restored = await post(srv, cookie, '/admin/api/links/batch', { action: 'restore', codes: ['b1', 'b2'] });
  assert.equal(restored.body.result.affected, 2);
  assert.equal((await srv.fetch('/b1')).status, 302);

  await srv.json('/admin/api/links/b1', { method: 'DELETE', headers: { Cookie: cookie } });
  const purged = await post(srv, cookie, '/admin/api/links/batch', { action: 'purge', codes: ['b1'] });
  assert.equal(purged.body.result.affected, 1);
  assert.equal(srv.ctx.store.sql.getLinkByCodeAny.get('b1'), undefined);

  // 恢复不在回收站的记录要报 missing，而不是假装成功
  const nothing = await post(srv, cookie, '/admin/api/links/batch', { action: 'restore', codes: ['b2'] });
  assert.equal(nothing.body.result.affected, 0);
  assert.deepEqual(nothing.body.result.missing, ['b2']);
}));

test('回收站保留天数到期自动清理', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await post(srv, cookie, '/admin/api/links', { url: 'https://example.com/old', code: 'old1' });
  await srv.json('/admin/api/links/old1', { method: 'DELETE', headers: { Cookie: cookie } });
  // 把删除时间往前拨，模拟已经放了很久
  srv.ctx.store.db.prepare('UPDATE links SET deleted_at = ? WHERE code = ?').run(Date.now() - 40 * 86400000, 'old1');
  srv.ctx.settings.update({ trashRetentionDays: 30 });
  const out = srv.ctx.maintenance.purgeTrash();
  assert.equal(out.purged, 1);
  assert.equal(srv.ctx.store.sql.getLinkByCodeAny.get('old1'), undefined);
}));

test('CSV 导出带分组列并排除回收站', () => withServer(async (srv) => {
  const cookie = await login(srv);
  const g = await post(srv, cookie, '/admin/api/groups', { name: '导出组' });
  await post(srv, cookie, '/admin/api/links', { url: 'https://example.com/c1', code: 'c1', group: g.body.result.id });
  await post(srv, cookie, '/admin/api/links', { url: 'https://example.com/c2', code: 'c2' });
  await srv.json('/admin/api/links/c2', { method: 'DELETE', headers: { Cookie: cookie } });

  const csv = await srv.fetch('/admin/api/export.csv', { headers: { Cookie: cookie } });
  const text = (await csv.text()).replace(/^\uFEFF/, '');
  assert.match(text.split('\n')[0], /^code,url,title,group,/);
  assert.match(text, /c1/);
  assert.doesNotMatch(text, /c2/, '回收站里的短链不该出现在 CSV');
  // 分组列必须真的有值：以前表头写 group、SQL 里叫 group_name，
  // 取值取的是 r['group']，这一列永远空着
  const row = text.split('\n').find((line) => line.startsWith('c1,'));
  assert.equal(row.split(',')[3], '导出组', 'CSV 的分组列不能是空的');
}));

test('备份包含分组，恢复后分组关系回来', () => withServer(async (srv) => {
  const cookie = await login(srv);
  const g = await post(srv, cookie, '/admin/api/groups', { name: '老分组', color: '#22d3ee' });
  await post(srv, cookie, '/admin/api/links', { url: 'https://example.com/bk', code: 'bk', group: g.body.result.id });

  const backup = await srv.fetch('/admin/api/backup', { headers: { Cookie: cookie } });
  const content = await backup.text();
  const parsed = JSON.parse(content);
  assert.equal(parsed.groups.length, 1);
  assert.equal(parsed.groups[0].name, '老分组');

  // 删链和分组，再从备份恢复
  await srv.json('/admin/api/links/bk', { method: 'DELETE', headers: { Cookie: cookie } });
  const restore = await post(srv, cookie, '/admin/api/restore', { content, mode: 'replace' });
  assert.equal(restore.res.status, 200);
  const list = await srv.json('/admin/api/links?q=bk', { headers: { Cookie: cookie } });
  assert.equal(list.body.result.items[0].group.name, '老分组', '恢复后分组关系要保留');
}));

test('API v1 读写分组信息', () => withServer(async (srv) => {
  const cookie = await login(srv);
  const key = srv.ctx.auth.createKey('k', 'read,write');
  const g = await post(srv, cookie, '/admin/api/groups', { name: 'APIs' });
  const auth = { Authorization: `Bearer ${key.key}` };

  const created = await srv.json('/api/v1/links', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ url: 'https://example.com/api', code: 'api1', group: g.body.result.id }),
  });
  assert.equal(created.res.status, 201);
  assert.equal(created.body.result.group.name, 'APIs');

  const list = await srv.json(`/api/v1/links?group=${g.body.result.id}`, { headers: auth });
  assert.equal(list.body.result.total, 1);

  const moved = await srv.json('/api/v1/links/api1', {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ group: null }),
  });
  assert.equal(moved.body.result.group, null);
  assert.equal(moved.body.result.deletedAt, null);
}));
