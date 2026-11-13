import test from 'node:test';
import assert from 'node:assert/strict';

import {
  randomCode, scrypt, scryptVerify, hmac, sha256, safeEqual,
  dateKey, todayKey, platformOf, isBotUA, hostOf, truncate,
  parseCookies, clientIp, normalizeIp, clampInt, formatBytes,
} from '../src/lib/util.js';

test('randomCode 长度与字符集正确', () => {
  for (let i = 0; i < 50; i += 1) {
    const code = randomCode(8);
    assert.equal(code.length, 8);
    assert.match(code, /^[23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ]+$/);
  }
  assert.notEqual(randomCode(16), randomCode(16));
});

test('scrypt 哈希可验证且每次盐不同', () => {
  const a = scrypt('correct horse');
  const b = scrypt('correct horse');
  assert.notEqual(a, b);
  assert.ok(a.startsWith('scrypt$'));
  assert.equal(scryptVerify('correct horse', a), true);
  assert.equal(scryptVerify('wrong horse', a), false);
  assert.equal(scryptVerify('x', 'plain-text'), false);
  assert.equal(scryptVerify('x', null), false);
});

test('hmac / sha256 稳定且 safeEqual 抗长度差异', () => {
  assert.equal(hmac('k', 'abc'), hmac('k', 'abc'));
  assert.notEqual(hmac('k1', 'abc'), hmac('k2', 'abc'));
  assert.equal(sha256('abc').length, 64);
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('abc', 'abd'), false);
});

test('日期 key 格式为 YYYY-MM-DD', () => {
  assert.match(todayKey(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(dateKey(new Date(2025, 0, 5)), '2025-01-05');
});

test('platformOf 识别常见 UA', () => {
  assert.equal(platformOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)'), 'ios');
  assert.equal(platformOf('Mozilla/5.0 (Linux; Android 14)'), 'android');
  assert.equal(platformOf('Mozilla/5.0 (Windows NT 10.0)'), 'windows');
  assert.equal(platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)'), 'mac');
  assert.equal(platformOf('Mozilla/5.0 (X11; Linux x86_64)'), 'linux');
  assert.equal(platformOf('Googlebot/2.1'), 'bot');
  assert.equal(platformOf(''), 'unknown');
  assert.equal(platformOf('something-custom'), 'other');
});

test('isBotUA 命中常见爬虫', () => {
  assert.ok(isBotUA('Mozilla/5.0 (compatible; Googlebot/2.1)'));
  assert.ok(isBotUA('curl/8.4.0'));
  assert.ok(isBotUA('python-requests/2.31'));
  assert.equal(isBotUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Chrome/120'), false);
});

test('hostOf 去掉 www 前缀并容错', () => {
  assert.equal(hostOf('https://www.example.com/a/b?c=1'), 'example.com');
  assert.equal(hostOf('https://sub.example.com/'), 'sub.example.com');
  assert.equal(hostOf('not a url'), '');
});

test('truncate 超长补省略号', () => {
  assert.equal(truncate('abcdef', 3), 'abc…');
  assert.equal(truncate('abc', 10), 'abc');
});

test('parseCookies 解析多 Cookie', () => {
  const got = parseCookies('a=1; b=hello%20world; c=; d=x=y');
  assert.deepEqual(got, { a: '1', b: 'hello world', c: '', d: 'x=y' });
});

test('clientIp 尊重 trustProxy 开关', () => {
  const req = { headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }, socket: { remoteAddress: '::ffff:127.0.0.1' } };
  assert.equal(clientIp(req, false), '127.0.0.1');
  assert.equal(clientIp(req, true), '1.2.3.4');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '::ffff:5.6.7.8' } }, true), '5.6.7.8');
});

test('normalizeIp 剥离 IPv6 映射前缀', () => {
  assert.equal(normalizeIp('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(normalizeIp('1.2.3.4'), '1.2.3.4');
});

test('clampInt 边界与回退', () => {
  assert.equal(clampInt('5', 1, 10, 3), 5);
  assert.equal(clampInt('50', 1, 10, 3), 10);
  assert.equal(clampInt('x', 1, 10, 3), 3);
});

test('formatBytes 可读化', () => {
  assert.equal(formatBytes(0), '0B');
  assert.equal(formatBytes(1024), '1.0KB');
  assert.equal(formatBytes(1536), '1.5KB');
});
