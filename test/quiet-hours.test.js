import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { NotifyService, inQuietHours, parseClock, QUIET_POLICIES } from '../src/services/notify.js';
import { makeStore, silentLogger, startTestServer } from './helpers.js';

async function sink({ status = 200 } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ headers: req.headers, body: raw });
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/hook`, seen, stop: () => new Promise((r) => server.close(r)) };
}

function makeNotify() {
  const { store, settings } = makeStore();
  settings.update({ notifyAllowPrivate: true });
  const notify = new NotifyService({ store, settings, logger: silentLogger });
  return { store, settings, notify };
}

const at = (h, m = 0) => new Date(2026, 0, 5, h, m, 0);
const waitFor = async (fn, timeout = 3000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

test('parseClock 只认 HH:MM，非法一律 null', () => {
  assert.equal(parseClock('22:00'), 22 * 60);
  assert.equal(parseClock('8:05'), 8 * 60 + 5);
  assert.equal(parseClock('24:00'), null);
  assert.equal(parseClock('12:60'), null);
  assert.equal(parseClock('早上'), null);
  assert.equal(parseClock(''), null);
});

test('inQuietHours 支持跨夜与白天区间，起止相同视为未设置', () => {
  // 跨夜：22:00 → 08:00
  assert.equal(inQuietHours('22:00', '08:00', at(23)), true);
  assert.equal(inQuietHours('22:00', '08:00', at(3)), true);
  assert.equal(inQuietHours('22:00', '08:00', at(8)), true);
  assert.equal(inQuietHours('22:00', '08:00', at(12)), false);
  // 白天区间：09:00 → 18:00
  assert.equal(inQuietHours('09:00', '18:00', at(9)), true);
  assert.equal(inQuietHours('09:00', '18:00', at(8, 59)), false);
  // 起止相同 / 缺失 / 写错，都不该把整天吞掉
  assert.equal(inQuietHours('10:00', '10:00', at(10)), false);
  assert.equal(inQuietHours('', '', at(3)), false);
  assert.equal(inQuietHours('乱写', '08:00', at(3)), false);
});

test('渠道静默配置走白名单：非法时间当作没填，事件也要认得', () => {
  const { notify } = makeNotify();
  const c = notify.createChannel({
    name: '运维', url: 'https://a.example/hook', events: ['link.dead'],
    quiet: { from: '25:00', to: '08:00', policy: '乱写', pierce: ['backup.failed', '不存在的'] },
  });
  assert.deepEqual(c.quiet, { from: '', to: '', policy: 'digest', pierce: ['backup.failed'] });

  const ok = notify.updateChannel(c.id, { quiet: { from: '22:00', to: '08:00', policy: 'drop', pierce: [] } });
  assert.deepEqual(ok.quiet, { from: '22:00', to: '08:00', policy: 'drop', pierce: [] });
  // 不传 quiet 时不该被清空
  const kept = notify.updateChannel(c.id, { name: '运维群' });
  assert.equal(kept.quiet.from, '22:00');
});

test('静默期内的事件挂起来，不立即投递', async () => {
  const target = await sink();
  try {
    const { notify, store } = makeNotify();
    const now = at(3);
    notify.createChannel({
      name: '运维', url: target.url, events: ['link.dead'],
      quiet: { from: '22:00', to: '08:00', policy: 'digest' },
    });
    // emit 用的是真实时钟，测试里换掉静默判断的时间源：直接用一个覆盖全天的窗口更稳
    const channel = notify.listChannels({ withSecret: true })[0];
    notify.updateChannel(channel.id, { quiet: { from: '00:00', to: '23:59', policy: 'digest' } });
    const queued = notify.emit('link.dead', { subject: 'abc' });
    assert.equal(queued, 1);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(target.seen.length, 0, '静默期内不该真的发出去');
    const held = store.db.prepare("SELECT * FROM notify_deliveries WHERE status = 'held'").all();
    assert.equal(held.length, 1);
    assert.equal(held[0].event, 'link.dead');
    void now;
  } finally {
    await target.stop();
  }
});

test('静默期内同一件事不重复挂起', async () => {
  const { notify, store } = makeNotify();
  notify.createChannel({
    name: '运维', url: 'https://a.example/hook', events: ['link.dead'],
    quiet: { from: '00:00', to: '23:59', policy: 'digest' },
  });
  notify.emit('link.dead', { subject: 'abc' });
  notify.emit('link.dead', { subject: 'abc' });
  const held = store.db.prepare("SELECT * FROM notify_deliveries WHERE status = 'held'").all();
  assert.equal(held.length, 1);
});

test('静默结束合并成一条摘要补发，明细也标记清楚', async () => {
  const target = await sink();
  try {
    const { notify, store } = makeNotify();
    notify.createChannel({
      name: '运维', url: target.url, events: ['link.dead', 'report.new'],
      quiet: { from: '00:00', to: '23:59', policy: 'digest' },
    });
    notify.emit('link.dead', { subject: 'abc' });
    notify.emit('link.dead', { subject: 'def' });
    notify.emit('report.new', { subject: 'ghi' });
    // 静默期结束：把窗口挪到「没有静默」，再补发
    const channel = notify.listChannels({ withSecret: true })[0];
    notify.updateChannel(channel.id, { quiet: {} });
    const out = notify.releaseHeld();
    assert.equal(out.released, 3);
    const ok = await waitFor(() => target.seen.length === 1, 2000);
    assert.equal(ok, true, '三条挂起的应该合成一条摘要，而不是发三条');
    const body = JSON.parse(target.seen[0].body);
    assert.equal(body.event, 'digest');
    assert.match(body.text, /攒下 3 条/);
    assert.match(body.text, /短链变成死链 2 条/);
    const held = store.db.prepare("SELECT COUNT(*) AS n FROM notify_deliveries WHERE status = 'held'").get().n;
    assert.equal(held, 0, '补发后不该还挂在静默里');
    const digests = store.db.prepare("SELECT COUNT(*) AS n FROM notify_deliveries WHERE event = 'digest'").get().n;
    assert.equal(digests, 1);
  } finally {
    await target.stop();
  }
});

test('仍处在静默期时不补发', async () => {
  const { notify, store } = makeNotify();
  notify.createChannel({
    name: '运维', url: 'https://a.example/hook', events: ['link.dead'],
    quiet: { from: '00:00', to: '23:59', policy: 'digest' },
  });
  notify.emit('link.dead', { subject: 'abc' });
  // 用「现在」判断，现在就在静默里
  const out = notify.releaseHeld();
  assert.equal(out.released, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM notify_deliveries WHERE status = 'held'").get().n, 1);
});

test('policy=drop 时静默期内直接不发，但留下「被吞了」的记录', () => {
  const { notify, store } = makeNotify();
  notify.createChannel({
    name: '运维', url: 'https://a.example/hook', events: ['report.new'],
    quiet: { from: '00:00', to: '23:59', policy: 'drop' },
  });
  notify.emit('report.new', { subject: 'abc' });
  const rows = store.db.prepare("SELECT * FROM notify_deliveries WHERE status = 'dropped'").all();
  assert.equal(rows.length, 1);
  assert.match(rows[0].note, /静默/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM notify_deliveries WHERE status = 'held'").get().n, 0);
});

test('可以指定某些事件穿透静默，立刻发出去', async () => {
  const target = await sink();
  try {
    const { notify } = makeNotify();
    notify.createChannel({
      name: '运维', url: target.url, events: ['backup.failed', 'link.dead'],
      quiet: { from: '00:00', to: '23:59', policy: 'digest', pierce: ['backup.failed'] },
    });
    notify.emit('backup.failed', { subject: 'auto-backup', text: '备份失败' });
    const ok = await waitFor(() => target.seen.length === 1, 2000);
    assert.equal(ok, true, '被放行的事件应该立刻发');
    assert.match(JSON.parse(target.seen[0].body).text, /备份失败/);
  } finally {
    await target.stop();
  }
});

test('投递记录统计里单列静默待发与静默未发', () => {
  const { notify } = makeNotify();
  const a = notify.createChannel({ name: 'a', url: 'https://a.example/h', events: ['link.dead'], quiet: { from: '00:00', to: '23:59' } });
  const b = notify.createChannel({ name: 'b', url: 'https://b.example/h', events: ['link.dead'], quiet: { from: '00:00', to: '23:59', policy: 'drop' } });
  notify.emit('link.dead', { subject: 'x' });
  const { counts, items } = notify.deliveries({ limit: 20 });
  assert.equal(counts.held, 1);
  assert.equal(counts.dropped, 1);
  // 挂起与丢弃都排在有结论的前面，第一眼就能看到
  assert.equal(items[0].channel, a.name || items[0].channel);
  assert.ok(items.some((i) => i.channel === b.name));
  // 提示：枚举要对得上前端标签
  assert.equal(QUIET_POLICIES.digest !== undefined, true);
});

test('HTTP：渠道接口回传静默配置与「是否静默中」', async () => {
  const server = await startTestServer();
  try {
    await server.ctx.auth.createAdmin('admin', 'Passw0rd!23');
    const loginRes = await server.fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: 'Passw0rd!23' }),
    });
    const cookie = String(loginRes.headers.get('set-cookie') || '').split(';')[0];
    const created = await server.json('/admin/api/notify/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        name: '运维', url: 'https://hooks.example.com/highurl', events: ['link.dead'],
        quiet: { from: '00:00', to: '23:59', policy: 'digest' },
      }),
    });
    assert.equal(created.res.status, 200);
    assert.equal(created.body.result.quiet.from, '00:00');
    assert.equal(created.body.result.quietActive, true);
    const list = await server.json('/admin/api/notify/channels', { headers: { Cookie: cookie } });
    assert.equal(list.body.result.items[0].quietActive, true);
    assert.deepEqual(list.body.result.policies.map((p) => p.key), ['digest', 'drop']);
    // 明文密钥不该出现在返回里
    assert.equal(list.body.result.items[0].secret, undefined);
  } finally {
    await server.stop();
  }
});

test('维护任务在静默结束后自动补发', async () => {
  const target = await sink();
  try {
    const { notify, store } = makeNotify();
    notify.createChannel({
      name: '运维', url: target.url, events: ['link.dead'],
      quiet: { from: '00:00', to: '23:59', policy: 'digest' },
    });
    notify.emit('link.dead', { subject: 'abc' });
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM notify_deliveries WHERE status = 'held'").get().n, 1);
    const channel = notify.listChannels({ withSecret: true })[0];
    notify.updateChannel(channel.id, { quiet: {} });
    const out = notify.releaseHeld();
    assert.equal(out.released, 1);
    assert.equal(await waitFor(() => target.seen.length === 1, 2000), true);
  } finally {
    await target.stop();
  }
});
