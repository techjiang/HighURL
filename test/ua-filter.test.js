import test from 'node:test';
import assert from 'node:assert/strict';

import { UaFilter, compileRule } from '../src/services/ua-filter.js';
import { makeStore } from './helpers.js';

function makeFilter() {
  const { store, settings } = makeStore();
  return { store, settings, filter: new UaFilter(store, settings) };
}

test('关键字规则大小写不敏感', () => {
  const re = compileRule('semrush');
  assert.ok(re.test('Mozilla/5.0 (compatible; SemrushBot/7)'));
  assert.ok(re.test('SEMRUSH-BOT'));
  assert.equal(re.test('Mozilla/5.0 Chrome/120'), false);
});

test('特殊字符按字面量处理，不当正则元字符', () => {
  const re = compileRule('a.b(c)');
  assert.ok(re.test('xx a.b(c) yy'));
  assert.equal(re.test('aXb(c)'), false);
});

test('通配符 * 匹配任意内容', () => {
  const re = compileRule('Headless*Chrome');
  assert.ok(re.test('Headless Chrome/120'));
  assert.ok(re.test('headless-anything-chrome'));
  assert.equal(re.test('Headless Firefox'), false);
});

test('/regex/flags 形式按正则编译', () => {
  const re = compileRule('/python-requests\\/\\d+/i');
  assert.ok(re.test('python-requests/2.31.0'));
  assert.equal(re.test('curl/8'), false);
});

test('超长输入被截断，避免 ReDoS', () => {
  const re = compileRule('(a+)+b');
  const long = `${'a'.repeat(100000)}c`;
  const started = Date.now();
  re.test(long);
  assert.ok(Date.now() - started < 1000, '不应因恶意 UA 卡死');
});

test('空规则抛错', () => {
  assert.throws(() => compileRule(''), /规则为空/);
  assert.throws(() => compileRule('   '), /规则为空/);
});

test('UaFilter 只在启用规则上匹配', () => {
  const { store, filter, settings } = makeFilter();
  store.sql.insertRule.run('ua', 'EvilBot', '恶意爬虫', 1, Date.now());
  store.sql.insertRule.run('ua', 'DisabledBot', '停用规则', 0, Date.now());
  filter.reload();

  assert.equal(filter.match({ ua: 'EvilBot/1.0' }).kind, 'ua');
  assert.equal(filter.match({ ua: 'DisabledBot/1.0' }), null);
  assert.equal(filter.match({ ua: 'Mozilla/5.0' }), null);
  store.close();
});

test('IP 规则先于 UA 规则匹配', () => {
  const { store, filter } = makeFilter();
  store.sql.insertRule.run('ua', 'Chrome', '', 1, Date.now());
  store.sql.insertRule.run('ip', '/^203\\.0\\.113\\./', '封禁段', 1, Date.now());
  filter.reload();

  const hit = filter.match({ ua: 'Chrome/120', ip: '203.0.113.9' });
  assert.equal(hit.kind, 'ip');
  assert.equal(filter.match({ ua: 'Firefox', ip: '198.51.100.1' }), null);
  store.close();
});

test('无效正则在 reload 时被跳过并记录', () => {
  const { store, filter } = makeFilter();
  store.sql.insertRule.run('ua', '/(unclosed/', '坏正则', 1, Date.now());
  store.sql.insertRule.run('ua', 'GoodBot', '', 1, Date.now());
  filter.reload();
  assert.equal(filter.skipped.length, 1);
  assert.equal(filter.skipped[0].pattern, '/(unclosed/');
  assert.ok(filter.match({ ua: 'GoodBot/1' }));
  store.close();
});

test('命中次数累积并在 flushHits 后落库', () => {
  const { store, filter } = makeFilter();
  store.sql.insertRule.run('ua', 'EvilBot', '', 1, Date.now());
  filter.reload();
  filter.match({ ua: 'EvilBot/1' });
  filter.match({ ua: 'EvilBot/2' });
  assert.equal(store.sql.listRules.all()[0].hits, 0);
  filter.flushHits();
  assert.equal(store.sql.listRules.all()[0].hits, 2);
  store.close();
});

test('IP 通配符规则可用', () => {
  const { store, filter } = makeFilter();
  store.sql.insertRule.run('ip', '10.0.0.*', '', 1, Date.now());
  filter.reload();
  assert.ok(filter.match({ ua: '', ip: '10.0.0.7' }));
  assert.equal(filter.match({ ua: '', ip: '10.0.1.7' }), null);
  store.close();
});
