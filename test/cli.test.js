import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { tmpDir } from './helpers.js';

const run = promisify(execFile);
const CLI = new URL('../src/cli.js', import.meta.url).pathname;

function cli(args, { dir } = {}) {
  return run(process.execPath, [CLI, ...args, ...(dir ? ['--data', dir] : [])], { env: { ...process.env, HIGHURL_LOG_LEVEL: 'error' } });
}

test('无参数时打印帮助', async () => {
  const { stdout } = await run(process.execPath, [CLI]);
  assert.match(stdout, /用法:/);
  assert.match(stdout, /highurl serve/);
});

test('未知命令退出码为 1', async () => {
  await assert.rejects(() => cli(['nonsense']), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /未知命令/);
    return true;
  });
});

test('init 创建管理员，重复执行提示已存在', async () => {
  const dir = tmpDir();
  const { stdout } = await cli(['init', '--username', 'admin', '--password', 'password123'], { dir });
  assert.match(stdout, /已创建管理员 admin/);

  await assert.rejects(() => cli(['init', '--username', 'admin', '--password', 'password123'], { dir }), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /已存在管理员账号/);
    return true;
  });
});

test('init 缺少密码时报错', async () => {
  const dir = tmpDir();
  await assert.rejects(() => cli(['init'], { dir }), (err) => {
    assert.match(err.stderr, /请通过 --password/);
    return true;
  });
});

test('init 拒绝弱密码', async () => {
  const dir = tmpDir();
  await assert.rejects(() => cli(['init', '--username', 'admin', '--password', '123'], { dir }), (err) => {
    assert.match(err.stderr, /至少 8 位/);
    return true;
  });
});

test('doctor 自检通过', async () => {
  const dir = tmpDir();
  const { stdout } = await cli(['doctor'], { dir });
  assert.match(stdout, /node:sqlite 可用/);
  assert.match(stdout, /数据目录可写/);
});

test('stats 输出条数', async () => {
  const dir = tmpDir();
  const { stdout } = await cli(['stats'], { dir });
  assert.match(stdout, /短链 0 条/);
});

test('backup 写出 JSON，restore 读回', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'out.json');
  const backup = await cli(['backup', file], { dir });
  assert.match(backup.stdout, /备份已写入/);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Array.isArray(data.links));
  assert.equal(data.manifest.algorithm, 'sha256');
  assert.equal(typeof data.manifest.checksum, 'string');

  const restore = await cli(['restore', file], { dir });
  assert.match(restore.stdout, /已恢复 0 条短链/);
});

test('verify 通过完整备份，被改动后报不一致', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'out.json');
  await cli(['backup', file], { dir });

  const okOut = await cli(['verify', file], { dir });
  assert.match(okOut.stdout, /完整性校验通过/);

  // 手改一处内容：checksum 就再也对不上
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.links.push({ code: 'tampered', url: 'https://example.com' });
  fs.writeFileSync(file, JSON.stringify(data));

  await assert.rejects(() => cli(['verify', file], { dir }), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /内容与 manifest 不一致/);
    return true;
  });
});

test('restore 拒绝校验不通过的备份，--force 才放行', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'out.json');
  await cli(['backup', file], { dir });
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.links.push({ code: 'x1', url: 'https://example.com/1', status: 'active' });
  fs.writeFileSync(file, JSON.stringify(data));

  await assert.rejects(() => cli(['restore', file], { dir }), (err) => {
    assert.match(err.stderr, /完整性校验未通过/);
    assert.match(err.stderr, /--force/);
    return true;
  });

  const forced = await cli(['restore', file, '--force'], { dir });
  assert.match(forced.stdout, /已恢复 1 条短链/);
});

test('restore 接受没有校验和的老备份', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'legacy.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 4,
    exportedAt: '2026-01-01T00:00:00.000Z',
    links: [{ code: 'old', url: 'https://example.com/old', status: 'active' }],
  }));
  const dry = await cli(['restore', file, '--dry-run'], { dir });
  assert.match(dry.stdout, /完整性 legacy/);
  const out = await cli(['restore', file], { dir });
  assert.match(out.stdout, /已恢复 1 条短链/);
});

test('restore 拒绝非法文件', async () => {
  const dir = tmpDir();
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{"nope":1}');
  await assert.rejects(() => cli(['restore', bad], { dir }), (err) => {
    assert.match(err.stderr, /不是有效的 HighURL 备份文件/);
    return true;
  });
});

test('migrate --dry-run 不写库', async () => {
  const dir = tmpDir();
  const sql = path.join(dir, 'yourls.sql');
  fs.writeFileSync(sql, "INSERT INTO `yourls_url` VALUES ('https://example.com','abc','标题','2024-01-02 03:04:05','1.2.3.4',7);");
  const { stdout } = await cli(['migrate', sql, '--dry-run'], { dir });
  assert.match(stdout, /格式 yourls/);
  assert.match(stdout, /可导入 1/);

  const stats = await cli(['stats'], { dir });
  assert.match(stats.stdout, /短链 0 条/);
});

test('migrate 正式导入后 stats 可见', async () => {
  const dir = tmpDir();
  const sql = path.join(dir, 'yourls.sql');
  fs.writeFileSync(sql, "INSERT INTO `yourls_url` VALUES ('https://example.com','abc','标题','2024-01-02 03:04:05','1.2.3.4',7);");
  const { stdout } = await cli(['migrate', sql], { dir });
  assert.match(stdout, /导入完成：新增 1/);
  const stats = await cli(['stats'], { dir });
  assert.match(stats.stdout, /短链 1 条/);
  assert.match(stats.stdout, /累计点击 7 次/);
});

test('migrate 无法识别格式时报错', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'x.txt');
  fs.writeFileSync(file, 'hello world');
  await assert.rejects(() => cli(['migrate', file], { dir }), (err) => {
    assert.match(err.stderr, /无法识别文件格式/);
    return true;
  });
});
