#!/usr/bin/env node
/**
 * 由 assets/*.svg 生成全套位图图标（favicon / PWA / 社交分享图）。
 * 需要在开发环境安装 @resvg/resvg-js（devDependency），产物已入库，运行时不需要。
 *
 *   npm run icons
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imgDir = path.join(root, 'public', 'img');

let Resvg;
try {
  ({ Resvg } = await import('@resvg/resvg-js'));
} catch {
  console.error('缺少 @resvg/resvg-js，请先 npm install --save-dev @resvg/resvg-js');
  process.exit(1);
}

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const write = (name, buffer) => {
  const file = path.join(imgDir, name);
  fs.writeFileSync(file, buffer);
  console.log(`✓ ${name} (${buffer.length} B)`);
};

function render(svg, width) {
  return new Resvg(svg, { fitTo: { mode: 'width', value: width }, background: 'rgba(0,0,0,0)' }).render().asPng();
}

const mark = read('assets/logo.svg');
const badge = read('assets/logo-badge.svg');

const pngs = {
  'favicon-16.png': render(mark, 16),
  'favicon-32.png': render(mark, 32),
  'favicon-48.png': render(mark, 48),
  'apple-touch-icon.png': render(badge, 180),
  'icon-192.png': render(badge, 192),
  'icon-512.png': render(badge, 512),
  'icon-maskable-512.png': render(read('assets/logo-maskable.svg'), 512),
  'logo-256.png': render(mark, 256),
  'logo-512.png': render(mark, 512),
};
for (const [name, buf] of Object.entries(pngs)) write(name, buf);

// ICO：容器 + 16/32/48 三档 PNG（Windows / 旧浏览器都能用）
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dirs = [];
  let offset = 6 + entries.length * 16;
  for (const { size, data } of entries) {
    const dir = Buffer.alloc(16);
    dir.writeUInt8(size >= 256 ? 0 : size, 0);
    dir.writeUInt8(size >= 256 ? 0 : size, 1);
    dir.writeUInt8(0, 2);
    dir.writeUInt8(0, 3);
    dir.writeUInt16LE(1, 4);
    dir.writeUInt16LE(32, 6);
    dir.writeUInt32LE(data.length, 8);
    dir.writeUInt32LE(offset, 12);
    offset += data.length;
    dirs.push(dir);
  }
  return Buffer.concat([header, ...dirs, ...entries.map((e) => e.data)]);
}
write(
  'favicon.ico',
  buildIco([
    { size: 16, data: pngs['favicon-16.png'] },
    { size: 32, data: pngs['favicon-32.png'] },
    { size: 48, data: pngs['favicon-48.png'] },
  ]),
);

// 社交分享图 1200x630
const fontDirs = ['/usr/share/fonts/truetype/dejavu', '/usr/share/fonts/truetype/wqy'];
const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0B0A1F"/><stop offset=".55" stop-color="#120E2E"/><stop offset="1" stop-color="#06121F"/>
    </linearGradient>
    <!-- 竖线 bbox 宽度为 0，渐变必须用 userSpaceOnUse，否则整笔不渲染 -->
    <linearGradient id="fg" x1="14" y1="30" x2="66" y2="80" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#A78BFA"/><stop offset=".55" stop-color="#5B8BFF"/><stop offset="1" stop-color="#5B8BFF"/>
    </linearGradient>
    <linearGradient id="fgc" x1="43" y1="21" x2="79" y2="52" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#22D3EE"/><stop offset="1" stop-color="#5B8BFF"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#7C5CFF" stop-opacity=".5"/><stop offset="1" stop-color="#7C5CFF" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <circle cx="1060" cy="80" r="340" fill="url(#glow)"/>
  <circle cx="110" cy="610" r="250" fill="url(#glow)" opacity=".4"/>
  <g transform="translate(96 168) scale(2.2)">
    <g fill="none" stroke-width="10.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M17 37V75" stroke="url(#fg)"/>
      <path d="M17 57H61" stroke="url(#fg)"/>
      <path d="M61 75V41" stroke="url(#fg)"/>
      <path d="M43 39 61 21 79 39" stroke="url(#fgc)"/>
    </g>
  </g>
  <text x="472" y="272" font-family="DejaVu Sans" font-size="102" font-weight="bold" fill="#F5F7FF">HighURL</text>
  <text x="476" y="342" font-family="WenQuanYi Zen Hei, DejaVu Sans" font-size="34" fill="#B9C4E6">自托管短链接系统 · 快、稳、零依赖</text>
  <g font-family="WenQuanYi Zen Hei, DejaVu Sans" font-size="25" fill="#93A3CE">
    <text x="476" y="430">延迟计数</text>
    <text x="616" y="430">UA 屏蔽</text>
    <text x="744" y="430">标题抓取</text>
    <text x="872" y="430">YOURLS 迁移</text>
  </g>
  <line x1="476" y1="396" x2="1104" y2="396" stroke="#2A3358" stroke-width="2"/>
</svg>`;
write(
  'og.png',
  new Resvg(og, {
    fitTo: { mode: 'width', value: 1200 },
    font: { fontDirs, loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' },
  }).render().asPng(),
);
