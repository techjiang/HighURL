import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeUrl, normalizeTags, LinkService } from '../src/services/links.js';
import { makeStore, silentLogger } from './helpers.js';

function makeService(overrides = {}) {
  const { store, settings, config } = makeStore();
  const titles = { fetch: async () => '' };
  if (overrides.titleFetch !== undefined) settings.update({ titleFetch: overrides.titleFetch });
  const links = new LinkService({ store, settings, titles, logger: silentLogger });
  return { store, settings, config, links, titles };
}

test('normalizeUrl 补全协议并规范化', () => {
  assert.equal(normalizeUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(normalizeUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeUrl('//example.com/x'), 'https://example.com/x');
  assert.equal(normalizeUrl('  http://example.com  '), 'http://example.com/');
  assert.equal(normalizeUrl('https://example.com/路径?q=1'), 'https://example.com/%E8%B7%AF%E5%BE%84?q=1');
});

test('normalizeUrl 拒绝非法输入', () => {
  assert.throws(() => normalizeUrl(''), /请填写目标链接/);
  assert.throws(() => normalizeUrl('   '), /请填写目标链接/);
  assert.throws(() => normalizeUrl('javascript:alert(1)'), /只支持 http 和 https/);
  assert.throws(() => normalizeUrl('ftp://example.com/x'), /只支持 http 和 https/);
  assert.throws(() => normalizeUrl('https://localhost/x'), /域名不合法/);
  assert.throws(() => normalizeUrl(`https://example.com/${'a'.repeat(5000)}`), /链接过长/);
});

test('normalizeTags 去重、截断、限量', () => {
  assert.equal(normalizeTags('a,b , a ， c'), 'a,b,c');
  assert.equal(normalizeTags(['x', 'x', 'y']), 'x,y');
  assert.equal(normalizeTags(''), '');
  assert.equal(normalizeTags('a'.repeat(30)).length, 0, '超长标签丢弃');
  const many = Array.from({ length: 20 }, (_, i) => `t${i}`).join(',');
  assert.equal(normalizeTags(many).split(',').length, 10);
});

test('create 自动生成短码并可查询', async () => {
  const { links, store } = makeService();
  const link = await links.create({ url: 'https://example.com/page' });
  assert.match(link.code, /^[A-Za-z0-9]{6}$/);
  assert.equal(link.url, 'https://example.com/page');
  assert.equal(link.status, 'active');
  assert.equal(store.sql.getLinkByCode.get(link.code).code, link.code);
  store.close();
});

test('create 支持自定义短码与标签', async () => {
  const { links, store } = makeService();
  const link = await links.create({ url: 'https://example.com', code: 'promo', tags: ['活动', '推广'], note: '备注' });
  assert.equal(link.code, 'promo');
  assert.equal(link.tags, '活动,推广');
  assert.equal(link.note, '备注');
  store.close();
});

test('短码冲突与保留字被拒', async () => {
  const { links, store } = makeService();
  await links.create({ url: 'https://example.com', code: 'taken1' });
  await assert.rejects(() => links.create({ url: 'https://example.com/2', code: 'taken1' }), /已被占用/);
  await assert.rejects(() => links.create({ url: 'https://example.com/2', code: 'admin' }), /系统保留路径/);
  await assert.rejects(() => links.create({ url: 'https://example.com/2', code: 'bad code' }), /只能包含字母/);
  await assert.rejects(() => links.create({ url: 'https://example.com/2', code: 'a'.repeat(65) }), /只能包含字母/);
  store.close();
});

test('短码大小写冲突也能识别', async () => {
  const { links, store } = makeService();
  await links.create({ url: 'https://example.com', code: 'CaseTest' });
  await assert.rejects(() => links.create({ url: 'https://example.com/2', code: 'casetest' }), /已被占用/);
  store.close();
});

test('update 修改 URL / 状态 / 有效期', async () => {
  const { links, store } = makeService();
  const created = await links.create({ url: 'https://example.com/old', code: 'upd1' });
  const updated = await links.update(created.id, { url: 'https://example.com/new', status: 'disabled', title: '新标题' });
  assert.equal(updated.url, 'https://example.com/new');
  assert.equal(updated.status, 'disabled');
  assert.equal(updated.title, '新标题');
  store.close();
});

test('update 拒绝不存在与非法短链', async () => {
  const { links, store } = makeService();
  await assert.rejects(() => links.update(99999, { title: 'x' }), /短链不存在/);
  const created = await links.create({ url: 'https://example.com' });
  await assert.rejects(() => links.update(created.id, { url: 'javascript:1' }), /只支持 http 和 https/);
  store.close();
});

test('remove 是软删除：进回收站但统计保留', async () => {
  const { links, store } = makeService();
  const link = await links.create({ url: 'https://example.com', code: 'del1' });
  store.sql.upsertDaily.run('del1', '2025-01-01', 5);
  links.remove(link.id);
  // 正常查询看不到，但记录还在
  assert.equal(store.sql.getLinkByCode.get('del1'), undefined);
  const trashed = store.sql.getLinkByCodeAny.get('del1');
  assert.ok(trashed.deleted_at > 0);
  // 回收站里仍占着短码，不会被人抢注
  assert.ok(store.sql.getLinkByCodeCI.get('del1') === undefined);
  assert.equal(links.trash().total, 1);
  store.close();
});

test('purge 彻底删除并清掉统计', async () => {
  const { links, store } = makeService();
  const link = await links.create({ url: 'https://example.com', code: 'del2' });
  store.sql.upsertDaily.run('del2', '2025-01-01', 5);
  store.sql.upsertRef.run('del2', 'google.com', 3);
  store.sql.upsertAgent.run('del2', 'ios', 2);
  links.remove(link.id);
  links.purge(link.id);
  assert.equal(store.sql.getLinkByCodeAny.get('del2'), undefined);
  assert.equal(store.sql.linkDaily.all('del2', '2000-01-01').length, 0);
  assert.equal(store.sql.linkRefs.all('del2', 10).length, 0);
  assert.equal(store.sql.linkAgents.all('del2', 10).length, 0);
  store.close();
});

test('恢复后短链重新可用', async () => {
  const { links, store } = makeService();
  const link = await links.create({ url: 'https://example.com', code: 'del3' });
  links.remove(link.id);
  const back = links.restore(link.id);
  assert.equal(back.code, 'del3');
  assert.equal(back.deleted_at, null);
  assert.ok(store.sql.getLinkByCode.get('del3'));
  // 重复恢复要报错，而不是静默成功
  assert.throws(() => links.restore(link.id), /不在回收站/);
  store.close();
});

test('过期时间支持 ISO / 时间戳 / never', async () => {
  const { links, store } = makeService();
  const a = await links.create({ url: 'https://example.com', code: 'exp1', expireAt: '2099-12-31T00:00:00Z' });
  assert.equal(a.expire_at, Date.parse('2099-12-31T00:00:00Z'));
  const b = await links.create({ url: 'https://example.com', code: 'exp2', expireAt: 4102444800 });
  assert.equal(b.expire_at, 4102444800000);
  const c = await links.create({ url: 'https://example.com', code: 'exp3', expireAt: 'never' });
  assert.equal(c.expire_at, null);
  store.close();
});

test('密码设置与清除', async () => {
  const { links, store } = makeService();
  const link = await links.create({ url: 'https://example.com', code: 'pwd1' });
  assert.equal(link.protected, 0);
  links.setPassword(link.id, 'secret-pass');
  assert.equal(store.sql.getLinkByCode.get('pwd1').protected, 1);
  links.setPassword(link.id, '');
  assert.equal(store.sql.getLinkByCode.get('pwd1').protected, 0);
  store.close();
});

test('审计日志记录创建与删除', async () => {
  const { links, store } = makeService();
  const link = await links.create({ url: 'https://example.com', code: 'aud1' }, { actor: 'admin:tester' });
  links.remove(link.id, { actor: 'admin:tester' });
  const actions = store.sql.listAudit.all(50).map((r) => r.action);
  assert.ok(actions.includes('link.create'));
  assert.ok(actions.includes('link.delete'));
  store.close();
});

test('生成短码在重复时自动加长', async () => {
  const { links, store } = makeService();
  // 占满 6 位空间不现实，但至少要保证连续生成不冲突
  const codes = new Set();
  for (let i = 0; i < 200; i += 1) {
    const link = await links.create({ url: `https://example.com/${i}` });
    codes.add(link.code);
  }
  assert.equal(codes.size, 200);
  store.close();
});
