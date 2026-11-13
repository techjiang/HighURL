import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseYourlsDump, parseHighUrlExport, detectFormat, planImport, applyImport, parseCsv, parseCsvExport,
} from '../src/services/migrate.js';
import { makeStore } from './helpers.js';

const DUMP = `-- MySQL dump
-- Host: localhost    Database: yourls
/*!40101 SET NAMES utf8 */;

DROP TABLE IF EXISTS \`yourls_url\`;
CREATE TABLE \`yourls_url\` (
  \`url\` text NOT NULL,
  \`keyword\` varchar(200) NOT NULL,
  \`title\` text,
  \`timestamp\` datetime DEFAULT NULL,
  \`ip\` varchar(41),
  \`clicks\` int(10) unsigned DEFAULT 0
);

INSERT INTO \`yourls_url\` VALUES ('https://example.com/a','abc','示例 A','2024-01-02 03:04:05','1.2.3.4',17),('https://example.com/b','def','示例 B','2024-02-03 04:05:06','5.6.7.8',0);

INSERT INTO \`yourls_options\` VALUES (1,'yourls_siteurl','https://s.example.com'),(2,'yourls_unique','x');
`;

test('解析 YOURLS dump 的行数与字段', () => {
  const { links } = parseYourlsDump(DUMP);
  assert.equal(links.length, 2);
  assert.deepEqual(links[0], {
    code: 'abc',
    url: 'https://example.com/a',
    title: '示例 A',
    clicks: 17,
    createdAt: Date.parse('2024-01-02T03:04:05'),
    ip: '1.2.3.4',
  });
  assert.equal(links[1].code, 'def');
  assert.equal(links[1].clicks, 0);
});

test('解析带列名与转义字符的 INSERT', () => {
  const sql = `INSERT INTO \`yourls_url\` (\`keyword\`, \`url\`, \`title\`, \`timestamp\`, \`ip\`, \`clicks\`) VALUES
    ('k1','https://example.com/it''s','引号''测试','2024-03-04 05:06:07','9.9.9.9',3),
    ('k2','https://example.com/x?y=1','转义\\\\反斜杠','2024-03-05 06:07:08','8.8.8.8',4);`;
  const { links } = parseYourlsDump(sql);
  assert.equal(links.length, 2);
  assert.equal(links[0].title, "引号'测试");
  assert.equal(links[1].url, 'https://example.com/x?y=1');
});

test('没有 yourls_url 表时抛出可读错误', () => {
  assert.throws(() => parseYourlsDump('INSERT INTO other VALUES (1);'), /yourls_url/);
});

test('detectFormat 按内容与扩展名判断', () => {
  assert.equal(detectFormat(DUMP, 'dump.sql'), 'yourls');
  assert.equal(detectFormat('{"links":[]}', 'x.json'), 'highurl');
  assert.equal(detectFormat('  {"links":[]}'), 'highurl');
  assert.equal(detectFormat('random text', 'x.txt'), 'unknown');
});

test('parseHighUrlExport 映射字段', () => {
  const parsed = parseHighUrlExport({
    links: [{ code: 'h1', url: 'https://example.com', title: 'T', clicks: 9, created_at: 1700000000000, tags: 'a,b', note: 'n', status: 'active' }],
  });
  assert.equal(parsed.links.length, 1);
  assert.equal(parsed.links[0].code, 'h1');
  assert.equal(parsed.links[0].clicks, 9);
  assert.equal(parsed.links[0].createdAt, 1700000000000);
  assert.throws(() => parseHighUrlExport('{}'), /不是有效的 HighURL 导出文件/);
});

test('planImport 分出导入 / 冲突 / 无效', () => {
  const { store } = makeStore();
  store.db.prepare("INSERT INTO links (code, url, created_at, updated_at) VALUES ('taken', 'https://x.com', 1, 1)").run();
  const parsed = {
    links: [
      { code: 'fresh', url: 'https://a.com' },
      { code: 'taken', url: 'https://b.com' },
      { code: 'bad code!', url: 'https://c.com' },
      { code: 'noScheme', url: 'ftp://c.com' },
      { code: 'fresh', url: 'https://dup.com' },
    ],
  };
  const plan = planImport(store, parsed);
  assert.deepEqual(plan.import.map((i) => i.code), ['fresh']);
  assert.deepEqual(plan.conflict.map((i) => i.code), ['taken']);
  assert.equal(plan.invalid.length, 3);
  store.close();
});

test('planImport overwrite 时冲突条进入导入队列', () => {
  const { store } = makeStore();
  store.db.prepare("INSERT INTO links (code, url, created_at, updated_at) VALUES ('taken', 'https://x.com', 1, 1)").run();
  const plan = planImport(store, { links: [{ code: 'taken', url: 'https://new.com' }] }, { overwrite: true });
  assert.equal(plan.import.length, 1);
  assert.equal(plan.import[0].overwrite, true);
  assert.equal(plan.conflict.length, 0);
  store.close();
});

test('applyImport 写入库并累计点击数', () => {
  const { store } = makeStore();
  const { links: parsedLinks } = parseYourlsDump(DUMP);
  const plan = planImport(store, { links: parsedLinks });
  const stats = applyImport(store, plan);
  assert.deepEqual(stats, { created: 2, updated: 0, groups: 0, total: 2 });
  const row = store.sql.getLinkByCode.get('abc');
  assert.equal(row.url, 'https://example.com/a');
  assert.equal(row.clicks, 17);
  assert.equal(row.title, '示例 A');
  store.close();
});

test('applyImport 覆盖模式更新已有记录', () => {
  const { store } = makeStore();
  store.db.prepare("INSERT INTO links (code, url, created_at, updated_at) VALUES ('abc', 'https://old.com', 1, 1)").run();
  const plan = planImport(store, { links: [{ code: 'abc', url: 'https://new.com', title: '新', clicks: 42 }] }, { overwrite: true });
  const stats = applyImport(store, plan);
  assert.equal(stats.updated, 1);
  const row = store.sql.getLinkByCode.get('abc');
  assert.equal(row.url, 'https://new.com');
  assert.equal(row.clicks, 42);
  store.close();
});

test('导入后写审计日志', () => {
  const { store } = makeStore();
  const plan = planImport(store, { links: [{ code: 'aud', url: 'https://a.com' }] });
  applyImport(store, plan);
  const audit = store.sql.listAudit.all(10)[0];
  assert.equal(audit.action, 'migrate.import');
  store.close();
});

test('parseCsv 处理引号、逗号与换行，不把备注拆错列', () => {
  const text = '\uFEFFcode,url,title,group,tags,note,status,clicks,created_at,last_click_at,expire_at\r\n'
    + 'a,https://example.com/a,"标题,带逗号",G1,"t1,t2","备注\r\n第二行",active,3,1000,,\r\n'
    + 'b,https://example.com/b,"引号""里""的",,,,disabled,0,2000,,\r\n';
  const rows = parseCsv(text);
  assert.equal(rows.length, 3);
  assert.equal(rows[1][2], '标题,带逗号');
  assert.equal(rows[1][5], '备注\r\n第二行');
  assert.equal(rows[2][2], '引号"里"的');
});

test('parseCsvExport 读回导出格式，分组按名字带上', () => {
  const text = 'code,url,title,group,tags,note,status,clicks,created_at,last_click_at,expire_at\n'
    + 'x,https://example.com/x,标题,G,标签,备注,active,7,1700000000000,,\n'
    + 'y,https://example.com/y,,,,,active,0,,,\n';
  const parsed = parseCsvExport(text);
  assert.equal(parsed.links.length, 2);
  assert.equal(parsed.links[0].code, 'x');
  assert.equal(parsed.links[0].clicks, 7);
  assert.equal(parsed.links[0].groupName, 'G');
  assert.equal(parsed.links[0].createdAt, 1700000000000);
  assert.equal(parsed.links[1].groupName, '');
});

test('detectFormat 认得出 CSV', () => {
  assert.equal(detectFormat('code,url,title\n', 'x.csv'), 'csv');
  assert.equal(detectFormat('\uFEFFcode,url,title\n', ''), 'csv');
  assert.equal(detectFormat('{"links":[]}', ''), 'highurl');
});

test('CSV 导入会按名字建出缺失的分组', () => {
  const { store } = makeStore();
  const parsed = parseCsvExport('code,url,title,group,tags,note,status,clicks,created_at,last_click_at,expire_at\n'
    + 'c1,https://example.com/1,标题一,新分组,,,,5,,,\n');
  const plan = planImport(store, parsed);
  const stats = applyImport(store, plan);
  assert.equal(stats.created, 1);
  assert.equal(stats.groups, 1);
  const row = store.findLinkByCode('c1');
  assert.equal(store.sql.getGroupById.get(row.group_id).name, '新分组');
  store.close();
});

test('CSV 导入复用已有分组，不重复建', () => {
  const { store } = makeStore();
  store.db.prepare("INSERT INTO groups (name, color, note, created_at, updated_at) VALUES ('已有', '', '', 1, 1)").run();
  const parsed = parseCsvExport('code,url,title,group,tags,note,status,clicks,created_at,last_click_at,expire_at\n'
    + 'c2,https://example.com/2,标题二,已有,,,,0,,,\n');
  const stats = applyImport(store, planImport(store, parsed));
  assert.equal(stats.groups, 0);
  assert.equal(store.findLinkByCode('c2').group_id, store.db.prepare("SELECT id FROM groups WHERE name='已有'").get().id);
  store.close();
});
