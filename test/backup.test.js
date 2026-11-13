import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeStore, startTestServer, tmpDir } from './helpers.js';
import { buildBackup, verifyBackup, checksumOf, listBackups, backupPath, FORMAT } from '../src/services/backup.js';
import { inspectBackup, restoreBackup } from '../src/services/restore.js';

function seed(store) {
  const ts = Date.now();
  store.db.prepare("INSERT INTO groups (name, color, note, created_at, updated_at) VALUES ('活动', '#8b5cf6', '', ?, ?)").run(ts, ts);
  const gid = store.db.prepare("SELECT id FROM groups WHERE name = '活动'").get().id;
  store.db
    .prepare("INSERT INTO links (code, url, title, tags, status, clicks, created_at, updated_at, group_id) VALUES ('promo', 'https://example.com/p', '推广页', 'a,b', 'active', 12, ?, ?, ?)")
    .run(ts, ts, gid);
  store.db.prepare("INSERT INTO click_daily (code, day, clicks) VALUES ('promo', '2026-11-12', 12)").run();
  return store;
}

test('导出的备份带 manifest：版本、主机、计数、校验和', () => {
  const { store } = makeStore();
  seed(store);
  const dump = buildBackup(store, { hostname: 'box-1' });
  assert.equal(dump.format, FORMAT);
  assert.equal(dump.manifest.hostname, 'box-1');
  assert.equal(dump.manifest.algorithm, 'sha256');
  assert.equal(dump.manifest.counts.links, 1);
  assert.equal(dump.manifest.counts.groups, 1);
  assert.equal(dump.manifest.checksum, checksumOf(dump));
  // 老字段还在，早期版本的程序读得懂
  assert.equal(typeof dump.version, 'number');
  assert.equal(typeof dump.exportedAt, 'string');
  store.close();
});

test('verifyBackup 三态：ok / mismatch / legacy', () => {
  const { store } = makeStore();
  seed(store);
  const dump = buildBackup(store);
  assert.equal(verifyBackup(dump).status, 'ok');

  const broken = JSON.parse(JSON.stringify(dump));
  broken.links[0].title = '改过的标题';
  const mismatch = verifyBackup(broken);
  assert.equal(mismatch.status, 'mismatch');
  // 计数没变，但内容变了：得说清是 checksum 不匹配而不是数字对不上
  assert.match(mismatch.reason, /checksum 不匹配|不一致/);

  const shrunk = JSON.parse(JSON.stringify(dump));
  shrunk.links = [];
  const counted = verifyBackup(shrunk);
  assert.equal(counted.status, 'mismatch');
  assert.match(counted.reason, /links 1→0/);

  const legacy = { version: 4, links: [], click_daily: [] };
  assert.equal(verifyBackup(legacy).status, 'legacy');
  assert.equal(verifyBackup('not json').status, 'invalid');
  assert.equal(verifyBackup('{"a":1}').status, 'invalid');
  store.close();
});

test('checksum 对 settings 也敏感，改一个设置值就验不过', () => {
  const { store } = makeStore();
  seed(store);
  store.sql.setSetting.run('siteName', '改名了');
  const dump = buildBackup(store);
  const copy = JSON.parse(JSON.stringify(dump));
  copy.settings = copy.settings.map((s) => (s.key === 'siteName' ? { ...s, value: '又改了' } : s));
  assert.equal(verifyBackup(copy).status, 'mismatch');
  store.close();
});

test('预检报告里带完整性结论', () => {
  const { store } = makeStore();
  seed(store);
  const dump = buildBackup(store);
  assert.equal(inspectBackup(dump, store).integrity.status, 'ok');
  const broken = { ...dump, links: [] };
  assert.equal(inspectBackup(broken, store).integrity.status, 'mismatch');
  store.close();
});

test('校验不通过时默认拒绝恢复，force 才写库', () => {
  const src = makeStore();
  seed(src.store);
  const dump = buildBackup(src.store);
  src.store.close();

  const tampered = JSON.parse(JSON.stringify(dump));
  tampered.links.push({ code: 'extra', url: 'https://example.com/x', status: 'active' });

  const dst = makeStore();
  assert.throws(
    () => restoreBackup(dst.store, tampered, { mode: 'merge' }),
    (err) => {
      assert.equal(err.code, 'backup_checksum');
      assert.match(err.message, /完整性校验未通过/);
      return true;
    },
  );
  assert.equal(dst.store.sql.countLinks.get().n, 0, '被拒绝时一条都不能写进去');

  const out = restoreBackup(dst.store, tampered, { mode: 'merge', force: true });
  assert.equal(out.restored, 2);
  dst.store.close();
});

test('老备份的分流目标缺 weight / enabled 也能恢复', () => {
  // 早期导出没有这两列。曾经写成 Number(x) ?? 100，Number(undefined) 是 NaN，
  // ?? 兜不住 NaN，于是 SQL 直接 NOT NULL 约束失败，整个恢复事务回滚。
  const { store } = makeStore();
  const ts = Date.now();
  store.db.prepare("INSERT INTO links (code, url, created_at, updated_at) VALUES ('a', 'https://example.com', ?, ?)").run(ts, ts);
  const backup = {
    version: 4,
    links: [{ code: 'a', url: 'https://example.com', status: 'active' }],
    link_targets: [{ code: 'a', url: 'https://example.com/b', label: 'B 版' }],
  };
  const out = restoreBackup(store, backup, { mode: 'merge' });
  assert.equal(out.targets, 1);
  const row = store.db.prepare('SELECT weight, enabled FROM link_targets').get();
  assert.equal(row.weight, 100);
  assert.equal(row.enabled, 1);
  store.close();
});

test('恢复拒绝显式的 weight 非法值', () => {
  const { store } = makeStore();
  const ts = Date.now();
  store.db.prepare("INSERT INTO links (code, url, created_at, updated_at) VALUES ('a', 'https://example.com', ?, ?)").run(ts, ts);
  const backup = {
    version: 5,
    links: [{ code: 'a', url: 'https://example.com', status: 'active' }],
    link_targets: [{ code: 'a', url: 'https://example.com/b', weight: 'abc', enabled: '0' }],
  };
  restoreBackup(store, backup, { mode: 'merge' });
  const row = store.db.prepare('SELECT weight, enabled FROM link_targets').get();
  assert.equal(row.weight, 100, '非法值退回默认权重而不是写 NaN');
  assert.equal(row.enabled, 0, '字符串 "0" 也当成关停');
  store.close();
});

test('listBackups 能识别坏文件，backupPath 挡住路径穿越', () => {
  const dir = tmpDir();
  const { store } = makeStore();
  seed(store);
  const good = buildBackup(store);
  store.close();
  fs.writeFileSync(path.join(dir, 'highurl-2026-11-12.json'), JSON.stringify(good));
  fs.writeFileSync(path.join(dir, 'highurl-2026-11-13.json'), '{"links":[]}');
  const tampered = JSON.parse(JSON.stringify(good));
  tampered.links = [];
  fs.writeFileSync(path.join(dir, 'highurl-2026-11-14.json'), JSON.stringify(tampered));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignore me');

  const items = listBackups(dir);
  assert.equal(items.length, 3);
  const byName = Object.fromEntries(items.map((i) => [i.name, i]));
  assert.equal(byName['highurl-2026-11-12.json'].integrity, 'ok');
  assert.equal(byName['highurl-2026-11-13.json'].integrity, 'legacy');
  assert.equal(byName['highurl-2026-11-14.json'].integrity, 'mismatch');
  assert.equal(byName['highurl-2026-11-12.json'].counts.links, 1);

  assert.ok(backupPath(dir, 'highurl-2026-11-12.json'));
  assert.equal(backupPath(dir, '../../etc/passwd'), null);
  assert.equal(backupPath(dir, 'notes.txt'), null);
  assert.equal(backupPath(dir, 'highurl-2099-01-01.json'), null);
});

test('管理台接口：自动备份列表、复核、下载、路径穿越防守', async () => {
  const srv = await startTestServer();
  try {
    srv.ctx.auth.createAdmin('admin', 'password123');
    const res = await srv.fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: 'password123' }).toString(),
    });
    const cookie = (res.headers.getSetCookie?.() || [res.headers.get('set-cookie')])
      .map((c) => String(c).split(';')[0])
      .join('; ');

    // 手工放两份文件进备份目录：一份正确、一份被截断
    const { buildBackup } = await import('../src/services/backup.js');
    fs.mkdirSync(srv.ctx.config.backupDir, { recursive: true });
    const good = buildBackup(srv.ctx.store, { hostname: 'src-box' });
    fs.writeFileSync(path.join(srv.ctx.config.backupDir, 'highurl-2026-11-12.json'), JSON.stringify(good));
    fs.writeFileSync(path.join(srv.ctx.config.backupDir, 'highurl-2026-11-11.json'), '{"links":[]}');

    const list = await srv.json('/admin/api/backups', { headers: { Cookie: cookie } });
    assert.equal(list.res.status, 200);
    assert.equal(list.body.result.items.length, 2);
    assert.equal(list.body.result.retention, 14);

    const verifyOk = await srv.json('/admin/api/backups/highurl-2026-11-12.json/verify', { headers: { Cookie: cookie } });
    assert.equal(verifyOk.body.result.status, 'ok');

    const download = await srv.fetch('/admin/api/backups/highurl-2026-11-12.json', { headers: { Cookie: cookie } });
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /highurl-2026-11-12\.json/);

    const escape = await srv.json('/admin/api/backups/..%2F..%2Fetc%2Fpasswd', { headers: { Cookie: cookie } });
    assert.equal(escape.res.status, 404);

    const noLogin = await srv.json('/admin/api/backups');
    assert.equal(noLogin.res.status, 401);
  } finally {
    await srv.stop();
  }
});

test('自动备份先写临时文件再落地，残留 .tmp 会被清掉', async () => {
  const srv = await startTestServer();
  try {
    const dir = srv.ctx.config.backupDir;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'highurl-2026-01-01.json.tmp'), '半截');
    const { pruneBackups } = await import('../src/services/maintenance.js');
    pruneBackups(dir, 14);
    assert.equal(fs.existsSync(path.join(dir, 'highurl-2026-01-01.json.tmp')), false);

    await srv.ctx.maintenance.tick();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.ok(files.length >= 1, '维护巡检应生成当天的自动备份');
    const v = verifyBackup(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    assert.equal(v.status, 'ok', '自动备份也要带得上校验和');
  } finally {
    await srv.stop();
  }
});

test('恢复接口默认拦下校验不通过的备份，force 才执行', async () => {
  const srv = await startTestServer();
  try {
    srv.ctx.auth.createAdmin('admin', 'password123');
    const res = await srv.fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: 'password123' }).toString(),
    });
    const cookie = (res.headers.getSetCookie?.() || [res.headers.get('set-cookie')])
      .map((c) => String(c).split(';')[0])
      .join('; ');

    const good = buildBackup(srv.ctx.store);
    good.links.push({ code: 'restored', url: 'https://example.com/r', status: 'active' });
    // 文件被改过：manifest 还停在导出时的状态
    const body = JSON.stringify({ content: JSON.stringify(good), mode: 'merge' });

    const denied = await srv.json('/admin/api/restore', { method: 'POST', headers: { Cookie: cookie }, body });
    assert.equal(denied.res.status, 400);
    assert.equal(denied.body.error.code, 'backup_checksum');
    assert.equal(srv.ctx.store.sql.countLinks.get().n, 0);

    const forced = await srv.json('/admin/api/restore', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: JSON.stringify({ content: JSON.stringify(good), mode: 'merge', force: true }),
    });
    assert.equal(forced.res.status, 200);
    assert.equal(forced.body.result.restored, 1);
  } finally {
    await srv.stop();
  }
});
