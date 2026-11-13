import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { openDatabase, SCHEMA_VERSION } from '../src/lib/db.js';
import { makeStore, tmpDir } from './helpers.js';

/** 直插一条短链（含 clicks），方便构造测试数据 */
function seed(store, { code, url = 'https://example.com', title = '', note = '', tags = '', status = 'active', clicks = 0, createdAt = 1, expireAt = null }) {
  store.db
    .prepare(`INSERT INTO links (code, url, title, note, tags, status, password, clicks, created_at, updated_at, expire_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`)
    .run(code, url, title, note, tags, status, clicks, createdAt, createdAt, expireAt);
}

test('建库写入 schema 版本与全部表', () => {
  const { store } = makeStore();
  const version = store.db.prepare("SELECT value FROM schema_meta WHERE key='version'").get();
  assert.equal(Number(version.value), SCHEMA_VERSION);
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const name of ['links', 'click_daily', 'click_refs', 'click_agents', 'settings', 'admins', 'api_keys', 'ua_rules', 'audit_log']) {
    assert.ok(tables.includes(name), `缺少表 ${name}`);
  }
  store.close();
});

test('WAL 模式已开启', () => {
  const { store } = makeStore();
  assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  store.close();
});

test('重复打开同一文件不会重复迁移', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'x.db');
  const a = openDatabase(file);
  a.db.prepare("INSERT INTO links (code, url, created_at, updated_at) VALUES ('abc', 'https://example.com', 1, 1)").run();
  a.close();
  const b = openDatabase(file);
  assert.equal(b.sql.countLinks.get().n, 1);
  assert.equal(Number(b.db.prepare("SELECT value FROM schema_meta WHERE key='version'").get().value), SCHEMA_VERSION);
  b.close();
});

test('短码唯一约束生效', () => {
  const { store } = makeStore();
  store.db.prepare("INSERT INTO links (code, url, created_at, updated_at) VALUES ('dup', 'https://a.com', 1, 1)").run();
  assert.throws(() => store.db.prepare("INSERT INTO links (code, url, created_at, updated_at) VALUES ('dup', 'https://b.com', 1, 1)").run(), /UNIQUE/i);
  store.close();
});

test('listLinks 支持搜索、状态与排序', () => {
  const { store } = makeStore();
  const add = (code, url, title, status, clicks, createdAt) =>
    seed(store, { code, url, title, status, clicks, createdAt, tags: 'tag1' });
  add('a1', 'https://example.com/one', '第一篇', 'active', 5, 1000);
  add('b2', 'https://other.com/two', '第二篇', 'disabled', 50, 2000);
  add('c3', 'https://example.com/three', '第三篇', 'active', 500, 3000);

  assert.equal(store.listLinks({}).total, 3);
  assert.equal(store.listLinks({ q: 'example.com' }).total, 2);
  assert.equal(store.listLinks({ q: '第三篇' }).total, 1);
  assert.equal(store.listLinks({ status: 'disabled' }).total, 1);
  assert.equal(store.listLinks({ tag: 'tag1' }).total, 3);
  assert.equal(store.listLinks({ tag: 'nope' }).total, 0);

  assert.deepEqual(store.listLinks({ sort: 'clicks_desc' }).rows.map((r) => r.code), ['c3', 'b2', 'a1']);
  assert.deepEqual(store.listLinks({ sort: 'created_asc' }).rows.map((r) => r.code), ['a1', 'b2', 'c3']);
  // 非法排序回落到默认，不抛错
  assert.equal(store.listLinks({ sort: '; DROP TABLE links' }).rows.length, 3);

  const paged = store.listLinks({ page: 2, perPage: 2, sort: 'created_asc' });
  assert.deepEqual(paged.rows.map((r) => r.code), ['c3']);
  store.close();
});

test('statsOverview 汇总点击与状态', () => {
  const { store } = makeStore();
  seed(store, { code: 'x1', url: 'https://a.com', clicks: 10 });
  seed(store, { code: 'x2', url: 'https://b.com', status: 'disabled', clicks: 5 });
  seed(store, { code: 'x3', url: 'https://c.com', expireAt: Date.now() - 1000 });
  const stats = store.statsOverview('2000-01-01');
  assert.equal(stats.total, 3);
  assert.equal(stats.clicks, 15);
  assert.equal(stats.active, 2);
  assert.equal(stats.expired, 1);
  store.close();
});

test('exportAll 覆盖所有业务表', () => {
  const { store } = makeStore();
  seed(store, { code: 'e1', title: 'T', note: 'n', tags: 'tag', clicks: 3 });
  store.sql.upsertDaily.run('e1', '2025-01-01', 3);
  store.sql.insertRule.run('ua', 'BadBot', '测试', 1, Date.now());
  const dump = store.exportAll();
  assert.equal(dump.links.length, 1);
  assert.equal(dump.click_daily.length, 1);
  assert.equal(dump.ua_rules.length, 1);
  assert.ok(Array.isArray(dump.settings));
  assert.ok(dump.exportedAt);
  store.close();
});

test('listTags 去重并统计频次', () => {
  const { store } = makeStore();
  seed(store, { code: 't1', tags: 'x,y' });
  seed(store, { code: 't2', url: 'https://b.com', tags: 'y,z' });
  const tags = store.listTags();
  assert.equal(tags[0].tag, 'y');
  assert.equal(tags[0].count, 2);
  store.close();
});

test('版本高于程序支持时拒绝启动', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'future.db');
  const store = openDatabase(file);
  store.db.prepare("UPDATE schema_meta SET value = ? WHERE key='version'").run(String(SCHEMA_VERSION + 5));
  store.close();
  assert.throws(() => openDatabase(file), /高于当前程序支持/);
});

test('数据库文件落在指定目录', () => {
  const { store, dir } = makeStore();
  assert.ok(fs.existsSync(path.join(dir, 'test.db')));
  store.close();
});

test('搜索与标签过滤转义 LIKE 通配符', () => {
  const { store } = makeStore();
  seed(store, { code: 'w1', url: 'https://a.com', tags: '100%off', title: '五折_促销 100%正品' });
  seed(store, { code: 'w2', url: 'https://b.com', tags: '普通', title: '平常标题' });

  assert.equal(store.listLinks({ tag: '100%off' }).total, 1);
  assert.equal(store.listLinks({ tag: '%' }).total, 0, '% 不能被当成通配符');
  assert.equal(store.listLinks({ tag: '100%' }).total, 0);
  // 搜索走 code/url/title/note 四列，不含 tags
  assert.equal(store.listLinks({ q: '100%off' }).total, 0);
  assert.equal(store.listLinks({ q: '100%' }).total, 1);
  assert.equal(store.listLinks({ q: '%' }).total, 1, '只命中真的含 % 的那条');
  assert.equal(store.listLinks({ q: '五折_' }).total, 1);
  assert.equal(store.listLinks({ q: '_' }).total, 1);
  assert.equal(store.listLinks({ q: '100%正品' }).total, 1);
});

test('旧库（v1）升级到 v2 保留数据并补上分组与回收站列', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'old.db');
  // 先建出完整库，再把它退回 v1 的样子，模拟已经在跑的老部署
  const seed = openDatabase(file);
  seed.db.exec("INSERT INTO links (code, url, clicks, created_at, updated_at) VALUES ('legacy', 'https://example.com/old', 42, 1, 1)");
  seed.db.exec('DROP INDEX idx_links_group');
  seed.db.exec('DROP INDEX idx_links_deleted');
  seed.db.exec('ALTER TABLE links DROP COLUMN group_id');
  seed.db.exec('ALTER TABLE links DROP COLUMN deleted_at');
  seed.db.exec('DROP TABLE groups');
  seed.db.prepare("UPDATE schema_meta SET value = '1' WHERE key = 'version'").run();
  seed.close();

  const store = openDatabase(file);
  assert.equal(Number(store.db.prepare("SELECT value FROM schema_meta WHERE key='version'").get().value), SCHEMA_VERSION);
  const row = store.sql.getLinkByCode.get('legacy');
  assert.equal(row.clicks, 42, '升级不能丢老数据');
  assert.equal(row.group_id, null);
  assert.equal(row.deleted_at, null);
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.ok(tables.includes('groups'));
  store.close();
});
