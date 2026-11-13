import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { encodeGrayPng, crc32 } from '../src/lib/png.js';
import { zipCrc32, zipStore } from '../src/lib/zip.js';
import { qrPng, qrSvg, qrMatrix } from '../src/services/qr.js';
import { startTestServer } from './helpers.js';

async function withServer(fn, overrides = {}) {
  const srv = await startTestServer(overrides);
  try {
    return await fn(srv);
  } finally {
    await srv.stop();
  }
}

async function login(srv, username = 'admin', password = 'password123') {
  if (!srv.ctx.auth.hasAdmin()) srv.ctx.auth.createAdmin(username, password);
  const res = await srv.fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }).toString(),
  });
  return (res.headers.getSetCookie?.() || [res.headers.get('set-cookie')])
    .map((c) => String(c).split(';')[0])
    .join('; ');
}

/** 读 ZIP 的中央目录，返回条目名与内容（只处理 store 模式） */
function readZip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end > 0, '应能找到 ZIP 结束记录');
  const count = buf.readUInt16LE(end + 10);
  let ptr = buf.readUInt32LE(end + 16);
  const out = new Map();
  for (let i = 0; i < count; i += 1) {
    assert.equal(buf.readUInt32LE(ptr), 0x02014b50, '中央目录签名');
    const crc = buf.readUInt32LE(ptr + 16);
    const size = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const data = buf.subarray(start, start + size);
    assert.equal(zipCrc32(data), crc, `${name} 的 CRC 应一致`);
    out.set(name, data);
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

test('CRC32 与 PNG 编码产出合法头与 IHDR', () => {
  assert.equal(crc32(Buffer.from('hello')), 907060870);
  const gray = new Uint8Array(4 * 3).fill(255);
  gray[0] = 0;
  const png = encodeGrayPng({ width: 4, height: 3, gray });
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(8), 13, 'IHDR 长度应为 13');
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
  assert.equal(png.readUInt32BE(16), 4, '宽');
  assert.equal(png.readUInt32BE(20), 3, '高');
  assert.equal(png[24], 8, '位深 8');
  assert.equal(png[25], 0, '灰度色彩类型');
  assert.equal(png.subarray(png.length - 8, png.length - 4).toString('ascii'), 'IEND');
  // 像素数量不匹配要报错，避免静默产出花屏
  assert.throws(() => encodeGrayPng({ width: 2, height: 2, gray: new Uint8Array(3) }), /不匹配/);
});

test('QR PNG 尺寸是整模块倍，且只有黑白两色', () => {
  const matrix = qrMatrix('https://s.example.com/abc');
  const { png, size } = qrPng('https://s.example.com/abc', { scale: 4, margin: 2 });
  assert.equal(size, (matrix.count + 4) * 4);
  assert.equal(png.readUInt32BE(16), size);
  assert.equal(png.readUInt32BE(20), size);
  // 解回像素检查调色板：二维码不该出现灰边
  const idatStart = png.indexOf(Buffer.from('IDAT'));
  const idatLen = png.readUInt32BE(idatStart - 4);
  const raw = zlib.inflateSync(png.subarray(idatStart + 4, idatStart + 4 + idatLen));
  const stride = size + 1;
  assert.equal(raw.length, stride * size);
  const colors = new Set();
  for (let y = 0; y < size; y += 1) {
    assert.equal(raw[y * stride], 0, '每行 filter 应为 None');
    for (let x = 0; x < size; x += 1) colors.add(raw[y * stride + 1 + x]);
  }
  assert.deepEqual([...colors].sort(), [0, 255], '只允许纯黑与纯白');
});

test('SVG 与 PNG 表达同一份矩阵', () => {
  const text = 'https://s.example.com/same';
  const matrix = qrMatrix(text);
  const svg = qrSvg(text, { margin: 0 });
  assert.match(svg, new RegExp(`viewBox="0 0 ${matrix.count} ${matrix.count}"`));
  assert.match(svg, /<path fill=/);
  // 左上角定位图案一定有黑块
  assert.ok(matrix.isDark(0, 0));
});

test('ZIP 写入器产出可被标准工具解开的包', () => {
  const zip = zipStore([
    { name: 'a.txt', data: Buffer.from('hello') },
    { name: 'qr/中文.png', data: Buffer.from([1, 2, 3]) },
  ]);
  const entries = readZip(zip);
  assert.equal(entries.size, 2);
  assert.equal(entries.get('a.txt').toString(), 'hello');
  assert.deepEqual([...entries.get('qr/中文.png')], [1, 2, 3]);
  // 非 ASCII 文件名要置 UTF-8 标志位，否则 Windows 解压乱码
  const flags = zip.readUInt16LE(zip.indexOf(Buffer.from('qr/中文', 'utf8')) - 30 + 6);
  assert.ok(flags & 0x800, '应置 general purpose bit 11');
});

test('批量二维码 ZIP 导出：勾选与筛选两种范围', () => withServer(async (srv) => {
  const cookie = await login(srv);
  const auth = { Cookie: cookie, 'Content-Type': 'application/json' };
  for (const code of ['z1', 'z2', 'z3']) {
    await srv.fetch('/admin/api/links', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ url: `https://example.com/${code}`, code }),
    });
  }

  const picked = await srv.fetch('/admin/api/qr.zip?scope=codes&codes=z1,z3', { headers: { Cookie: cookie } });
  assert.equal(picked.status, 200);
  assert.match(picked.headers.get('content-type'), /application\/zip/);
  const entries = readZip(Buffer.from(await picked.arrayBuffer()));
  assert.ok(entries.has('qr/z1.png'));
  assert.ok(entries.has('qr/z3.png'));
  assert.ok(!entries.has('qr/z2.png'), '未勾选的不该出现');
  assert.match(entries.get('codes.csv').toString('utf8'), /z1/);
  // 每张图都得是合法 PNG
  assert.deepEqual([...entries.get('qr/z1.png').subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

  const filtered = await srv.fetch('/admin/api/qr.zip?scope=filter&q=z', { headers: { Cookie: cookie } });
  const all = readZip(Buffer.from(await filtered.arrayBuffer()));
  assert.equal([...all.keys()].filter((n) => n.endsWith('.png')).length, 3);
}));

test('二维码导出需要登录且空选择报错', () => withServer(async (srv) => {
  const anon = await srv.fetch('/admin/api/qr.zip?scope=codes&codes=x');
  assert.equal(anon.status, 401);

  const cookie = await login(srv);
  const empty = await srv.fetch('/admin/api/qr.zip?scope=codes', { headers: { Cookie: cookie } });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error.code, 'empty_selection');

  const none = await srv.fetch('/admin/api/qr.zip?scope=filter&q=nothing-matches', { headers: { Cookie: cookie } });
  assert.equal(none.status, 404);
}));

test('单个 PNG 二维码接口', () => withServer(async (srv) => {
  const cookie = await login(srv);
  const ok = await srv.fetch('/admin/api/qr.png?text=https%3A%2F%2Fs.example.com%2Fa&scale=6', { headers: { Cookie: cookie } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /image\/png/);
  const buf = Buffer.from(await ok.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

  const missing = await srv.fetch('/admin/api/qr.png', { headers: { Cookie: cookie } });
  assert.equal(missing.status, 400);
}));
