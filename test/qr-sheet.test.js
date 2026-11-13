import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { PdfDocument, MM, asciiFold, isPrintableAscii } from '../src/lib/pdf.js';
import { buildQrSheetPdf, captionOf, displayUrl, paperSize, sheetStyleFromQuery } from '../src/services/qr-sheet.js';
import { qrRuns, qrMatrix } from '../src/services/qr.js';
import { startTestServer } from './helpers.js';

async function withServer(fn) {
  const srv = await startTestServer();
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

/**
 * 解出 PDF 的结构：页数、xref 偏移是否真的指向对象头、内容流能否解压。
 * 全部按字节解析——压缩流里随时可能出现 "endstream" 这种字面量，
 * 转成字符串再切会被坑。
 */
function inspectPdf(buf) {
  const text = buf.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.'), 'PDF 头');
  assert.ok(text.trimEnd().endsWith('%%EOF'), 'PDF 结尾');

  const startxref = /startxref\s+(\d+)\s+%%EOF/.exec(text);
  assert.ok(startxref, '应有 startxref');
  const xrefAt = Number(startxref[1]);
  assert.equal(buf.subarray(xrefAt, xrefAt + 4).toString('latin1'), 'xref', 'startxref 应指向 xref 表');

  const head = /xref\s+0 (\d+)\s/.exec(buf.subarray(xrefAt).toString('latin1'));
  const count = Number(head[1]);
  let ptr = xrefAt + head[0].length;
  const entries = [];
  // 第 0 项是空闲头，跳过
  ptr += 20;
  for (let i = 1; i < count; i += 1) {
    const line = buf.subarray(ptr, ptr + 20).toString('latin1');
    const m = /^(\d{10}) (\d{5}) ([nf])/.exec(line);
    assert.ok(m, `第 ${i} 条 xref 记录格式应正确：${JSON.stringify(line)}`);
    entries.push({ offset: Number(m[1]), type: m[3] });
    ptr += 20;
  }
  assert.equal(entries.length, count - 1, 'xref 应有 count-1 条对象记录');

  const streams = [];
  for (const [i, entry] of entries.entries()) {
    assert.match(
      buf.subarray(entry.offset, entry.offset + 32).toString('latin1'),
      new RegExp(`^${i + 1} 0 obj`),
      `对象 ${i + 1} 的偏移应指向自己的对象头`,
    );
    // 只在「本对象」的范围里找流：直接对到文件末尾搜索会串到后面对象的流上
    const objEnd = buf.indexOf('endobj', entry.offset);
    const slice = buf.subarray(entry.offset, objEnd);
    // 也别用 indexOf('stream\n')，它会先匹配到 endstream\n 里的那一段
    const at = slice.indexOf('>>\nstream\n');
    if (at < 0) continue;
    const streamAt = at + '>>\n'.length;
    const lenMatch = /\/Length (\d+)/.exec(slice.subarray(0, streamAt).toString('latin1'));
    assert.ok(lenMatch, '流对象应有 /Length');
    const start = entry.offset + streamAt + 'stream\n'.length;
    streams.push(buf.subarray(start, start + Number(lenMatch[1])));
  }
  const ops = streams.map((s) => {
    try {
      return zlib.inflateSync(s).toString('latin1');
    } catch {
      return null;
    }
  });
  assert.ok(ops.length > 0, '应至少有内容流');
  assert.ok(ops.every((o) => o !== null), '内容流应能被 zlib 解开');

  return { pages: Number(/\/Type \/Pages \/Count (\d+)/.exec(text)[1]), ops, text };
}

test('qrRuns 合并结果与矩阵一致', () => {
  const text = 'https://s.example.com/abc';
  const matrix = qrMatrix(text);
  const { count, runs } = qrRuns(text);
  assert.equal(count, matrix.count);
  const rebuilt = new Set();
  for (const run of runs) {
    for (let i = 0; i < run.length; i += 1) rebuilt.add(`${run.row}:${run.start + i}`);
  }
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      assert.equal(rebuilt.has(`${row}:${col}`), matrix.isDark(row, col), `${row},${col}`);
    }
  }
});

test('PDF 文档结构合法：多页、xref 偏移正确、内容流可解压', () => {
  const doc = new PdfDocument({ width: 210 * MM, height: 297 * MM, title: '测试' });
  doc.addPage().rect(10, 10, 100, 40, { gray: 0 });
  doc.addPage().text('hello', 20, 30, { size: 10 });
  const pdf = doc.build();
  const { pages, ops } = inspectPdf(pdf);
  assert.equal(pages, 2);
  assert.equal(ops.length, 2);
  assert.match(ops[0], /re f/, '第一页应有填充矩形');
  assert.match(ops[1], /\(hello\) Tj/, '第二页应有文字');
});

test('PdfDocument 文字居中与右对齐按 Courier 固定字宽算', () => {
  const doc = new PdfDocument();
  doc.addPage();
  doc.text('abcd', 100, 100, { size: 10, align: 'center' });
  doc.text('abcd', 100, 80, { size: 10, align: 'right' });
  doc.text('very-long-text-that-should-be-shortened', 100, 60, { size: 10, maxChars: 10 });
  const { ops } = inspectPdf(doc.build());
  // 4 字符 × 10pt × 0.6 = 24pt 宽
  assert.match(ops[0], /1 0 0 1 88 100 Tm/, '居中起点应为 100 - 12');
  assert.match(ops[0], /1 0 0 1 76 80 Tm/, '右对齐起点应为 100 - 24');
  assert.match(ops[0], /\(very-lo\.\.\) Tj/, '超长文字按 maxChars 截断');
});

test('asciiFold 与非 ASCII 判定', () => {
  assert.equal(asciiFold('Ａ中文标题'), '');
  assert.equal(isPrintableAscii('中文'), false);
  assert.equal(isPrintableAscii('Docs · v1'), false);
  assert.equal(isPrintableAscii('Docs - v1'), true);
  assert.equal(asciiFold('“引号”—破折号'), "'引号'-破折号".replace(/[^\x20-\x7e]/g, ''));
});

test('短链接去掉协议，中文标题退回域名', () => {
  assert.equal(displayUrl({ code: 'abc', shortUrl: 'https://s.example.com/abc' }), 's.example.com/abc');
  assert.equal(displayUrl({ code: 'abc' }), '/abc');
  assert.equal(captionOf({ title: 'Getting Started', url: 'https://docs.example.com/x' }), 'Getting Started');
  assert.equal(captionOf({ title: '开始使用', url: 'https://docs.example.com/x' }), 'docs.example.com');
  assert.equal(captionOf({ title: '开始使用' }), '');
});

test('拼版按条目数分页，页面尺寸随纸张变化', () => {
  const rows = Array.from({ length: 13 }, (_, i) => ({
    code: `c${i}`,
    shortUrl: `https://s.example.com/c${i}`,
    title: `Page ${i}`,
    url: `https://example.com/${i}`,
  }));
  const a4 = inspectPdf(buildQrSheetPdf(rows, { paper: 'a4', cols: 3 }));
  assert.ok(a4.pages >= 1 && a4.pages <= 3, `A4 3 列 13 条应分 1-3 页，实际 ${a4.pages}`);
  assert.match(a4.text, /\/MediaBox \[0 0 595\.276 841\.89\]/, 'A4 尺寸');

  const letter = inspectPdf(buildQrSheetPdf(rows, { paper: 'letter' }));
  assert.match(letter.text, /\/MediaBox \[0 0 612 792\]/, 'Letter 尺寸');

  // 条目全塞一页时不该多出空白页
  const one = inspectPdf(buildQrSheetPdf(rows.slice(0, 2), { cols: 2 }));
  assert.equal(one.pages, 1);
});

test('拼版参数：关闭标题与裁切线后不再出现对应绘制', () => {
  const rows = [{ code: 'a', shortUrl: 'https://s.example.com/a', title: 'Alpha', url: 'https://example.com/a' }];
  const withAll = inspectPdf(buildQrSheetPdf(rows, { cols: 2, showTitle: true, showCutLines: true }));
  const bare = inspectPdf(buildQrSheetPdf(rows, { cols: 2, showTitle: false, showCutLines: false }));
  assert.match(withAll.ops[0], /\(Alpha\) Tj/, '应打印标题');
  assert.doesNotMatch(bare.ops[0], /\(Alpha\) Tj/, '关闭后不应打印标题');
  // 裁切线是描边矩形，二维码本身只填充不描边
  assert.match(withAll.ops[0], /re S/, '应有裁切线');
  assert.doesNotMatch(bare.ops[0], /re S/, '关闭后不应有裁切线');
});

test('列数：auto 按条目数推导，显式值夹在 2-6 之间', () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ code: `c${i}`, shortUrl: `https://s.example.com/c${i}` }));
  // 自动：4 条以内 2 列，5-12 条 3 列，13-24 条 4 列
  assert.equal(columnsOf(buildQrSheetPdf(rows(3))), 2);
  assert.equal(columnsOf(buildQrSheetPdf(rows(10))), 3);
  assert.equal(columnsOf(buildQrSheetPdf(rows(20))), 4);
  // 显式 0 与不传等价，不能退化成 2 列
  assert.equal(columnsOf(buildQrSheetPdf(rows(10), { cols: 0 })), 3);
  assert.equal(columnsOf(buildQrSheetPdf(rows(10), { cols: 5 })), 5);
  assert.equal(columnsOf(buildQrSheetPdf(rows(10), { cols: 99 })), 6, '上限 6 列');
  assert.equal(columnsOf(buildQrSheetPdf(rows(10), { cols: 1 })), 3, '小于 2 视为自动');
});

/** 从内容流里数同一行上第一个格子的描边矩形宽度，反推列数 */
function columnsOf(pdf) {
  const { ops } = inspectPdf(pdf);
  const widths = [...ops[0].matchAll(/([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re S/g)].map((m) => Number(m[3]));
  const widest = Math.max(...widths);
  // 页面可用宽度固定，第一行格子数 = 总宽 / (格子宽 + 间距)
  const paper = 595.276 - 2 * 12 * 2.834645669;
  const gap = 5 * 2.834645669;
  return Math.round((paper + gap) / (widest + gap));
}

test('空列表直接报错，不产出坏 PDF', () => {
  assert.throws(() => buildQrSheetPdf([]), /没有可排版/);
  assert.throws(() => buildQrSheetPdf([{ code: '' }]), /没有可排版/);
});

test('paperSize 未知纸张回退 A4', () => {
  assert.equal(paperSize('a4').label, 'A4');
  assert.equal(paperSize('letter').label, 'Letter');
  assert.equal(paperSize('b5').label, 'A4');
});

test('GET /admin/api/qr.pdf 需要登录，能出 PDF 也能按筛选出', () => withServer(async (srv) => {
  const anon = await srv.fetch('/admin/api/qr.pdf?scope=filter');
  assert.equal(anon.status, 401, '未登录应 401');

  const cookie = await login(srv);
  for (const [code, url] of [['alpha', 'https://example.com/a'], ['beta', 'https://example.com/b']]) {
    const { res } = await srv.json('/admin/api/links', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: JSON.stringify({ url, code }),
    });
    assert.equal(res.status, 200);
  }

  const one = await srv.fetch('/admin/api/qr.pdf?scope=codes&codes=alpha', { headers: { Cookie: cookie } });
  assert.equal(one.status, 200);
  assert.equal(one.headers.get('content-type'), 'application/pdf');
  assert.match(one.headers.get('content-disposition') || '', /highurl-qr-\d{4}-\d{2}-\d{2}\.pdf/);
  const pdf = Buffer.from(await one.arrayBuffer());
  inspectPdf(pdf);
  assert.match(pdf.toString('latin1'), /\/MediaBox \[0 0 595\.276 841\.89\]/);

  const all = await srv.fetch('/admin/api/qr.pdf?scope=filter&cols=2&paper=letter', { headers: { Cookie: cookie } });
  assert.equal(all.status, 200);
  const letterPdf = Buffer.from(await all.arrayBuffer());
  assert.match(letterPdf.toString('latin1'), /\/MediaBox \[0 0 612 792\]/);

  const empty = await srv.fetch('/admin/api/qr.pdf?scope=codes&codes=', { headers: { Cookie: cookie } });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error.code, 'empty_selection');

  const missing = await srv.fetch('/admin/api/qr.pdf?scope=codes&codes=nope', { headers: { Cookie: cookie } });
  assert.equal(missing.status, 404);

  const tooMany = await srv.fetch(`/admin/api/qr.pdf?scope=codes&codes=${Array.from({ length: 501 }, (_, i) => `x${i}`).join(',')}`, {
    headers: { Cookie: cookie },
  });
  assert.equal(tooMany.status, 400);
  assert.equal((await tooMany.json()).error.code, 'too_many');
}));

test('拼版不调用外部字体：页内只有内置 Courier', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await srv.json('/admin/api/links', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ url: 'https://example.com/x', code: 'gamma', title: '中文标题' }),
  });
  const res = await srv.fetch('/admin/api/qr.pdf?scope=codes&codes=gamma', { headers: { Cookie: cookie } });
  const pdf = Buffer.from(await res.arrayBuffer());
  const text = pdf.toString('latin1');
  assert.match(text, /\/BaseFont \/Courier/);
  assert.doesNotMatch(text, /\/FontFile/, '不应内嵌字体文件');
  // 中文标题不该变成一串问号
  const { ops } = inspectPdf(pdf);
  assert.doesNotMatch(ops[0], /\?\?/, '不应打印问号占位');
}));

test('拼版样式：圆点走贝塞尔圆，颜色走 rg 三通道，纯黑白仍是最省的矩形路径', () => {
  const rows = [{ code: 'a', shortUrl: 'https://s.example.com/a', title: 'Alpha', url: 'https://example.com/a' }];

  const plain = inspectPdf(buildQrSheetPdf(rows, { cols: 2 }));
  assert.doesNotMatch(plain.ops[0], / c f/, '纯黑白不该出现曲线');
  assert.doesNotMatch(plain.ops[0], / rg/, '纯黑白不走彩色算子，省字节');
  // 黑白路径按行合并横向色块：矩形数应明显少于黑点总数
  const plainRects = [...plain.ops[0].matchAll(/re f/g)].length;
  const m = qrMatrix(rows[0].shortUrl);
  let darks = 0;
  for (let r = 0; r < m.count; r += 1) for (let c = 0; c < m.count; c += 1) if (m.isDark(r, c)) darks += 1;
  assert.ok(plainRects < darks / 2, `黑白路径应按 run 合并（矩形 ${plainRects} < 黑点 ${darks} 的一半）`);

  const dots = inspectPdf(buildQrSheetPdf(rows, { cols: 2, style: { dotStyle: 'dots', dark: '#8b5cf6' } }));
  assert.match(dots.ops[0], / c f/, '圆点应画贝塞尔曲线');
  assert.match(dots.ops[0], /0\.5451 0\.3608 0\.9647 rg/, '码点色应是 #8b5cf6 的 RGB');
  const dotsCircles = [...dots.ops[0].matchAll(/ c f/g)].length;
  assert.ok(dotsCircles > 50, `圆点路径按模块画，应有大量圆，实际 ${dotsCircles}`);
  // 圆点路径下矩形只剩白底那一块（逐模块的方块被换成了圆）
  const dotsRects = [...dots.ops[0].matchAll(/re f/g)].length;
  assert.ok(dotsRects <= 2, `圆点路径不该还在画方块，实际 ${dotsRects} 个矩形`);

  const rounded = inspectPdf(buildQrSheetPdf(rows, { cols: 2, style: { dotStyle: 'rounded' } }));
  assert.match(rounded.ops[0], / c f/, '圆角块也要画圆角');
});

test('拼版样式：渐变按对角插值，背景色落到页面', () => {
  const rows = [{ code: 'a', shortUrl: 'https://s.example.com/a', url: 'https://example.com/a' }];
  const { ops } = inspectPdf(buildQrSheetPdf(rows, {
    cols: 2,
    style: { dotStyle: 'rounded', gradient: ['#8b5cf6', '#22d3ee'], light: '#0f1023' },
  }));
  const colors = new Set([...ops[0].matchAll(/([\d.]+ [\d.]+ [\d.]+) rg/g)].map((m) => m[1]));
  // 起点、终点，以及两者之间至少一个中间色
  assert.ok(colors.size > 3, `渐变应产生多个颜色，实际 ${colors.size}`);
  assert.ok(colors.has('0.0588 0.0627 0.1373'), '深色底应被画出来');

  // 透明底在纸上没有意义，统一按白处理（纯黑白路径下走灰度算子）
  const onPaper = inspectPdf(buildQrSheetPdf(rows, { cols: 2, style: { light: 'transparent' } }));
  assert.match(onPaper.ops[0], /1\.000 g/, '透明底应回落成白底');
});

test('sheetStyleFromQuery 忽略非法参数，不因样式把请求打成 500', () => {
  const get = (map) => (k) => map[k];
  assert.deepEqual(sheetStyleFromQuery(get({})), {
    dotStyle: 'square', ecc: 'M', dark: '#000000', gradient: null, light: '#ffffff',
  });
  const odd = sheetStyleFromQuery(get({ dot: 'triangle', dark: 'not-a-color', gradient: 'red', ecc: 'Z' }));
  assert.equal(odd.dotStyle, 'square');
  assert.equal(odd.dark, '#000000', '非法颜色回落纯黑');
  assert.equal(odd.gradient, null);
  assert.equal(odd.ecc, 'M');

  const preset = sheetStyleFromQuery(get({ preset: 'brand' }));
  assert.equal(preset.dotStyle, 'rounded');
  assert.deepEqual(preset.gradient, ['#8b5cf6', '#22d3ee']);
});

test('批量 ZIP 与拼版都能带样式参数', () => withServer(async (srv) => {
  const cookie = await login(srv);
  await srv.json('/admin/api/links', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ url: 'https://example.com/s', code: 'styled' }),
  });

  const zip = await srv.fetch('/admin/api/qr.zip?scope=codes&codes=styled&preset=soft', { headers: { Cookie: cookie } });
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  const bytes = Buffer.from(await zip.arrayBuffer());
  // ZIP 里应该有一个 PNG 与一份对照表
  assert.ok(bytes.includes(Buffer.from('qr/styled.png')), '应含样式化的 PNG 条目');
  assert.ok(bytes.includes(Buffer.from('codes.csv')));

  // 非法样式参数只回落默认，不能让接口 500
  const bad = await srv.fetch('/admin/api/qr.zip?scope=codes&codes=styled&dot=triangle&dark=zzz', { headers: { Cookie: cookie } });
  assert.equal(bad.status, 200);

  const pdf = await srv.fetch('/admin/api/qr.pdf?scope=codes&codes=styled&dot=dots&gradient=%238b5cf6,%2322d3ee', {
    headers: { Cookie: cookie },
  });
  assert.equal(pdf.status, 200);
  const { ops } = inspectPdf(Buffer.from(await pdf.arrayBuffer()));
  assert.match(ops[0], / c f/, '拼版应吃到 dot=dots');
}));
