import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDatabase, SCHEMA_VERSION } from '../src/lib/db.js';
import { LinkCache } from '../src/services/link-cache.js';
import { UaFilter } from '../src/services/ua-filter.js';
import { startTestServer, tmpDir } from './helpers.js';

/** 造一个「已经跑过 v2、但库里存在大小写重复短码」的老库 */
function seedLegacyDb() {
  const dir = tmpDir();
  const file = path.join(dir, 'legacy.db');
  openDatabase(file).close();
  const db = new DatabaseSync(file);
  db.exec('DROP INDEX idx_links_code_nocase');
  const insert = db.prepare('INSERT INTO links (code, url, clicks, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
  insert.run('abc', 'https://example.com/first', 10, 100, 100);
  insert.run('ABC', 'https://example.com/second', 7, 200, 200);
  insert.run('other', 'https://example.com/other', 3, 300, 300);
  db.prepare("INSERT INTO click_daily (code, day, clicks) VALUES ('ABC', '2026-01-01', 7), ('abc', '2026-01-01', 10)").run();
  db.prepare("INSERT INTO click_refs (code, host, clicks) VALUES ('ABC', 'from-b.com', 7)").run();
  db.prepare("INSERT INTO click_agents (code, platform, clicks) VALUES ('ABC', 'ios', 7)").run();
  db.prepare("UPDATE schema_meta SET value = '2' WHERE key = 'version'").run();
  db.close();
  return { file, dir };
}

test('v3 迁移收敛大小写重复短码，保留最早创建的那条', () => {
  const { file } = seedLegacyDb();
  const store = openDatabase(file);
  assert.equal(Number(store.db.prepare("SELECT value FROM schema_meta WHERE key='version'").get().value), SCHEMA_VERSION);

  const rows = store.db.prepare('SELECT code, url, clicks FROM links ORDER BY id').all();
  assert.equal(rows.length, 3, '不能丢记录');
  assert.equal(rows[0].code, 'abc', '最早创建的保留原拼写');
  assert.equal(rows[0].url, 'https://example.com/first', '保留的那条内容不被覆盖');
  assert.equal(rows[1].code, 'ABC-2', '后来的改到新短码');
  assert.equal(rows[1].url, 'https://example.com/second');
  assert.equal(rows[2].code, 'other', '无关记录不动');

  // 统计跟着改名走，不能变成孤儿
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM click_daily WHERE code IN ('abc','ABC')").get().n, 1);
  assert.equal(store.db.prepare("SELECT clicks FROM click_daily WHERE code = 'ABC-2'").get().clicks, 7);
  assert.equal(store.db.prepare("SELECT clicks FROM click_refs WHERE code = 'ABC-2'").get().clicks, 7);
  assert.equal(store.db.prepare("SELECT clicks FROM click_agents WHERE code = 'ABC-2'").get().clicks, 7);

  // 留一条审计，事后能查为什么短码变了
  const audit = store.db.prepare("SELECT * FROM audit_log WHERE action = 'link.code_dedupe'").all();
  assert.equal(audit.length, 1);
  assert.match(audit[0].detail, /ABC->ABC-2/);
  store.close();
});

test('v3 之后数据库层就拦住大小写重复，批量路径也绕不过去', () => {
  const dir = tmpDir();
  const store = openDatabase(path.join(dir, 'x.db'));
  store.db.prepare("INSERT INTO links (code, url, created_at, updated_at) VALUES ('mixed', 'https://a.com', 1, 1)").run();
  for (const code of ['MIXED', 'Mixed', 'mIxEd']) {
    assert.throws(
      () => store.db.prepare("INSERT INTO links (code, url, created_at, updated_at) VALUES (?, 'https://b.com', 2, 2)").run(code),
      /UNIQUE|constraint/i,
      `${code} 应被唯一索引拦住`,
    );
  }
  // 备份恢复用的 upsert 也应落到同一行，而不是新增一行
  store.db
    .prepare(`INSERT INTO links (code, url, created_at, updated_at) VALUES (?, ?, 3, 3)
      ON CONFLICT(code COLLATE NOCASE) DO UPDATE SET url = excluded.url`)
    .run('MiXeD', 'https://patched.com');
  const rows = store.db.prepare('SELECT code, url FROM links').all();
  assert.equal(rows.length, 1, '不应新增行');
  assert.equal(rows[0].url, 'https://patched.com', '应更新到已有那行');
  store.close();
});

test('迁移可重复执行：已经是 v3 的库再打开不出错', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'again.db');
  openDatabase(file).close();
  openDatabase(file).close();
  const store = openDatabase(file);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'idx_links_code_nocase'").get().n,
    1,
  );
  store.close();
});

test('缓存过期时删的是缓存键，不是原始入参', () => {
  const store = openDatabase(path.join(tmpDir(), 'c.db'));
  store.db.prepare("INSERT INTO links (code, url, created_at, updated_at) VALUES ('camelCase', 'https://a.com', 1, 1)").run();
  const cache = new LinkCache(store, { ttlMs: -1 });
  cache.set('camelCase', { code: 'camelCase' });
  // ttl 为负，写入即过期。用不同大小写去读，这条必须真的被清掉
  assert.equal(cache.get('CAMELCASE'), null);
  assert.equal(cache.map.size, 0, '过期的条目应被删掉，不能留在 Map 里占位');
  store.close();
});

test('UA 命中计数按累加值一次落库', () => {
  const store = openDatabase(path.join(tmpDir(), 'r.db'));
  store.sql.insertRule.run('ua', '*bot*', 'test', 1, Date.now());
  const filter = new UaFilter(store, { get: () => true });
  for (let i = 0; i < 250; i += 1) filter.match({ ua: 'SomeBot/1.0' });
  filter.flushHits();
  assert.equal(store.sql.listRules.all()[0].hits, 250);
  assert.equal(filter.hits.length, 0, '刷盘后缓冲应清空');
  // 再命中一批应继续累加，不覆盖
  filter.match({ ua: 'SomeBot' });
  filter.flushHits();
  assert.equal(store.sql.listRules.all()[0].hits, 251);
  store.close();
});

test('非法百分号编码的静态路径返回 404 而不是 500', async () => {
  const srv = await startTestServer();
  try {
    for (const p of ['/static/%zz', '/img/%zz']) {
      const res = await srv.fetch(p);
      assert.equal(res.status, 404, `${p} 应 404`);
    }
    const ok = await srv.fetch('/static/app.css');
    assert.equal(ok.status, 200, '正常静态资源不受影响');
  } finally {
    await srv.stop();
  }
});

test('目录遍历仍被挡住', async () => {
  const srv = await startTestServer();
  try {
    for (const p of ['/static/../../package.json', '/static/..%2f..%2fpackage.json', '/static/%2e%2e/%2e%2e/package.json']) {
      const res = await srv.fetch(p);
      assert.ok(res.status === 404 || res.status === 400, `${p} 不该读到文件，实际 ${res.status}`);
      const body = await res.text();
      assert.ok(!body.includes('"name": "highurl"'), `${p} 泄漏了 package.json`);
    }
    assert.ok(fs.existsSync(path.join(process.cwd(), 'package.json')));
  } finally {
    await srv.stop();
  }
});
