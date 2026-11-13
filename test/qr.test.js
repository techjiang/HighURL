import test from 'node:test';
import assert from 'node:assert/strict';

import { qrSvg } from '../src/services/qr.js';

test('生成合法 SVG 且包含路径数据', () => {
  const svg = qrSvg('https://s.example.com/abc');
  assert.match(svg, /^<svg/);
  assert.match(svg, /<\/svg>$/);
  assert.match(svg, /<path/);
});

test('自定义颜色生效', () => {
  const svg = qrSvg('https://example.com', { dark: '#123456', light: '#ffffff' });
  assert.match(svg, /#123456/);
  assert.match(svg, /#ffffff/);
});

test('指定尺寸时写入 width/height', () => {
  const svg = qrSvg('https://example.com', { size: 320 });
  assert.match(svg, /width="320"/);
  assert.match(svg, /height="320"/);
});

test('内容不同则图形不同', () => {
  assert.notEqual(qrSvg('https://a.com'), qrSvg('https://b.com'));
});

test('长文本仍能编码', () => {
  const svg = qrSvg(`https://example.com/${'x'.repeat(200)}`);
  assert.match(svg, /<path/);
});

test('中文内容可编码', () => {
  assert.match(qrSvg('https://例子.测试/路径'), /<path/);
});
