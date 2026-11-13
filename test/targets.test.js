import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeRegions,
  regionList,
  countryOf,
  weightedPick,
  pickTarget,
  normalizeTarget,
  seededRandom,
} from '../src/services/targets.js';
import { TargetService } from '../src/services/targets.js';
import { makeStore, startTestServer, silentLogger } from './helpers.js';
import { LinkService } from '../src/services/links.js';
import { TitleFetcher } from '../src/services/titles.js';

async function seed(store, settings, code, url = 'https://default.com/a') {
  const titles = new TitleFetcher({ settings, store, logger: silentLogger });
  const links = new LinkService({ store, settings, titles, logger: silentLogger });
  return links.create({ url, code, fetchTitle: false });
}

test('地区码解析：大小写归一、去重，非法码直接拒绝', () => {
  assert.equal(normalizeRegions('cn, HK'), 'CN,HK');
  assert.equal(normalizeRegions(['cn', 'CN', 'us']), 'CN,US');
  assert.equal(normalizeRegions(''), '');
  assert.equal(normalizeRegions(null), '');
  assert.deepEqual(regionList('CN,HK'), ['CN', 'HK']);
  assert.throws(() => normalizeRegions('CHN'), /不合法/);
  assert.throws(() => normalizeRegions('C'), /不合法/);
});

test('countryOf 只信代理头：CF 无条件认，其它要开 trustProxy', () => {
  assert.equal(countryOf({ headers: { 'cf-ipcountry': 'jp' } }), 'JP');
  assert.equal(countryOf({ headers: { 'cf-ipcountry': 'xx' } }), '', 'Cloudflare 的 XX 是未知');
  assert.equal(countryOf({ headers: { 'cf-ipcountry': 't1' } }), '', 'Tor 不是地区');
  assert.equal(countryOf({ headers: { 'x-country-code': 'de' } }), '', '不开 trustProxy 时客户端能随意伪造');
  assert.equal(countryOf({ headers: { 'x-country-code': 'de' } }, { trustProxy: true }), 'DE');
  assert.equal(countryOf({}, { trustProxy: true }), '');
});

test('weightedPick 按权重分布，权重全 0 时退化成等概率', () => {
  const list = [
    { id: 1, weight: 100, enabled: 1 },
    { id: 2, weight: 0, enabled: 1 },
  ];
  const rand = seededRandom(7);
  const hits = new Map();
  for (let i = 0; i < 4000; i += 1) {
    const hit = weightedPick(list, rand);
    hits.set(hit.id, (hits.get(hit.id) || 0) + 1);
  }
  assert.equal(hits.get(2), undefined, '权重 0 的目标永不选中');
  assert.equal(hits.get(1), 4000);
  // 权重全 0 时退化成等概率，不能变成「永远选第一条」
  const onlyZero = [{ id: 9, weight: 0, enabled: 1 }, { id: 10, weight: 0, enabled: 1 }];
  const seen = new Set();
  const r2 = seededRandom(3);
  for (let i = 0; i < 200; i += 1) seen.add(weightedPick(onlyZero, r2).id);
  assert.equal(seen.size, 2, '两条都应该被抽到过');
});

test('pickTarget：地区精确优先，其次全球兜底，最后回默认', () => {
  const targets = [
    { id: 1, url: 'https://global.com', weight: 100, regions: '', enabled: 1 },
    { id: 2, url: 'https://cn.com', weight: 1, regions: 'CN', enabled: 1 },
    { id: 3, url: 'https://off.com', weight: 500, regions: '', enabled: 0 },
  ];
  const cn = pickTarget(targets, 'CN', seededRandom(1));
  assert.equal(cn.url, 'https://cn.com', '地区命中优先于权重，哪怕权重只有 1');

  const us = pickTarget(targets, 'US', seededRandom(1));
  assert.equal(us.url, 'https://global.com', '没有地区匹配就走全球目标');

  // 只有地区目标、访客不在该地区 → 不回落到地区目标，交给默认
  const onlyCn = pickTarget([{ id: 2, url: 'https://cn.com', weight: 100, regions: 'CN', enabled: 1 }], 'US');
  assert.equal(onlyCn, null, '不该把 CN 专属目标发给 US 访客');

  assert.equal(pickTarget([], 'CN'), null);
  assert.equal(pickTarget([{ id: 3, url: 'x', weight: 100, regions: '', enabled: 0 }], 'CN'), null, '关停的目标不参与');
});

test('normalizeTarget 校验权重与链接', () => {
  const t = normalizeTarget({ url: 'example.com/b', weight: '40', regions: 'cn' });
  assert.equal(t.url, 'https://example.com/b');
  assert.equal(t.weight, 40);
  assert.equal(t.regions, 'CN');
  assert.equal(t.enabled, 1);
  assert.throws(() => normalizeTarget({ url: 'https://a.com', weight: -1 }), /权重/);
  assert.throws(() => normalizeTarget({ url: 'https://a.com', weight: 99999 }), /权重/);
  assert.throws(() => normalizeTarget({ url: 'ftp://a.com' }), /只支持/);
});

test('TargetService 整组替换：更新 / 新增 / 删除一次完成', async () => {
  const { store, settings } = makeStore();
  const link = await seed(store, settings, 'tgt1');
  const svc = new TargetService({ store, logger: silentLogger });

  const a = svc.replace(link.id, [{ url: 'https://b.com', label: 'B 版', weight: 30 }]);
  assert.equal(a.targets.length, 1);
  assert.equal(a.removed, 0);

  const firstId = a.targets[0].id;
  const b = svc.replace(link.id, [
    { id: firstId, url: 'https://b2.com', label: 'B 版改', weight: 70 },
    { url: 'https://c.com', weight: 30, regions: 'cn' },
  ]);
  assert.equal(b.targets.length, 2);
  assert.equal(b.targets.find((t) => t.id === firstId).url, 'https://b2.com/');
  assert.deepEqual(b.targets.find((t) => t.url.startsWith('https://c.com')).regions, ['CN']);

  const c = svc.replace(link.id, [{ id: firstId, url: 'https://b2.com', weight: 100 }]);
  assert.equal(c.removed, 1, '不在提交列表里的目标被删掉');
  assert.equal(c.targets.length, 1);

  // 清空 = 取消分流
  const d = svc.replace(link.id, []);
  assert.equal(d.targets.length, 0);
  assert.equal(d.removed, 1);
  store.close();
});

test('目标数量与冗余配置都有上限和保护', async () => {
  const { store, settings } = makeStore();
  const link = await seed(store, settings, 'tgt2', 'https://same.com/x');
  const svc = new TargetService({ store, logger: silentLogger });
  assert.throws(() => svc.replace(link.id, Array.from({ length: 9 }, (_, i) => ({ url: `https://x${i}.com` }))), /最多 8 个/);
  assert.throws(
    () => svc.replace(link.id, [{ url: 'https://same.com/x' }]),
    /等于没开分流/,
    '唯一目标与默认目标完全相同时直接拒绝，避免「以为开了 A/B」',
  );
  store.close();
});

test('跳转按地域选目标，并回写 X-Highurl-Target 头', async () => {
  const srv = await startTestServer();
  try {
    const link = await seed(srv.ctx.store, srv.ctx.settings, 'geo1', 'https://default.example/a');
    srv.ctx.targets.replace(link.id, [
      { url: 'https://cn.example/landing', weight: 100, regions: 'CN' },
      { url: 'https://global.example/landing', weight: 100 },
    ]);
    srv.ctx.cache.invalidate();

    const cn = await srv.fetch('/geo1', { headers: { 'CF-IPCountry': 'CN' } });
    assert.equal(cn.status, 302);
    assert.equal(cn.headers.get('location'), 'https://cn.example/landing');
    assert.ok(cn.headers.get('x-highurl-target'));

    const jp = await srv.fetch('/geo1', { headers: { 'CF-IPCountry': 'JP' } });
    assert.equal(jp.headers.get('location'), 'https://global.example/landing');

    // 没有地区头（直连 / 代理没配）时走全球目标，不能因此打不开
    const none = await srv.fetch('/geo1');
    assert.equal(none.headers.get('location'), 'https://global.example/landing');
  } finally {
    await srv.stop();
  }
});

test('目标全关停时安静回落到默认目标，短链不能因此打不开', async () => {
  const srv = await startTestServer();
  try {
    const link = await seed(srv.ctx.store, srv.ctx.settings, 'geo2', 'https://default.example/a');
    srv.ctx.targets.replace(link.id, [{ url: 'https://b.example', weight: 50, enabled: false }]);
    srv.ctx.cache.invalidate();
    const res = await srv.fetch('/geo2');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://default.example/a');
    assert.equal(res.headers.get('x-highurl-target'), null);
  } finally {
    await srv.stop();
  }
});

test('分流命中落到目标计数上，flush 后能在统计里看到', async () => {
  const srv = await startTestServer();
  try {
    const link = await seed(srv.ctx.store, srv.ctx.settings, 'geo3', 'https://default.example/a');
    srv.ctx.targets.replace(link.id, [
      { url: 'https://cn.example/x', weight: 100, regions: 'CN' },
      { url: 'https://global.example/x', weight: 100 },
    ]);
    srv.ctx.cache.invalidate();

    await srv.fetch('/geo3', { headers: { 'CF-IPCountry': 'CN' } });
    await srv.fetch('/geo3', { headers: { 'CF-IPCountry': 'US' } });
    await srv.ctx.counter.flush();

    const targets = srv.ctx.targets.list(link.id);
    const byUrl = new Map(targets.map((t) => [t.url, t.clicks]));
    assert.equal(byUrl.get('https://cn.example/x'), 1);
    assert.equal(byUrl.get('https://global.example/x'), 1);
  } finally {
    await srv.stop();
  }
});

test('地域统计进 click_countries，来源页能读到', async () => {
  const srv = await startTestServer();
  try {
    await srv.ctx.auth.createAdmin('admin', 'password123');
    await seed(srv.ctx.store, srv.ctx.settings, 'geo4', 'https://default.example/a');
    await srv.fetch('/geo4', { headers: { 'CF-IPCountry': 'DE' } });
    await srv.ctx.counter.flush();
    const rows = srv.ctx.store.sql.linkCountries.all('geo4', 5);
    assert.equal(rows[0].country, 'DE');
    assert.equal(rows[0].clicks, 1);
    const global = srv.ctx.store.sql.globalCountries.all(5);
    assert.ok(global.some((r) => r.country === 'DE'));
  } finally {
    await srv.stop();
  }
});

test('目标接口：鉴权、校验与整组提交', async () => {
  const srv = await startTestServer();
  try {
    await srv.ctx.auth.createAdmin('admin', 'password123');
    const login = await srv.fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: 'password123' }).toString(),
    });
    const cookie = login.headers.getSetCookie()[0].split(';')[0];
    const created = await srv.json('/admin/api/links', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://default.example/a', code: 'api1' }) });
    assert.equal(created.res.status, 200);

    const empty = await srv.json('/admin/api/links/api1/targets', { headers: { Cookie: cookie, 'Content-Type': 'application/json' } });
    assert.deepEqual(empty.body.result.targets, []);

    const put = await srv.json('/admin/api/links/api1/targets', {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets: [{ url: 'https://b.example/1', weight: 60 }, { url: 'https://c.example/1', weight: 40, regions: 'us' }] }),
    });
    assert.equal(put.res.status, 200);
    assert.equal(put.body.result.targets.length, 2);

    const bad = await srv.json('/admin/api/links/api1/targets', {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets: [{ url: 'https://b.example/1', regions: 'ZZZ' }] }),
    });
    assert.equal(bad.res.status, 400);
    assert.equal(bad.body.error.code, 'region_invalid');

    const anon = await srv.fetch('/admin/api/links/api1/targets');
    assert.equal(anon.status, 401);

    const list = await srv.json('/admin/api/links?q=api1', { headers: { Cookie: cookie, 'Content-Type': 'application/json' } });
    assert.equal(list.body.result.items[0].targetCount, 2, '列表要能看出这条有没有分流');
  } finally {
    await srv.stop();
  }
});

test('彻底删除短链时目标一并清掉，不留孤儿', async () => {
  const { store, settings } = makeStore();
  const link = await seed(store, settings, 'tgt3');
  const svc = new TargetService({ store, logger: silentLogger });
  svc.replace(link.id, [{ url: 'https://b.example' }]);
  assert.equal(store.sql.countTargets.get().n, 1);
  store.purgeLinkData('tgt3');
  assert.equal(store.sql.countTargets.get().n, 0);
  store.close();
});

test('备份导出带上目标，恢复后分流配置还在', async () => {
  const srv = await startTestServer();
  try {
    await srv.ctx.auth.createAdmin('admin', 'password123');
    const login = await srv.fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: 'password123' }).toString(),
    });
    const cookie = login.headers.getSetCookie()[0].split(';')[0];
    await srv.json('/admin/api/links', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://default.example/a', code: 'bk1' }) });
    await srv.json('/admin/api/links/bk1/targets', {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets: [{ url: 'https://b.example/1', weight: 25, label: 'B' }] }),
    });

    const dump = srv.ctx.store.exportAll();
    assert.equal(dump.link_targets.length, 1, '导出必须带目标，否则恢复完 A/B 就丢了');

    // 清掉再恢复
    srv.ctx.store.db.exec('DELETE FROM link_targets');
    const restored = await srv.json('/admin/api/restore', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: JSON.stringify(dump), mode: 'replace' }),
    });
    assert.equal(restored.res.status, 200);
    const row = srv.ctx.store.findLinkByCode('bk1');
    const targets = srv.ctx.targets.list(row.id);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].weight, 25);
    assert.equal(targets[0].label, 'B');
  } finally {
    await srv.stop();
  }
});

test('merge 恢复不动本地其它短链的分流配置', async () => {
  const srv = await startTestServer();
  try {
    await srv.ctx.auth.createAdmin('admin', 'password123');
    const login = await srv.fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: 'password123' }).toString(),
    });
    const cookie = login.headers.getSetCookie()[0].split(';')[0];
    const a = await srv.json('/admin/api/links', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://a.example', code: 'ma' }) });
    const b = await srv.json('/admin/api/links', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://b.example', code: 'mb' }) });
    await srv.json('/admin/api/links/mb/targets', {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets: [{ url: 'https://b2.example' }] }),
    });
    void a; void b;
    const partial = { links: [{ code: 'ma', url: 'https://a.example', title: '', clicks: 0, created_at: 1 }], link_targets: [] };
    await srv.json('/admin/api/restore', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: JSON.stringify(partial), mode: 'merge' }) });
    const mb = srv.ctx.store.findLinkByCode('mb');
    assert.equal(srv.ctx.targets.list(mb.id).length, 1, '备份里没有 mb，就不该动 mb 的目标');
  } finally {
    await srv.stop();
  }
});
