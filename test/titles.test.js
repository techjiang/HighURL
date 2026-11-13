import test from 'node:test';
import assert from 'node:assert/strict';

import { isPrivateIp, extractTitle, assertPublicHost } from '../src/services/titles.js';

test('isPrivateIp 识别内网与保留段', () => {
  for (const ip of ['10.0.0.1', '10.255.255.255', '192.168.1.1', '172.16.0.1', '172.31.255.255', '127.0.0.1', '0.0.0.0', '169.254.1.1', '100.64.0.1', '224.0.0.1', '255.255.255.255']) {
    assert.equal(isPrivateIp(ip), true, `${ip} 应判定为内网`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.113.9', '172.32.0.1', '172.15.255.255']) {
    assert.equal(isPrivateIp(ip), false, `${ip} 应判定为公网`);
  }
});

test('isPrivateIp 识别 IPv6 内网地址', () => {
  assert.equal(isPrivateIp('::1'), true);
  assert.equal(isPrivateIp('::'), true);
  assert.equal(isPrivateIp('fd00::1'), true);
  assert.equal(isPrivateIp('fc00::abcd'), true);
  assert.equal(isPrivateIp('fe80::1'), true);
  assert.equal(isPrivateIp('::ffff:192.168.0.1'), true);
  assert.equal(isPrivateIp('2001:4860:4860::8888'), false);
});

test('assertPublicHost 拒绝内网与本地域名', async () => {
  await assert.rejects(() => assertPublicHost('127.0.0.1'), /禁止访问内网/);
  await assert.rejects(() => assertPublicHost('localhost'), /禁止访问内网/);
  await assert.rejects(() => assertPublicHost('foo.localhost'), /禁止访问内网/);
  await assert.rejects(() => assertPublicHost('db.internal'), /禁止访问内网/);
  await assert.rejects(() => assertPublicHost('printer.local'), /禁止访问内网/);
  await assert.rejects(() => assertPublicHost('192.168.1.10'), /禁止访问内网/);
  await assert.doesNotReject(() => assertPublicHost('8.8.8.8'));
});

test('extractTitle 优先 og:title', () => {
  const html = `<html><head>
    <meta property="og:title" content="OG 标题">
    <title>HTML 标题</title>
  </head></html>`;
  assert.equal(extractTitle(html), 'OG 标题');
});

test('extractTitle 兼容 twitter:title 与属性顺序', () => {
  assert.equal(extractTitle('<meta content="Twitter 标题" name="twitter:title">'), 'Twitter 标题');
  assert.equal(extractTitle(`<meta content='单引号标题' property='og:title' />`), '单引号标题');
});

test('extractTitle 回退到 title 与 h1', () => {
  assert.equal(extractTitle('<title>页面标题</title>'), '页面标题');
  assert.equal(extractTitle('<h1>大标题</h1>'), '大标题');
  assert.equal(extractTitle(''), '');
  assert.equal(extractTitle('<html></html>'), '');
});

test('extractTitle 解码 HTML 实体并清掉内层标签', () => {
  assert.equal(extractTitle('<title>A &amp; B &lt;test&gt;</title>'), 'A & B <test>');
  assert.equal(extractTitle('<title><span>嵌</span>套</title>'), '嵌套');
  assert.equal(extractTitle('<title>&#20320;&#22909;</title>'), '你好');
});

test('extractTitle 折叠空白并截断超长标题', () => {
  assert.equal(extractTitle('<title>  多   个\n\n空格  </title>'), '多 个 空格');
  const long = extractTitle(`<title>${'x'.repeat(500)}</title>`);
  assert.ok(long.length <= 201);
  assert.ok(long.endsWith('…'));
});
