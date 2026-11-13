import test from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, makeStore, tmpDir, cleanupTmp } from './helpers.js';
import { openDatabase } from '../src/lib/db.js';
import { Settings } from '../src/services/settings.js';
import { loadConfig } from '../src/config.js';
import { HistoryService, diffSnapshots } from '../src/services/history.js';
import path from 'node:path';
import { buildBackup, verifyBackup, checksumExtraOf } from '../src/services/backup.js';
import { restoreBackup } from '../src/services/restore.js';

test.after(() => cleanupTmp());

async function withServer(fn) {
  const srv = await startTestServer({ titleFetch: false });
  await srv.ctx.auth.createAdmin('admin', 'Passw0rd!23');
  try {
    return await fn(srv);
  } finally {
    await srv.stop();
  }
}

async function login(srv) {
  const res = await srv.fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'Passw0rd!23' }),
  });
  return String(res.headers.get('set-cookie') || '').split(';')[0];
}

function call(srv, cookie, pathname, { method = 'GET', body } = {}) {
  return srv.json(pathname, {
    method,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('新建短链会立刻留下第一版历史（action=create）', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await call(srv, cookie, '/admin/api/links', { method: 'POST', body: { url: 'https://a.com/x', code: 'h1' } });
  const { body } = await call(srv, cookie, '/admin/api/links/h1/history');
  assert.equal(body.result.total, 1);
  assert.equal(body.result.items[0].action, 'create');
  assert.match(body.result.items[0].summary, /a\.com/);
}));

test('改之前先存快照：编辑一次就能回滚到旧地址', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await call(srv, cookie, '/admin/api/links', { method: 'POST', body: { url: 'https://old.example/a', code: 'h2', title: '旧标题' } });
  await call(srv, cookie, '/admin/api/links/h2', { method: 'PATCH', body: { url: 'https://new.example/b', title: '新标题' } });

  const after = srv.ctx.store.findLinkByCode('h2');
  assert.equal(after.url, 'https://new.example/b');

  const { body: hist } = await call(srv, cookie, '/admin/api/links/h2/history');
  // create + update 前快照 = 2 版
  assert.equal(hist.result.total, 2);
  const oldVersion = hist.result.items.find((h) => h.snapshot?.url === 'https://old.example/a');
  assert.ok(oldVersion, '应该能从历史里找到旧地址');

  const { body: rolled } = await call(srv, cookie, `/admin/api/links/h2/history/${oldVersion.id}/rollback`, { method: 'POST' });
  assert.equal(rolled.result.url, 'https://old.example/a');
  assert.equal(rolled.result.title, '旧标题');
  assert.equal(srv.ctx.store.findLinkByCode('h2').url, 'https://old.example/a');
}));

test('回滚本身也记一版，所以滚错了还能滚回来', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await call(srv, cookie, '/admin/api/links', { method: 'POST', body: { url: 'https://v1.example/', code: 'h3' } });
  await call(srv, cookie, '/admin/api/links/h3', { method: 'PATCH', body: { url: 'https://v2.example/' } });

  const { body: hist1 } = await call(srv, cookie, '/admin/api/links/h3/history');
  const first = hist1.result.items.find((h) => h.snapshot?.url === 'https://v1.example/');
  await call(srv, cookie, `/admin/api/links/h3/history/${first.id}/rollback`, { method: 'POST' });

  const { body: hist2 } = await call(srv, cookie, '/admin/api/links/h3/history');
  assert.ok(hist2.result.total > hist1.result.total, '回滚后就多出版本');
  const backToV2 = hist2.result.items.find((h) => h.snapshot?.url === 'https://v2.example/' && h.action === 'rollback_before');
  assert.ok(backToV2, '回滚前的 v2 状态应该被留下来了');

  const { body: again } = await call(srv, cookie, `/admin/api/links/h3/history/${backToV2.id}/rollback`, { method: 'POST' });
  assert.equal(again.result.url, 'https://v2.example/');
}));

test('回滚会把分流目标一起还原', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await call(srv, cookie, '/admin/api/links', { method: 'POST', body: { url: 'https://def.example/', code: 'h4' } });
  await call(srv, cookie, '/admin/api/links/h4/targets', {
    method: 'PUT',
    body: { targets: [{ url: 'https://a.example/', weight: 60 }, { url: 'https://b.example/', weight: 40 }] },
  });
  const withTwo = srv.ctx.store.listTargets(srv.ctx.store.findLinkByCode('h4').id);
  assert.equal(withTwo.length, 2);

  await call(srv, cookie, '/admin/api/links/h4/targets', { method: 'PUT', body: { targets: [] } });
  assert.equal(srv.ctx.store.listTargets(srv.ctx.store.findLinkByCode('h4').id).length, 0);

  const { body: hist } = await call(srv, cookie, '/admin/api/links/h4/history');
  const twoTargets = hist.result.items.find((h) => Array.isArray(h.snapshot?.targets) && h.snapshot.targets.length === 2);
  assert.ok(twoTargets, '应该能找到「有两个分流目标」的那一版');

  await call(srv, cookie, `/admin/api/links/h4/history/${twoTargets.id}/rollback`, { method: 'POST' });
  const back = srv.ctx.store.listTargets(srv.ctx.store.findLinkByCode('h4').id);
  assert.equal(back.length, 2);
  assert.equal(back[0].weight, 60);
}));

test('批量改标签也留档，能整批退回去', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await call(srv, cookie, '/admin/api/links', { method: 'POST', body: { url: 'https://b1.example/', code: 'h5', tags: '旧标签' } });
  await call(srv, cookie, '/admin/api/links/batch', {
    method: 'POST',
    body: { action: 'tags', codes: ['h5'], tags: '新标签', mode: 'replace' },
  });
  assert.equal(srv.ctx.store.findLinkByCode('h5').tags, '新标签');

  const { body: hist } = await call(srv, cookie, '/admin/api/links/h5/history');
  const before = hist.result.items.find((h) => h.action === 'batch_tags');
  assert.ok(before);
  await call(srv, cookie, `/admin/api/links/h5/history/${before.id}/rollback`, { method: 'POST' });
  assert.equal(srv.ctx.store.findLinkByCode('h5').tags, '旧标签');
}));

test('回滚会失效跳转缓存，不会继续跳旧地址', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await call(srv, cookie, '/admin/api/links', { method: 'POST', body: { url: 'https://cache-old.example/', code: 'h6' } });
  // 先访问一次，把旧地址灌进缓存
  const first = await srv.fetch('/h6');
  assert.equal(first.status, 302);
  assert.equal(first.headers.get('location'), 'https://cache-old.example/');

  await call(srv, cookie, '/admin/api/links/h6', { method: 'PATCH', body: { url: 'https://cache-new.example/' } });
  const { body: hist } = await call(srv, cookie, '/admin/api/links/h6/history');
  const oldVersion = hist.result.items.find((h) => h.snapshot?.url === 'https://cache-old.example/');
  await call(srv, cookie, `/admin/api/links/h6/history/${oldVersion.id}/rollback`, { method: 'POST' });

  const third = await srv.fetch('/h6');
  assert.equal(third.headers.get('location'), 'https://cache-old.example/', '回滚后立刻生效，不能还跳缓存里的新地址');
}));

test('历史默认只留最近 20 版，不会无限长', () => {
  const dir = tmpDir();
  const config = loadConfig({ dataDir: dir });
  const store = openDatabase(path.join(dir, 'h.db'));
  const settings = new Settings(store, config);
  const history = new HistoryService({ store, settings });
  store.sql.insertLink.run('cap', 'https://c.example/', '', '', '', 'active', null, 1, 1, null, null);
  const id = store.db.prepare("SELECT id FROM links WHERE code = 'cap'").get().id;
  for (let i = 0; i < 30; i += 1) history.record(id, { action: `a${i}` });
  // 默认保留 20 版：30 次改动之后只剩最近 20 条
  assert.equal(store.sql.countHistory.get(id).n, 20);
});

test('historyKeep 调小后立刻按新上限裁剪', () => {
  const dir = tmpDir();
  const config = loadConfig({ dataDir: dir });
  const store = openDatabase(path.join(dir, 'h2.db'));
  const settings = new Settings(store, config);
  settings.update({ historyKeep: 3 });
  const history = new HistoryService({ store, settings });
  store.sql.insertLink.run('cap2', 'https://c.example/', '', '', '', 'active', null, 1, 1, null, null);
  const id = store.db.prepare("SELECT id FROM links WHERE code = 'cap2'").get().id;
  for (let i = 0; i < 10; i += 1) history.record(id, { action: `a${i}` });
  assert.equal(store.sql.countHistory.get(id).n, 3);
  // 留下的是最近的
  const rows = store.sql.listHistory.all(id, 10, 0);
  assert.equal(rows[0].action, 'a9');
});

test('彻底删除短链会连历史一起清掉', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await call(srv, cookie, '/admin/api/links', { method: 'POST', body: { url: 'https://p.example/', code: 'h7' } });
  await call(srv, cookie, '/admin/api/links/h7', { method: 'DELETE' });
  await call(srv, cookie, '/admin/api/trash/h7', { method: 'DELETE' });
  const left = srv.ctx.store.db.prepare("SELECT COUNT(*) AS n FROM link_history WHERE code = 'h7'").get().n;
  assert.equal(left, 0);
}));

test('历史记不上不影响主流程（快照异常时静默跳过）', () => {
  const dir = tmpDir();
  const store = openDatabase(path.join(dir, 'h3.db'));
  const settings = new Settings(store, loadConfig({ dataDir: dir }));
  const history = new HistoryService({ store, settings, logger: { warn() {} } });
  assert.equal(history.record(9999, { action: 'update' }), null);
});

test('备份带上历史，恢复后还能回滚', () => {
  const dir = tmpDir();
  const store = openDatabase(path.join(dir, 'b1.db'));
  const settings = new Settings(store, loadConfig({ dataDir: dir }));
  const history = new HistoryService({ store, settings });
  store.sql.insertLink.run('bk', 'https://bk.example/', '', '', '', 'active', null, 1, 1, null, null);
  const id = store.db.prepare("SELECT id FROM links WHERE code = 'bk'").get().id;
  history.record(id, { action: 'create' });

  const backup = buildBackup(store, { hostname: 'test' });
  assert.ok(Array.isArray(backup.link_history));
  assert.equal(backup.link_history.length, 1);
  assert.ok(backup.manifest.extraKeys.includes('link_history'));

  const dir2 = tmpDir();
  const store2 = openDatabase(path.join(dir2, 'b2.db'));
  const out = restoreBackup(store2, JSON.stringify(backup), { mode: 'merge' });
  assert.equal(out.history, 1);
  const id2 = store2.db.prepare("SELECT id FROM links WHERE code = 'bk'").get().id;
  assert.equal(store2.sql.countHistory.get(id2).n, 1);
});

test('老备份没有 link_history 也照旧判 ok，不会被判成损坏', async () => {
  const dir = tmpDir();
  const store = openDatabase(path.join(dir, 'b3.db'));
  const settings = new Settings(store, loadConfig({ dataDir: dir }));
  store.sql.insertLink.run('old', 'https://old.example/', '', '', '', 'active', null, 1, 1, null, null);
  const backup = buildBackup(store, { hostname: 'test' });
  // 模拟 v1.9 时期导出的备份：只有 click_slots 这一个后加集合，
  // link_history 与 extraKeys 都还不存在，extraChecksum 也只覆盖 click_slots
  // 后加集合连带清掉：这份「老备份」在各版本之前就存在，不该有它们的键
  delete backup.link_history;
  delete backup.landing_views;
  delete backup.reports;
  delete backup.manifest.extraKeys;
  backup.manifest.extraChecksum = checksumExtraOf({ click_slots: backup.click_slots || [] });
  const result = verifyBackup(backup);
  assert.equal(result.status, 'ok', result.reason);
});

test('manifest 声明了 link_history 但文件里整块不见，判 mismatch 并说清缺什么', () => {
  const dir = tmpDir();
  const store = openDatabase(path.join(dir, 'b4.db'));
  const settings = new Settings(store, loadConfig({ dataDir: dir }));
  const history = new HistoryService({ store, settings });
  store.sql.insertLink.run('tr', 'https://tr.example/', '', '', '', 'active', null, 1, 1, null, null);
  const id = store.db.prepare("SELECT id FROM links WHERE code = 'tr'").get().id;
  history.record(id, { action: 'create' });
  const backup = buildBackup(store, { hostname: 'test' });
  // 模拟被截断：link_history 整块消失，但 manifest 还声明过它
  delete backup.link_history;
  const result = verifyBackup(backup);
  assert.equal(result.status, 'mismatch');
  assert.match(result.reason, /link_history/);
});

test('历史快照里不含密码，避免把口令散到备份和界面里', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await call(srv, cookie, '/admin/api/links', { method: 'POST', body: { url: 'https://pwd.example/', code: 'h8' } });
  await call(srv, cookie, '/admin/api/links/h8/password', { method: 'POST', body: { password: 'secret123' } });
  const { body } = await call(srv, cookie, '/admin/api/links/h8/history');
  for (const item of body.result.items) {
    assert.equal(Object.prototype.hasOwnProperty.call(item.snapshot || {}, 'password'), false);
  }
}));

test('回滚到别的短链的版本会被拒绝', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await call(srv, cookie, '/admin/api/links', { method: 'POST', body: { url: 'https://x1.example/', code: 'hx1' } });
  await call(srv, cookie, '/admin/api/links', { method: 'POST', body: { url: 'https://x2.example/', code: 'hx2' } });
  const { body: hist } = await call(srv, cookie, '/admin/api/links/hx1/history');
  const idOfOther = hist.result.items[0].id;
  const { res } = await call(srv, cookie, `/admin/api/links/hx2/history/${idOfOther}/rollback`, { method: 'POST' });
  assert.equal(res.status, 404);
}));

test('diffSnapshots 只报真正变化的字段，并给中文标签', () => {
  const a = { url: 'https://a.com/1', title: 'A', tags: 'x', status: 'active', group_name: 'G1', targets: [{ url: 'https://t1.com' }] };
  const b = { url: 'https://a.com/1', title: 'B', tags: 'x', status: 'disabled', group_name: 'G1', targets: [{ url: 'https://t2.com' }] };
  const changes = diffSnapshots(a, b);
  const fields = changes.map((c) => c.field).sort();
  assert.deepEqual(fields, ['status', 'targets', 'title'], '只有这三项变了');
  const title = changes.find((c) => c.field === 'title');
  assert.equal(title.label, '标题');
  assert.equal(title.from, 'A');
  assert.equal(title.to, 'B');
  const status = changes.find((c) => c.field === 'status');
  assert.equal(status.from, '生效中');
  assert.equal(status.to, '已停用');
  const targets = changes.find((c) => c.field === 'targets');
  assert.deepEqual(targets.added, ['https://t2.com']);
  assert.deepEqual(targets.removed, ['https://t1.com']);
});

test('diffSnapshots 相同快照返回空，分组与有效期空值按「未分组 / 无」比', () => {
  const s = { url: 'https://a.com/1', status: 'active', group_name: 'G', expire_at: null };
  assert.deepEqual(diffSnapshots(s, { ...s }), []);
  const changes = diffSnapshots({ ...s, group_name: '' }, s);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].from, '未分组');
  assert.equal(changes[0].to, 'G');

  const exp = diffSnapshots({ expire_at: null }, { expire_at: Date.UTC(2027, 0, 2) });
  assert.equal(exp.length, 1);
  assert.equal(exp[0].from, '');
  assert.equal(exp[0].to, '2027-01-02');
});

test('GET history/diff 对比历史版本与当前状态', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await call(srv, cookie, '/admin/api/links', { method: 'POST', body: { url: 'https://old.example/a', code: 'df1', title: '旧标题' } });
  await call(srv, cookie, '/admin/api/links/df1', { method: 'PATCH', body: { url: 'https://new.example/b', title: '新标题' } });

  const { body: hist } = await call(srv, cookie, '/admin/api/links/df1/history');
  const first = hist.result.items.find((h) => h.snapshot?.url === 'https://old.example/a');

  const { res, body } = await call(srv, cookie, `/admin/api/links/df1/history/diff?from=${first.id}&to=0`);
  assert.equal(res.status, 200);
  assert.equal(body.result.same, false);
  const fields = body.result.changes.map((c) => c.field).sort();
  assert.deepEqual(fields, ['title', 'url']);

  // 和它自己比应该没有差异
  const self = await call(srv, cookie, `/admin/api/links/df1/history/diff?from=${first.id}&to=${first.id}`);
  assert.equal(self.body.result.same, true);
  assert.deepEqual(self.body.result.changes, []);

  // 缺 from 参数要报 400，而不是拿 NaN 去查库
  const missing = await call(srv, cookie, '/admin/api/links/df1/history/diff');
  assert.equal(missing.res.status, 400);
  assert.equal(missing.body.error.code, 'from_required');

  // 版本 id 属于别的短链，不能跨链对比
  await call(srv, cookie, '/admin/api/links', { method: 'POST', body: { url: 'https://x.example/', code: 'df2' } });
  const cross = await call(srv, cookie, `/admin/api/links/df2/history/diff?from=${first.id}`);
  assert.equal(cross.res.status, 404);
}));
