import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { DigestPusher, digestSlot, digestWindowDays, isDigestDay, formatDigest } from '../src/services/digest-push.js';
import { NotifyService } from '../src/services/notify.js';
import { buildDigest } from '../src/services/insights.js';
import { makeStore, silentLogger, startTestServer } from './helpers.js';

async function sink() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ headers: req.headers, body: raw });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/hook`, seen, stop: () => new Promise((r) => server.close(r)) };
}

function makePusher(patch = {}) {
  const { store, settings } = makeStore();
  settings.update({ notifyAllowPrivate: true, ...patch });
  const notify = new NotifyService({ store, settings, logger: silentLogger });
  const pusher = new DigestPusher({ store, settings, notify, logger: silentLogger });
  return { store, settings, notify, pusher };
}

const waitFor = async (fn, timeout = 3000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

const at = (y, m, d, h = 9) => new Date(y, m - 1, d, h, 0, 0);

test('digestSlot：日报按本地日期，周报按 ISO 周且跨年不出现第 0 周', () => {
  assert.equal(digestSlot('daily', at(2026, 3, 9)), 'daily-2026-03-09');
  assert.equal(digestSlot('daily', at(2026, 3, 9, 23)), 'daily-2026-03-09', '同一天不同小时是同一个槽位');
  // 2026-01-01 是周四，属于 2026-W01
  assert.equal(digestSlot('weekly', at(2026, 1, 1)), 'weekly-2026-W01');
  // 2026-12-31 是周四，属于 2026-W53；2027-01-01 属于上一年最后一周
  assert.equal(digestSlot('weekly', at(2027, 1, 1)), 'weekly-2026-W53');
});

test('digestWindowDays：日报 1 天、周报 7 天，越界回落到默认', () => {
  assert.equal(digestWindowDays('daily', undefined), 1);
  assert.equal(digestWindowDays('weekly', undefined), 7);
  assert.equal(digestWindowDays('daily', 5), 5);
  // 周报配成 1 天等于把周报改成日报，没意义，回落到 7
  assert.equal(digestWindowDays('weekly', 1), 7);
  assert.equal(digestWindowDays('daily', 0), 1);
  assert.equal(digestWindowDays('daily', 999), 1);
});

test('isDigestDay：只有周报限定周一，日报每天都推', () => {
  assert.equal(isDigestDay('daily', at(2026, 3, 11)), true);
  assert.equal(isDigestDay('weekly', at(2026, 3, 9)), true, '2026-03-09 是周一');
  assert.equal(isDigestDay('weekly', at(2026, 3, 10)), false);
});

test('formatDigest：结论在前，待处理单独一行，没配 baseUrl 时不编链接', () => {
  const digest = {
    days: 1,
    counts: { clicks: 12, clicksPrev: 10, views: 0, viewsPrev: 0, created: 1, expiring: 0 },
    items: [
      { kind: 'up', text: '点击较昨天涨 20%（10 → 12）', link: '#/sources' },
      { kind: 'warn', text: '有 2 条举报还没处理', link: '#/reports' },
    ],
  };
  const out = formatDigest(digest, { siteName: '演示站', baseUrl: '', at: at(2026, 3, 9) });
  assert.match(out.text, /演示站/);
  assert.match(out.text, /近 1 天/);
  assert.match(out.text, /点击较昨天涨 20%/);
  assert.match(out.text, /待处理 1 项：有 2 条举报还没处理/);
  assert.doesNotMatch(out.text, /#\/dashboard/, '没有 baseUrl 就不该给一个点不进去的地址');
  assert.equal(out.link, '');
  // 窗口不是 1 天时文案要跟着变，不能永远说「昨天」
  const weekly = formatDigest({ ...digest, days: 7 }, { siteName: '演示站', at: at(2026, 3, 9) });
  assert.match(weekly.text, /近 7 天/);
});

test('关闭状态下 tick 与 push 都不发', async () => {
  const target = await sink();
  try {
    const { notify, pusher } = makePusher({ digestPushKind: 'off' });
    notify.createChannel({ name: '运维', url: target.url, events: ['digest.periodic'] });
    assert.equal(pusher.tick(at(2026, 3, 9)).pushed, 0);
    assert.equal(pusher.push({ now: at(2026, 3, 9).getTime() }).pushed, 0);
    assert.equal(pusher.nextRun(at(2026, 3, 9)), null);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(target.seen.length, 0);
  } finally {
    await target.stop();
  }
});

test('到点才推；同一天第二次 tick 不重复推', async () => {
  const target = await sink();
  try {
    const { notify, pusher } = makePusher({ digestPushKind: 'daily', digestPushHour: 9 });
    notify.createChannel({ name: '运维', url: target.url, events: ['digest.periodic'] });
    // 没到 9 点
    assert.equal(pusher.tick(at(2026, 3, 9, 8)).pushed, 0);
    // 到点：先造一条点击，否则空摘要不发
    pusher.store.sql.bumpClicks.run(3, Date.now(), 'abc');
    pusher.store.db
      .prepare('INSERT INTO links (code, url, created_at, updated_at, clicks) VALUES (?,?,?,?,?)')
      .run('abc', 'https://example.com', Date.now(), Date.now(), 3);
    const first = pusher.tick(at(2026, 3, 9, 9));
    assert.equal(first.pushed, 1);
    assert.equal(await waitFor(() => target.seen.length === 1), true);
    const body = JSON.parse(target.seen[0].body);
    assert.equal(body.event, 'digest.periodic');
    assert.match(body.text, /运营摘要/);
    // 同一槽位再来一次：不该再推
    assert.equal(pusher.tick(at(2026, 3, 9, 10)).pushed, 0);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(target.seen.length, 1);
  } finally {
    await target.stop();
  }
});

test('空摘要不发：没有点击也没有待办时不打扰人', async () => {
  const target = await sink();
  try {
    const { notify, pusher } = makePusher({ digestPushKind: 'daily', digestPushHour: 9 });
    notify.createChannel({ name: '运维', url: target.url, events: ['digest.periodic'] });
    const out = pusher.push({ now: at(2026, 3, 9, 9).getTime() });
    assert.equal(out.pushed, 0);
    assert.equal(out.skipped, 'empty');
    // 但手动强制推应该能发出来：人点了按钮就是想要这一条
    const forced = pusher.push({ now: at(2026, 3, 9, 9).getTime(), force: true });
    assert.equal(forced.pushed, 1);
    assert.equal(await waitFor(() => target.seen.length === 1), true);
  } finally {
    await target.stop();
  }
});

test('周报只在周一推，周二安静；下一槽位是下一周的周一', async () => {
  const target = await sink();
  try {
    const { notify, pusher } = makePusher({ digestPushKind: 'weekly', digestPushHour: 8 });
    notify.createChannel({ name: '运维', url: target.url, events: ['digest.periodic'] });
    assert.equal(pusher.tick(at(2026, 3, 10, 9)).skipped, 'not-today');
    const next = new Date(pusher.nextRun(at(2026, 3, 10, 9)));
    assert.equal(next.getDay(), 1, '下次应该是周一');
    assert.equal(next.getDate(), 16);
    assert.equal(next.getHours(), 8);
  } finally {
    await target.stop();
  }
});

test('手动推送仍遵守渠道订阅与静默时段', async () => {
  const target = await sink();
  try {
    const { notify, pusher } = makePusher({ digestPushKind: 'off' });
    // 没订阅摘要事件的渠道不该收到
    notify.createChannel({ name: '只收死链', url: target.url, events: ['link.dead'] });
    assert.equal(pusher.push({ force: true }).pushed, 0);
    // 订阅了但在静默期里：挂起，不真的发
    const quiet = notify.createChannel({
      name: '运维', url: target.url, events: ['digest.periodic'],
      quiet: { from: '00:00', to: '23:59', policy: 'digest' },
    });
    assert.ok(quiet.id);
    assert.equal(pusher.push({ force: true }).pushed, 1);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(target.seen.length, 0, '静默期内手动推也不该把渠道真的打出去');
    const held = pusher.store.db.prepare("SELECT COUNT(*) AS n FROM notify_deliveries WHERE status = 'held'").get().n;
    assert.equal(held, 1);
  } finally {
    await target.stop();
  }
});

test('build 与概览同源：窗口天数进到 buildDigest 里', () => {
  const { pusher } = makePusher({ digestPushKind: 'weekly' });
  const built = pusher.build();
  assert.equal(built.windowDays, 7);
  const raw = buildDigest(pusher.store, { hours: 7 * 24 });
  assert.deepEqual(built.digest.counts, raw.counts);
  assert.equal(built.digest.days, raw.days);
});

test('HTTP：摘要预览与立即推送接口，只读账号不能推', async () => {
  const srv = await startTestServer();
  try {
    srv.ctx.auth.createAdmin('admin', 'password123');
    const login = await srv.fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: 'password123' }).toString(),
    });
    const cookie = (login.headers.getSetCookie?.() || [login.headers.get('set-cookie')])
      .map((c) => String(c).split(';')[0])
      .join('; ');
    const headers = { Cookie: cookie };

    const preview = await srv.json('/admin/api/digest/push', { headers });
    assert.equal(preview.res.status, 200);
    assert.equal(preview.body.result.kind, 'off');
    assert.ok(preview.body.result.text.includes('运营摘要'));
    assert.ok(preview.body.result.kinds.daily);
    assert.equal(preview.body.result.nextRunAt, null);

    const pushed = await srv.json('/admin/api/digest/push', { method: 'POST', headers });
    assert.equal(pushed.res.status, 200);
    assert.equal(pushed.body.result.pushed, 0, '没配渠道时应当明确说没发出去');

    // 设置项白名单：非法频率与小时被拒
    const bad = await srv.json('/admin/api/settings', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ digestPushKind: 'hourly', digestPushHour: 99 }),
    });
    assert.deepEqual(bad.body.rejected.sort(), ['digestPushHour', 'digestPushKind']);
    const ok = await srv.json('/admin/api/settings', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ digestPushKind: 'daily', digestPushHour: 7, digestPushWindowDays: 2 }),
    });
    assert.deepEqual(ok.body.applied, { digestPushKind: 'daily', digestPushHour: 7, digestPushWindowDays: 2 });
    const after = await srv.json('/admin/api/digest/push', { headers });
    assert.equal(after.body.result.kind, 'daily');
    assert.equal(after.body.result.windowDays, 2);
    assert.ok(after.body.result.nextRunAt, '开了之后要给下次推送时间');

    // 只读账号能看预览，但推不了：推送是一次对外写操作
    srv.ctx.auth.createAdmin('looker', 'viewer-pass-1', { role: 'viewer' });
    const vlogin = await srv.fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'looker', password: 'viewer-pass-1' }).toString(),
    });
    const vcookie = (vlogin.headers.getSetCookie?.() || [vlogin.headers.get('set-cookie')])
      .map((c) => String(c).split(';')[0])
      .join('; ');
    const vp = await srv.json('/admin/api/digest/push', { headers: { Cookie: vcookie } });
    assert.equal(vp.res.status, 200);
    const vpush = await srv.json('/admin/api/digest/push', { method: 'POST', headers: { Cookie: vcookie } });
    assert.equal(vpush.res.status, 403);
    assert.equal(vpush.body.error.code, 'readonly');
  } finally {
    await srv.stop();
  }
});

test('CLI digest 打印摘要，--push 在没有渠道时给出人话提示', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { tmpDir } = await import('./helpers.js');
  const run = promisify(execFile);
  const CLI = new URL('../src/cli.js', import.meta.url).pathname;
  const dir = tmpDir();
  const env = { ...process.env, HIGHURL_LOG_LEVEL: 'error' };
  const { stdout } = await run(process.execPath, [CLI, 'digest', '--days', '3', '--data', dir], { env });
  assert.match(stdout, /运营摘要/);
  assert.match(stdout, /近 3 天/);
  const pushed = await run(process.execPath, [CLI, 'digest', '--push', '--data', dir], { env });
  assert.match(pushed.stdout, /没有可推送的渠道/);
});

test('手动推送回报「真投递」与「静默挂起」的条数，重复推不把上一次算进来', async () => {
  const target = await sink();
  try {
    const { notify, pusher } = makePusher({ digestPushKind: 'off' });
    notify.createChannel({ name: '正常', url: target.url, events: ['digest.periodic'] });
    notify.createChannel({ name: '静默中', url: target.url, events: ['digest.periodic'], quiet: { from: '00:00', to: '23:59', policy: 'digest' } });
    const first = pusher.push({ force: true });
    assert.equal(first.detail.queued, 1);
    assert.equal(first.detail.held, 1);
    await waitFor(() => target.seen.length === 1);
    // 再点一次：统计应该只算这一次新增的那条，不是累加
    const second = pusher.push({ force: true });
    assert.equal(second.detail.queued, 1);
    assert.equal(second.detail.held, 1);
  } finally {
    await target.stop();
  }
});
