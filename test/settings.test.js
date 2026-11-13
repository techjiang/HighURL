import test from 'node:test';
import assert from 'node:assert/strict';

import { makeStore } from './helpers.js';
import { DEFAULTS } from '../src/config.js';

test('默认值来自 config.js，port 来自运行配置', () => {
  const { settings, config, store } = makeStore();
  assert.equal(settings.get('codeLength'), DEFAULTS.codeLength);
  assert.equal(settings.get('port'), config.port);
  store.close();
});

test('update 写入白名单项并持久化', () => {
  const { store, settings } = makeStore();
  const { applied, rejected } = settings.update({ siteName: '新名字', redirectStatus: 301 });
  assert.deepEqual(applied, { siteName: '新名字', redirectStatus: 301 });
  assert.deepEqual(rejected, []);
  assert.equal(settings.get('siteName'), '新名字');
  assert.equal(store.sql.getSetting.get('siteName').value, '新名字');
  store.close();
});

test('未知设置项被拒绝', () => {
  const { store, settings } = makeStore();
  const { rejected } = settings.update({ evil: 'x', port: 9999 });
  assert.deepEqual(rejected.sort(), ['evil', 'port']);
  assert.equal(settings.get('siteName'), DEFAULTS.siteName);
  store.close();
});

test('非法值被拒绝且不落库', () => {
  const { store, settings } = makeStore();
  const before = settings.get('redirectStatus');
  settings.update({ redirectStatus: 999 });
  assert.equal(settings.get('redirectStatus'), before);
  settings.update({ codeLength: 2 });
  assert.equal(settings.get('codeLength'), DEFAULTS.codeLength);
  settings.update({ titleTimeout: 100 });
  assert.equal(settings.get('titleTimeout'), DEFAULTS.titleTimeout);
  store.close();
});

test('布尔项接受多种表示', () => {
  const { store, settings } = makeStore();
  settings.update({ publicCreate: true });
  assert.equal(settings.get('publicCreate'), true);
  settings.update({ publicCreate: 'false' });
  assert.equal(settings.get('publicCreate'), false);
  settings.update({ blockBots: 'on' });
  assert.equal(settings.get('blockBots'), true);
  store.close();
});

test('baseUrl 规范化：去尾斜杠并校验协议', () => {
  const { store, settings } = makeStore();
  settings.update({ baseUrl: 'https://s.example.com/' });
  assert.equal(settings.get('baseUrl'), 'https://s.example.com');
  settings.update({ baseUrl: 'ftp://s.example.com' });
  assert.equal(settings.get('baseUrl'), 'https://s.example.com', '非法协议应被忽略');
  settings.update({ baseUrl: '' });
  assert.equal(settings.get('baseUrl'), '');
  store.close();
});

test('reservedSet 小写归一', () => {
  const { store, settings } = makeStore();
  settings.update({ reservedCodes: 'API, Admin ,custom' });
  const set = settings.reservedSet();
  assert.ok(set.has('api'));
  assert.ok(set.has('admin'));
  assert.ok(set.has('custom'));
  assert.equal(set.has('API'), false);
  store.close();
});

test('reload 会重新读取数据库', () => {
  const { store, settings } = makeStore();
  store.sql.setSetting.run('siteName', '外部改了');
  settings.reload();
  assert.equal(settings.get('siteName'), '外部改了');
  store.close();
});

test('过长文本被截断到 120 字', () => {
  const { store, settings } = makeStore();
  settings.update({ siteDescription: 'x'.repeat(300) });
  assert.equal(settings.get('siteDescription').length, 120);
  store.close();
});

test('数型设置接受字符串数字', () => {
  const { store, settings } = makeStore();
  settings.update({ codeLength: '10' });
  assert.equal(settings.get('codeLength'), 10);
  store.close();
});
