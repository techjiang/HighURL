import test from 'node:test';
import assert from 'node:assert/strict';

import { makeStore, startTestServer } from './helpers.js';
import { inspectBackup, restoreBackup } from '../src/services/restore.js';

async function withServer(fn) {
  const srv = await startTestServer();
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

/** 造一份完整备份：分组、短链、分流目标、四类统计、规则都有 */
function fixture(store) {
  const ts = Date.now();
  store.db.prepare("INSERT INTO groups (name, color, note, created_at, updated_at) VALUES ('活动', '#8b5cf6', '', ?, ?)").run(ts, ts);
  const gid = store.db.prepare("SELECT id FROM groups WHERE name = '活动'").get().id;
  store.db
    .prepare("INSERT INTO links (code, url, title, tags, status, clicks, created_at, updated_at, group_id) VALUES ('promo', 'https://example.com/p', '推广页', 'a,b', 'active', 12, ?, ?, ?)")
    .run(ts, ts, gid);
  const lid = store.db.prepare("SELECT id FROM links WHERE code = 'promo'").get().id;
  store.db
    .prepare("INSERT INTO link_targets (link_id, url, label, weight, regions, enabled, clicks, created_at) VALUES (?, 'https://example.com/b', 'B 版', 30, 'CN', 1, 4, ?)")
    .run(lid, ts);
  store.db.prepare("INSERT INTO click_daily (code, day, clicks) VALUES ('promo', '2026-11-12', 12)").run();
  store.db.prepare("INSERT INTO click_refs (code, host, clicks) VALUES ('promo', 't.co', 5)").run();
  store.db.prepare("INSERT INTO click_agents (code, platform, clicks) VALUES ('promo', 'ios', 7)").run();
  store.db.prepare("INSERT INTO click_countries (code, country, clicks) VALUES ('promo', 'CN', 9)").run();
  store.db.prepare("INSERT INTO ua_rules (kind, pattern, note, hits, enabled, created_at) VALUES ('ua', '*badbot*', '拦', 0, 1, ?)").run(ts);
  return store.exportAll();
}

test('恢复把分组、分流目标、四类统计与规则一起带回来', () => {
  // 源实例：造数据并导出
  const src = makeStore();
  const backup = fixture(src.store);
  src.store.close();

  // 目标实例：只给一份备份，什么都还没有
  const dst = makeStore();
  const out = restoreBackup(dst.store, backup, { mode: 'replace' });

  assert.equal(out.restored, 1);
  assert.equal(out.groups, 1, '分组表要恢复');
  assert.equal(out.targets, 1, '分流目标要恢复');
  assert.equal(out.rules, 1, 'UA 规则要恢复');

  const link = dst.store.findLinkByCode('promo');
  assert.equal(link.title, '推广页');
  assert.equal(link.clicks, 12);
  assert.ok(link.group_id, '短链要挂回分组，而不是掉进未分组');
  assert.equal(dst.store.sql.getGroupById.get(link.group_id).name, '活动');

  const targets = dst.store.listTargets(link.id);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].url, 'https://example.com/b');
  assert.equal(targets[0].weight, 30);
  assert.equal(targets[0].regions, 'CN');

  assert.equal(dst.store.sql.linkDaily.all('promo', '2026-01-01').length, 1);
  assert.equal(dst.store.sql.linkRefs.all('promo', 5)[0].clicks, 5);
  assert.equal(dst.store.sql.linkAgents.all('promo', 5)[0].clicks, 7);
  assert.equal(dst.store.sql.linkCountries.all('promo', 5)[0].clicks, 9);
  dst.store.close();
});

test('备份里的分组 id 换机器后错位，按名字重新挂回去', () => {
  const src = makeStore();
  const backup = fixture(src.store);
  src.store.close();
  // 故意把备份里的 group_id 改成 999：模拟「换台机器，本机没这个 id」
  backup.links[0].group_id = 999;
  backup.groups[0].id = 999;

  const dst = makeStore();
  restoreBackup(dst.store, backup, { mode: 'replace' });
  const link = dst.store.findLinkByCode('promo');
  assert.ok(link.group_id, 'id 错位时仍要靠名字把分组接上');
  assert.equal(dst.store.sql.getGroupById.get(link.group_id).name, '活动');
  dst.store.close();
});

test('指向不存在分组的 group_id 落 null，不留幽灵引用', () => {
  const src = makeStore();
  const backup = fixture(src.store);
  src.store.close();
  // 备份里那条分组记录丢掉，只剩短链上的引用
  backup.groups = [];
  backup.links[0].group_id = 42;

  const dst = makeStore();
  restoreBackup(dst.store, backup, { mode: 'replace' });
  assert.equal(dst.store.findLinkByCode('promo').group_id, null);
  dst.store.close();
});

test('合并模式不动备份里没出现的分流目标与统计', () => {
  const src = makeStore();
  const backup = fixture(src.store);
  src.store.close();
  // 备份里只留这一条短链，且不带目标和统计
  const slim = { ...backup, link_targets: [], click_daily: [], click_refs: [], click_agents: [], click_countries: [] };

  const dst = makeStore();
  restoreBackup(dst.store, slim, { mode: 'replace' });
  const link = dst.store.findLinkByCode('promo');
  // 本地另一条链，带自己的目标
  const ts = Date.now();
  dst.store.db
    .prepare("INSERT INTO links (code, url, created_at, updated_at) VALUES ('keep', 'https://example.com/k', ?, ?)")
    .run(ts, ts);
  const keepId = dst.store.findLinkByCode('keep').id;
  dst.store.db
    .prepare("INSERT INTO link_targets (link_id, url, label, weight, regions, enabled, clicks, created_at) VALUES (?, 'https://example.com/k2', '', 50, '', 1, 0, ?)")
    .run(keepId, ts);

  restoreBackup(dst.store, slim, { mode: 'merge' });
  assert.equal(dst.store.listTargets(keepId).length, 1, '合并恢复不该清掉本地其它链的目标');
  assert.ok(dst.store.findLinkByCode(link.code));
  dst.store.close();
});

test('默认不覆盖站点设置，显式要求才写', () => {
  const src = makeStore();
  const backup = fixture(src.store);
  src.store.close();
  backup.settings = [{ key: 'siteName', value: '备份里的名字' }, { key: 'baseUrl', value: 'https://from-backup.example' }];

  const dst = makeStore();
  dst.store.sql.setSetting.run('siteName', '本机名字');
  const out = restoreBackup(dst.store, backup, { mode: 'merge' });
  assert.equal(out.settings, 0);
  assert.equal(dst.store.sql.getSetting.get('siteName').value, '本机名字', '默认不写站点设置');

  const out2 = restoreBackup(dst.store, backup, { mode: 'merge', withSettings: true });
  assert.equal(out2.settings, 2);
  assert.equal(dst.store.sql.getSetting.get('siteName').value, '备份里的名字');
  dst.store.close();
});

test('预检算出新增 / 覆盖 / 跳过，不写库', () => {
  const src = makeStore();
  const backup = fixture(src.store);
  src.store.close();

  const dst = makeStore();
  const plan = inspectBackup(backup, dst.store);
  assert.equal(plan.links.total, 1);
  assert.equal(plan.links.create, 1);
  assert.equal(plan.links.overwrite, 0);
  assert.equal(plan.counts.groups, 1);
  assert.equal(plan.counts.link_targets, 1);
  assert.equal(dst.store.sql.countLinks.get().n, 0, '预检不该写库');
  dst.store.close();
});

test('坏 JSON 与缺 links 的备份都给出 400 not 500', () => {
  const dst = makeStore();
  assert.throws(() => inspectBackup('{不是 json', dst.store), (err) => err.status === 400 && err.code === 'bad_backup');
  assert.throws(() => inspectBackup('{"foo":1}', dst.store), (err) => err.status === 400 && err.code === 'bad_backup');
  assert.throws(() => restoreBackup(dst.store, '{"foo":1}'), (err) => err.status === 400);
  dst.store.close();
});

test('管理台：预检 + 恢复接口把分组带回来', () => withServer(async (srv) => {
  const cookie = await login(srv);
  const g = await post(srv, cookie, '/admin/api/groups', { name: '线上活动', color: '#22d3ee' });
  await post(srv, cookie, '/admin/api/links', { url: 'https://example.com/a', code: 'lm', group: g.body.result.id });
  const backup = await (await srv.fetch('/admin/api/backup', { headers: { Cookie: cookie } })).text();

  await srv.json('/admin/api/links/lm', { method: 'DELETE', headers: { Cookie: cookie } });

  // 删除是软删除，短码还占着位，所以预检判成「覆盖」而不是「新增」
  const preview = await post(srv, cookie, '/admin/api/restore/preview', { content: backup });
  assert.equal(preview.res.status, 200);
  assert.equal(preview.body.result.links.overwrite, 1);

  const restored = await post(srv, cookie, '/admin/api/restore', { content: backup, mode: 'replace' });
  assert.equal(restored.res.status, 200);
  assert.equal(restored.body.result.groups, 1);

  const list = await srv.json('/admin/api/links?q=lm', { headers: { Cookie: cookie } });
  assert.equal(list.body.result.items[0].group.name, '线上活动');
}));

test('管理台：坏备份返回 400 而不是 500', () => withServer(async (srv) => {
  const cookie = await login(srv);
  const preview = await post(srv, cookie, '/admin/api/restore/preview', { content: '{oops' });
  assert.equal(preview.res.status, 400);
  assert.equal(preview.body.error.code, 'bad_backup');
}));
