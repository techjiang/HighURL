import test from 'node:test';
import assert from 'node:assert/strict';

import { qrSvg, qrPng, resolveStyle, QR_PRESETS, mixHex, DOT_STYLES } from '../src/services/qr.js';
import { createCanvas, fillRect, fillCircle, encodeRgbaPng, parseColor } from '../src/lib/png.js';
import { startTestServer } from './helpers.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngHeader(buf) {
  // 直接读 IHDR：宽高、位深、颜色类型
  return {
    signature: buf.subarray(0, 8).equals(PNG_SIGNATURE),
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    depth: buf[24],
    colorType: buf[25],
  };
}

test('parseColor 认 #rgb / #rrggbb / #rrggbbaa / transparent', () => {
  assert.deepEqual(parseColor('#abc'), [170, 187, 204, 255]);
  assert.deepEqual(parseColor('#112233'), [17, 34, 51, 255]);
  assert.deepEqual(parseColor('#11223344'), [17, 34, 51, 68]);
  assert.deepEqual(parseColor('transparent'), [0, 0, 0, 0]);
  assert.deepEqual(parseColor('不是颜色', [1, 2, 3, 4]), [1, 2, 3, 4]);
});

test('RGBA PNG 是真彩 + alpha（颜色类型 6），灰度路径仍是颜色类型 0', () => {
  const canvas = createCanvas(8, 8, [255, 255, 255, 255]);
  fillRect(canvas, 0, 0, 4, 4, [139, 92, 246, 255]);
  const rgba = encodeRgbaPng(canvas);
  const h = pngHeader(rgba);
  assert.equal(h.signature, true);
  assert.equal(h.colorType, 6);
  assert.equal(h.width, 8);

  const plain = qrPng('https://s.example.com/abc', { scale: 4 });
  assert.equal(pngHeader(plain.png).colorType, 0, '纯黑白仍走灰度，文件更小');
});

test('彩色 / 圆点 / 透明底的二维码走 RGBA 路径', () => {
  const colored = qrPng('https://s.example.com/abc', { scale: 4, dark: '#8b5cf6' });
  assert.equal(pngHeader(colored.png).colorType, 6);
  const dots = qrPng('https://s.example.com/abc', { scale: 4, dotStyle: 'dots' });
  assert.equal(pngHeader(dots.png).colorType, 6);
  const transparent = qrPng('https://s.example.com/abc', { scale: 4, light: 'transparent' });
  assert.equal(pngHeader(transparent.png).colorType, 6);
});

test('尺寸仍按（模块 + 留白）× scale 算，不被样式改动打乱', () => {
  const a = qrPng('https://s.example.com/abc', { scale: 4, margin: 2 });
  const b = qrPng('https://s.example.com/abc', { scale: 4, margin: 2, dotStyle: 'dots', dark: '#123456' });
  assert.equal(a.size, b.size);
  assert.equal(pngHeader(b.png).width, b.size);
});

test('圆点样式真的画了圆：中间行与四角像素不同', () => {
  const canvas = createCanvas(40, 40, [255, 255, 255, 255]);
  fillCircle(canvas, 20, 20, 10, [0, 0, 0, 255]);
  const at = (x, y) => canvas.pixels[(y * 40 + x) * 4];
  assert.equal(at(20, 20), 0, '圆心是黑的');
  assert.equal(at(0, 0), 255, '四角没被涂到');
  assert.equal(at(20, 8), 255, '圆外的顶部还是白');
});

test('SVG 渐变用 userSpaceOnUse，避免包围盒宽度为 0 时整笔不渲染', () => {
  const svg = qrSvg('https://s.example.com/abc', { gradient: ['#8b5cf6', '#22d3ee'] });
  assert.match(svg, /gradientUnits="userSpaceOnUse"/);
  assert.match(svg, /url\(#qr-grad\)/);
  assert.match(svg, /#8b5cf6/);
});

test('SVG 圆点与圆角块逐模块绘制，方块仍是单条 path', () => {
  const square = qrSvg('https://s.example.com/abc');
  assert.match(square, /<path fill=/);
  assert.match(square, /shape-rendering="crispEdges"/);

  const dots = qrSvg('https://s.example.com/abc', { dotStyle: 'dots' });
  assert.match(dots, /<circle /);
  assert.match(dots, /shape-rendering="geometricPrecision"/);

  const rounded = qrSvg('https://s.example.com/abc', { dotStyle: 'rounded' });
  assert.match(rounded, /<rect /);
  assert.match(rounded, /rx=/);
});

test('透明底不带背景矩形，指定背景才画', () => {
  const transparent = qrSvg('https://s.example.com/abc', { light: 'transparent' });
  assert.equal(/<rect width="\d+" height="\d+" fill/.test(transparent), false);
  const solid = qrSvg('https://s.example.com/abc', { light: '#ffffff' });
  assert.match(solid, /<rect width="\d+" height="\d+" fill="#ffffff"\/>/);
});

test('纠错等级影响模块数：H 比 L 更密', () => {
  const svgL = qrSvg('https://s.example.com/some/long/path', { ecc: 'L' });
  const svgH = qrSvg('https://s.example.com/some/long/path', { ecc: 'H' });
  const viewBox = (svg) => Number(/viewBox="0 0 (\d+)/.exec(svg)[1]);
  assert.ok(viewBox(svgH) > viewBox(svgL), 'H 需要更多模块');
});

test('resolveStyle 只接受合法值，非法一律回落', () => {
  assert.deepEqual(resolveStyle({ dotStyle: 'dots' }).dotStyle, 'dots');
  assert.equal(resolveStyle({ dotStyle: '三角形' }).dotStyle, undefined);
  assert.equal(resolveStyle({ ecc: 'H' }).ecc, 'H');
  assert.equal(resolveStyle({ ecc: 'Z' }).ecc, undefined);
  assert.equal(resolveStyle({ dark: 'ff0000' }).dark, '#ff0000');
  assert.equal(resolveStyle({ dark: 'red' }).dark, undefined);
  assert.deepEqual(resolveStyle({ gradient: '#111111,#222222' }).gradient, ['#111111', '#222222']);
  assert.equal(resolveStyle({ gradient: '#111111' }).gradient, undefined);
  assert.equal(resolveStyle({ light: 'transparent' }).light, 'transparent');
});

test('预设都能被 resolveStyle 展开成可用参数，且每个预设都跑得出图', () => {
  for (const key of Object.keys(QR_PRESETS)) {
    const style = resolveStyle({ preset: key });
    const svg = qrSvg('https://s.example.com/preset', style);
    assert.match(svg, /<svg /, `${key} 应该能出 SVG`);
    const png = qrPng('https://s.example.com/preset', { scale: 3, ...style });
    assert.equal(pngHeader(png.png).signature, true, `${key} 应该能出 PNG`);
    if (style.dotStyle) assert.ok(DOT_STYLES.includes(style.dotStyle));
  }
});

test('mixHex 两端与中点在色值上连续', () => {
  assert.equal(mixHex('#000000', '#ffffff', 0), '#000000');
  assert.equal(mixHex('#000000', '#ffffff', 1), '#ffffff');
  assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080');
});

test('QR 接口接受样式参数，非法参数不会 500', async () => {
  const srv = await startTestServer({ titleFetch: false });
  try {
    await srv.ctx.auth.createAdmin('admin', 'Passw0rd!23');
    const res = await srv.fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: 'Passw0rd!23' }).toString(),
    });
    const cookie = String(res.headers.get('set-cookie') || '').split(';')[0];
    const text = encodeURIComponent('https://s.example.com/abc');

    const ok = await srv.fetch(`/admin/api/qr.svg?text=${text}&preset=brand&dot=dots&ecc=H`, { headers: { Cookie: cookie } });
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /<svg /);

    const bad = await srv.fetch(`/admin/api/qr.svg?text=${text}&dot=三角形&dark=notacolor&gradient=x&ecc=Z`, { headers: { Cookie: cookie } });
    assert.equal(bad.status, 200, '样式参数非法应该回落默认值，而不是报错');

    const png = await srv.fetch(`/admin/api/qr.png?text=${text}&preset=soft&scale=6`, { headers: { Cookie: cookie } });
    assert.equal(png.status, 200);
    const buf = Buffer.from(await png.arrayBuffer());
    assert.equal(pngHeader(buf).colorType, 6);

    const presets = await srv.fetch('/admin/api/qr/presets', { headers: { Cookie: cookie } });
    assert.equal(presets.status, 200);
    const body = await presets.json();
    assert.ok(body.result.brand);
  } finally {
    await srv.stop();
  }
});
