import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { NotifyService, EVENTS, buildBody, sign } from '../src/services/notify.js';
import { HealthChecker } from '../src/services/health.js';
import { makeStore, silentLogger, startTestServer } from './helpers.js';

/** 起一个能记录请求的接收端，模拟对方的 webhook */
async function sink({ status = 200, body = 'ok', delay = 0 } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ headers: req.headers, body: raw, method: req.method });
      setTimeout(() => {
        res.writeHead(status, { 'Content-Type': 'text/plain' });
        res.end(body);
      }, delay);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/hook`,
    seen,
    stop: () => new Promise((r) => server.close(r)),
  };
}

function makeNotify(overrides = {}) {
  const { store, settings, config, dir } = makeStore();
  // 测试的接收端就在 127.0.0.1，不放行内网的话一条都发不出去
  settings.update({ notifyAllowPrivate: true });
  const notify = new NotifyService({ store, settings, logger: silentLogger, ...overrides });
  return { store, settings, config, dir, notify };
}

const waitFor = async (fn, { timeout = 3000 } = {}) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

test('buildBody 会把统一事件转成各平台格式', () => {
  const payload = { event: 'link.dead', text: '短链 /abc 挂了', subject: 'abc' };
  assert.equal(buildBody('slack', payload).text, '短链 /abc 挂了');
  assert.deepEqual(buildBody('feishu', payload), { msg_type: 'text', content: { text: '短链 /abc 挂了' } });
  assert.deepEqual(buildBody('dingtalk', payload), { msgtype: 'text', text: { content: '短链 /abc 挂了' } });
  // 通用 webhook 原样发，接收端才拿得到 data 里的结构化字段
  assert.equal(buildBody('webhook', payload).event, 'link.dead');
});

test('签名按「时间戳.报文」算，换个时间戳就不一样', () => {
  const a = sign('s3cret', '1700000000000', '{"a":1}');
  const b = sign('s3cret', '1700000000001', '{"a":1}');
  assert.notEqual(a, b);
  assert.equal(a, sign('s3cret', '1700000000000', '{"a":1}'));
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('渠道创建校验：地址、事件都不能空，密钥不外泄', () => {
  const { notify } = makeNotify();
  assert.throws(() => notify.createChannel({ name: 'x', url: 'ftp://a/b', events: ['link.dead'] }), /http/);
  assert.throws(() => notify.createChannel({ name: 'x', url: 'https://a.example/h', events: [] }), /事件/);
  const channel = notify.createChannel({ name: '运维', url: 'https://a.example/hook', events: ['link.dead', '乱写'], secret: 'k' });
  assert.deepEqual(channel.events, ['link.dead']);
  assert.equal(channel.hasSecret, true);
  // 明文密钥不能跑到接口返回里
  assert.equal(channel.secret, undefined);
});

test('发了不该发的事件、或没有渠道订阅，就不产生投递记录', () => {
  const { notify, store } = makeNotify();
  assert.equal(notify.emit('不存在的事件', {}), 0);
  assert.equal(notify.emit('link.dead', { subject: 'abc' }), 0);
  notify.createChannel({ name: 'a', url: 'https://a.example/h', events: ['report.new'] });
  assert.equal(notify.emit('link.dead', { subject: 'abc' }), 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM notify_deliveries').get().n, 0);
});

test('投递成功：报文正确、带签名与事件头、记录落库', async () => {
  const hook = await sink();
  const { notify, store } = makeNotify();
  try {
    notify.createChannel({ name: '运维群', url: hook.url, events: ['link.dead'], secret: 'abc123' });
    notify.emit('link.dead', { subject: 'abc', text: '自定义文案', data: { code: 'abc' } });
    assert.ok(await waitFor(() => hook.seen.length === 1));
    const req = hook.seen[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.headers['x-highurl-event'], 'link.dead');
    assert.ok(req.headers['x-highurl-delivery']);
    const body = JSON.parse(req.body);
    assert.equal(body.event, 'link.dead');
    assert.equal(body.text, '自定义文案');
    assert.equal(body.data.code, 'abc');
    assert.equal(req.headers['x-highurl-signature'], `sha256=${sign('abc123', req.headers['x-highurl-timestamp'], req.body)}`);
    assert.ok(await waitFor(() => store.db.prepare("SELECT status FROM notify_deliveries").get()?.status === 'success'));
    const row = store.db.prepare('SELECT * FROM notify_deliveries').get();
    assert.equal(row.code, 200);
    assert.equal(row.attempts, 1);
  } finally {
    await hook.stop();
  }
});

test('对方非 2xx：记下状态码与响应正文，不吞掉失败', async () => {
  const hook = await sink({ status: 500, body: 'boom' });
  const { notify, store } = makeNotify();
  try {
    notify.createChannel({ name: '运维群', url: hook.url, events: ['report.new'] });
    notify.emit('report.new', { subject: 'abc' });
    // 第一次失败会进入重试，status=retry 且原因已经落库
    assert.ok(await waitFor(() => store.db.prepare("SELECT status FROM notify_deliveries").get()?.status === 'retry'));
    const row = store.db.prepare('SELECT * FROM notify_deliveries').get();
    assert.equal(row.code, 500);
    assert.match(row.note, /boom/);
    assert.equal(row.attempts, 1);
  } finally {
    await hook.stop();
  }
});

test('地址不可达时 emit 不抛异常，主流程不受影响', async () => {
  const { notify, store } = makeNotify({ fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')) });
  // 用一个真实存在但拒绝连接的地址：走的是 fetch 抛错那条路
  notify.createChannel({ name: 'a', url: 'https://127.0.0.2:1/h', events: ['backup.failed'] });
  assert.doesNotThrow(() => notify.emit('backup.failed', { subject: 'auto-backup' }));
  assert.ok(await waitFor(() => store.db.prepare("SELECT status FROM notify_deliveries").get()?.status === 'retry'));
  const row = store.db.prepare('SELECT * FROM notify_deliveries').get();
  assert.match(row.note, /ECONNREFUSED/);
});

test('去重窗口内同一事件同一主体只推一次', async () => {
  const hook = await sink();
  const { notify, store, settings } = makeNotify();
  try {
    settings.update({ notifyDedupeHours: 6 });
    const channel = notify.createChannel({ name: 'a', url: hook.url, events: ['link.dead'] });
    assert.equal(notify.emit('link.dead', { subject: 'abc' }), 1);
    assert.ok(await waitFor(() => store.db.prepare("SELECT status FROM notify_deliveries WHERE status = 'success'").get()));
    // 同一主体再来一次：被去重挡掉，队列里没有新任务
    assert.equal(notify.emit('link.dead', { subject: 'abc' }), 0);
    // 换主体照常推
    assert.equal(notify.emit('link.dead', { subject: 'def' }), 1);
    assert.ok(channel);
    // 关掉窗口后不再去重
    settings.update({ notifyDedupeHours: 0 });
    assert.equal(notify.emit('link.dead', { subject: 'abc' }), 1);
  } finally {
    await hook.stop();
  }
});

test('内网地址默认拦下，打开开关才放行', async () => {
  const hook = await sink();
  const { notify, store, settings } = makeNotify();
  try {
    settings.update({ notifyAllowPrivate: false });
    notify.createChannel({ name: 'a', url: hook.url, events: ['link.dead'] });
    notify.emit('link.dead', { subject: 'x' });
    assert.ok(await waitFor(() => store.db.prepare("SELECT status FROM notify_deliveries").get()?.status === 'retry'));
    assert.equal(hook.seen.length, 0);
    const row = store.db.prepare('SELECT * FROM notify_deliveries').get();
    assert.match(row.note, /内网/);
  } finally {
    await hook.stop();
  }
});

test('手动测试返回对方的状态码，失败也算记录', async () => {
  const okHook = await sink();
  const badHook = await sink({ status: 404, body: 'no such token' });
  const { notify, store } = makeNotify();
  try {
    const good = notify.createChannel({ name: 'good', url: okHook.url, events: ['link.dead'] });
    const bad = notify.createChannel({ name: 'bad', url: badHook.url, events: ['link.dead'] });
    const a = await notify.test(good.id);
    assert.equal(a.ok, true);
    assert.equal(a.status, 200);
    const b = await notify.test(bad.id);
    assert.equal(b.ok, false);
    assert.equal(b.status, 404);
    assert.match(b.note, /no such token/);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM notify_deliveries WHERE event = 'test'").get().n, 2);
  } finally {
    await okHook.stop();
    await badHook.stop();
  }
});

test('删除渠道时连投递记录一起清掉', async () => {
  const { notify, store } = makeNotify({ fetchImpl: () => Promise.reject(new Error('x')) });
  notify.createChannel({ name: 'a', url: 'https://127.0.0.2:1/h', events: ['link.dead'] });
  notify.emit('link.dead', { subject: 'abc' });
  assert.ok(await waitFor(() => store.db.prepare('SELECT COUNT(*) AS n FROM notify_deliveries').get().n === 1));
  const [channel] = notify.listChannels();
  notify.deleteChannel(channel.id);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM notify_deliveries').get().n, 0);
  assert.equal(notify.listChannels().length, 0);
});

test('巡检只在「刚变成死链」那一次推通知', async () => {
  const hook = await sink();
  const { notify, store, settings } = makeNotify();
  try {
    notify.createChannel({ name: 'a', url: hook.url, events: ['link.dead'] });
    store.sql.insertLink.run('dead1', 'https://example.com/x', '', '', '', 'active', null, Date.now(), Date.now(), null, null);
    const checker = new HealthChecker({
      store,
      settings,
      logger: silentLogger,
      notify,
      probe: async () => ({ ok: false, status: 404, ms: 1, error: 'HTTP 404' }),
    });
    // 第一次：连续失败 1 次 → warn，还不算死链，不该推
    await checker.run({ only: ['dead1'] });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(hook.seen.length, 0);
    // 第二次：达到阈值 → dead，推一次
    await checker.run({ only: ['dead1'] });
    assert.ok(await waitFor(() => hook.seen.length === 1));
    // 第三次：已经是 dead 了，不再重复推
    await checker.run({ only: ['dead1'] });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(hook.seen.length, 1);
    const events = store.db.prepare("SELECT COUNT(*) AS n FROM notify_deliveries WHERE event = 'link.dead'").get().n;
    assert.equal(events, 1);
  } finally {
    await hook.stop();
  }
});

test('举报会推通知，但正文不进通知', async () => {
  const hook = await sink();
  const server = await startTestServer();
  try {
    // 直接往真实的服务器实例上配渠道：走的是同一条 emit 路径
    server.ctx.settings.update({ notifyAllowPrivate: true });
    server.ctx.notify.createChannel({ name: 'a', url: hook.url, events: ['report.new'] });
    server.ctx.settings.update({ allowReport: true, publicCreate: true });
    const code = 'repx1';
    await server.ctx.links.create({ code, url: 'https://example.com/report-target' }, { actor: 'admin' });
    const res = await server.fetch(`/${code}+?report=1`, { method: 'GET' });
    assert.equal(res.status, 200);
    const form = new URLSearchParams({ kind: 'report', reason: 'spam', note: '这是一段很长的匿名正文' });
    const posted = await server.fetch(`/${code}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    assert.equal(posted.status, 303);
    assert.ok(await waitFor(() => hook.seen.length >= 1));
    const body = JSON.parse(hook.seen[0].body);
    assert.equal(body.event, 'report.new');
    assert.equal(body.data.code, code);
    assert.equal(body.data.reason, 'spam');
    // 匿名访问者写的正文不该被原样转发出去
    assert.equal(JSON.stringify(body).includes('匿名正文'), false);
  } finally {
    await server.stop();
    await hook.stop();
  }
});

test('通知接口：创建、列表、测试、投递记录、鉴权', async () => {
  const server = await startTestServer();
  try {
    const anonymous = await server.json('/admin/api/notify/channels');
    assert.equal(anonymous.res.status, 401);

    server.ctx.auth.createAdmin('admin', 'password123');
    const login = await server.fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: 'password123' }).toString(),
    });
    // 表单登录成功是 303 跳回管理台，和 /login 页面本身用 200 是两回事
    assert.equal(login.status, 303);
    const cookie = (login.headers.getSetCookie?.() || [login.headers.get('set-cookie')])
      .map((c) => String(c).split(';')[0])
      .join('; ');

    const created = await server.json('/admin/api/notify/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: '运维群', url: 'https://hooks.example.com/x', events: ['link.dead'] }),
    });
    assert.equal(created.res.status, 200);
    assert.equal(created.body.result.name, '运维群');

    const list = await server.json('/admin/api/notify/channels', { headers: { Cookie: cookie } });
    assert.equal(list.body.result.items.length, 1);
    assert.equal(list.body.result.events.length, Object.keys(EVENTS).length);

    const invalid = await server.json('/admin/api/notify/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'x', url: 'not-a-url', events: ['link.dead'] }),
    });
    assert.equal(invalid.res.status, 400);
    assert.equal(invalid.body.error.code, 'channel_invalid');

    const deliveries = await server.json('/admin/api/notify/deliveries', { headers: { Cookie: cookie } });
    assert.equal(deliveries.res.status, 200);
    assert.ok('failed' in deliveries.body.result.counts);

    const removed = await server.json(`/admin/api/notify/channels/${created.body.result.id}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.equal(removed.res.status, 200);
  } finally {
    await server.stop();
  }
});
