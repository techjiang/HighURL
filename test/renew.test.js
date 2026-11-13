import test from 'node:test';
import assert from 'node:assert/strict';

import { makeStore, cleanupTmp, startTestServer } from './helpers.js';
import { LinkService } from '../src/services/links.js';
import { SCHEMA_VERSION } from '../src/lib/db.js';
import { buildDigest } from '../src/services/insights.js';

test.after(() => cleanupTmp());

const DAY = 86400000;

function service(store, settings) {
  return new LinkService({ store, settings, titles: { fetch: async () => '' } });
}

function addLink(store, code, { expireAt = null } = {}) {
  const now = Date.now();
  store.sql.insertLink.run(code, `https://example.com/${code}`, `标题 ${code}`, '', '', 'active', null, now, now, expireAt, null);
  return store.sql.getLinkByCodeAny.get(code);
}

test('schema 到 v10：status_before_expire 列在，老库升级不丢数据', () => {
  assert.ok(SCHEMA_VERSION >= 10);
  const { store } = makeStore();
  const cols = store.db.prepare('PRAGMA table_info(links)').all().map((c) => c.name);
  assert.ok(cols.includes('status_before_expire'));
});

test('续期往后推，状态保持启用', () => {
  const { store, settings } = makeStore();
  const links = service(store, settings);
  const link = addLink(store, 'r1', { expireAt: Date.now() + 2 * DAY });
  const out = links.renew(link.id, { days: 30 });
  assert.ok(out.expire_at > Date.now() + 29 * DAY);
  assert.equal(out.status, 'active');
});

test('永久 = 清掉有效期，不是设成一个很大的数', () => {
  const { store, settings } = makeStore();
  const links = service(store, settings);
  const link = addLink(store, 'r2', { expireAt: Date.now() + 3 * DAY });
  const out = links.renew(link.id, { expireAt: null });
  assert.equal(out.expire_at, null);
});

test('续到过去被拒绝：手滑不该让链接立刻失效', () => {
  const { store, settings } = makeStore();
  const links = service(store, settings);
  const link = addLink(store, 'r3', { expireAt: Date.now() + DAY });
  assert.throws(() => links.renew(link.id, { expireAt: Date.now() - DAY }), /必须晚于当前时间/);
});

test('过期被自动停用的，续期恢复成启用', () => {
  const { store, settings } = makeStore();
  const links = service(store, settings);
  const link = addLink(store, 'r4', { expireAt: Date.now() - DAY });
  store.db
    .prepare("UPDATE links SET status = 'disabled', status_before_expire = 'active' WHERE id = ?")
    .run(link.id);
  const out = links.renew(link.id, { days: 7 });
  assert.equal(out.status, 'active', '原本是启用的，续期后应该能访问');
});

test('本来就手动停用的，续期不会替人打开', () => {
  const { store, settings } = makeStore();
  const links = service(store, settings);
  const link = addLink(store, 'r5', { expireAt: Date.now() + DAY });
  store.sql.updateLink.run(link.url, link.title, '', '', 'disabled', link.expire_at, Date.now(), link.id);
  const out = links.renew(link.id, { days: 7 });
  assert.equal(out.status, 'disabled', '管理员自己关掉的，不该因为续期被打开');
});

test('批量续期：从「现在」起算，不是从过期时间起算', () => {
  const { store, settings } = makeStore();
  const links = service(store, settings);
  addLink(store, 'b1', { expireAt: Date.now() - 5 * DAY });
  addLink(store, 'b2', { expireAt: Date.now() + 2 * DAY });
  const out = links.renewMany(['b1', 'b2'], { days: 30 });
  assert.equal(out.affected, 2);
  const b1 = store.sql.getLinkByCodeAny.get('b1');
  const b2 = store.sql.getLinkByCodeAny.get('b2');
  assert.ok(b1.expire_at > Date.now() + 29 * DAY, '已过期 5 天的链不该只延到「还差 -5+30」');
  assert.ok(b2.expire_at > Date.now() + 31 * DAY, '原本还有 2 天的，应该从原有效期接着延（2+30）');
});

test('批量续期报告缺哪些短码，不做静默跳过', () => {
  const { store, settings } = makeStore();
  const links = service(store, settings);
  addLink(store, 'b3', { expireAt: Date.now() + DAY });
  const out = links.renewMany(['b3', 'nope'], { days: 7 });
  assert.equal(out.affected, 1);
  assert.deepEqual(out.missing, ['nope']);
});

test('批量续期到指定日期，自己填 day 也不是从 0 点算', () => {
  const { store, settings } = makeStore();
  const links = service(store, settings);
  addLink(store, 'b4', { expireAt: null });
  const day = new Date(Date.now() + 10 * DAY);
  const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  const out = links.renewMany(['b4'], { expireAt: iso });
  const row = store.sql.getLinkByCodeAny.get('b4');
  assert.ok(row.expire_at > Date.now() + 9 * DAY, '纯日期按当天 23:59 算，不是 0 点');
  assert.equal(out.days, 0);
});

test('即将到期列表：只含还没过期的，按剩余时间升序', () => {
  const { store, settings } = makeStore();
  void settings;
  addLink(store, 'e1', { expireAt: Date.now() + 5 * DAY });
  addLink(store, 'e2', { expireAt: Date.now() + 2 * DAY });
  addLink(store, 'e3', { expireAt: Date.now() - DAY });
  addLink(store, 'e4', { expireAt: null });
  const out = store.expiringLinks({ days: 7 });
  assert.deepEqual(out.rows.map((r) => r.code), ['e2', 'e1']);
});

test('列表的 expiring 窗口与「已过期」筛选互不重叠', () => {
  const { store, settings } = makeStore();
  void settings;
  const expired = addLink(store, 'w1', { expireAt: Date.now() - DAY });
  void expired;
  addLink(store, 'w2', { expireAt: Date.now() + 3 * DAY });
  const soon = store.listLinks({ expiring: '7' });
  assert.deepEqual(soon.rows.map((r) => r.code), ['w2']);
  const old = store.listLinks({ status: 'expired' });
  assert.deepEqual(old.rows.map((r) => r.code), ['w1']);
});

test('到期不再只看 status：过期但状态还是 active 的也算已过期', () => {
  const { store, settings } = makeStore();
  void settings;
  addLink(store, 'x1', { expireAt: Date.now() - DAY });
  const row = store.sql.getLinkByCodeAny.get('x1');
  assert.equal(row.status, 'active', '策略关掉的站里，状态会停在 active');
  const list = store.listLinks({ status: 'expired' });
  assert.equal(list.total, 1, '列表口径要跟跳转一致');
});

test('日报把「即将到期」算进待处理项', () => {
  const { store } = makeStore();
  addLink(store, 'd1', { expireAt: Date.now() + 2 * DAY });
  const d = buildDigest(store);
  const item = d.items.find((i) => i.text.includes('天内过期'));
  assert.ok(item, '即将到期的链要出现在日报里');
  assert.equal(item.link, '#/links?expiring=7');
  assert.equal(d.counts.expiring, 1);
});

test('HTTP：单条续期与批量续期都要登录', async () => {
  const srv = await startTestServer({ titleFetch: false });
  await srv.ctx.auth.createAdmin('admin', 'Passw0rd!23');
  try {
    const anon = await srv.fetch('/admin/api/links/abc/renew', { method: 'POST' });
    assert.equal(anon.status, 401);

    const login = await srv.fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: 'Passw0rd!23' }),
    });
    const headers = { Cookie: String(login.headers.get('set-cookie') || '').split(';')[0], 'Content-Type': 'application/json' };

    const created = await srv.json('/admin/api/links', {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: 'https://example.com/renew', code: 'rn', expireAt: Date.now() + DAY }),
    });
    assert.equal(created.res.status, 200, JSON.stringify(created.body));

    const renewed = await srv.json('/admin/api/links/rn/renew', {
      method: 'POST',
      headers,
      body: JSON.stringify({ days: 30 }),
    });
    assert.equal(renewed.res.status, 200);

    const list = await srv.json('/admin/api/expiring?days=60', { headers });
    assert.equal(list.res.status, 200);
    assert.ok(list.body.result.rows.some((r) => r.code === 'rn'), '续期后应落在即将到期的窗口里');

    const batch = await srv.json('/admin/api/links/batch', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'renew', codes: ['rn'], expireAt: null }),
    });
    assert.equal(batch.res.status, 200);
    assert.equal(batch.body.result.affected, 1);
    assert.equal(batch.body.result.forever, true);

    const after = await srv.json('/admin/api/links/rn', { headers });
    assert.equal(after.body.result.expireAt, null, '永久续期后不再有有效期');

    // 单链统计要带上有效期：统计弹窗里那行「还有几天到期」读的就是它
    const stats = await srv.json('/admin/api/links/rn/stats', { headers });
    assert.ok(Object.prototype.hasOwnProperty.call(stats.body.result, 'expireAt'), 'stats 里要有 expireAt');
    assert.equal(stats.body.result.expireAt, null);
  } finally {
    await srv.stop();
  }
});
