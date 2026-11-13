import test from 'node:test';
import assert from 'node:assert/strict';

import { ClickCounter } from '../src/services/counter.js';
import { makeStore, silentLogger } from './helpers.js';

function seedLink(store, code) {
  store.db.prepare("INSERT INTO links (code, url, created_at, updated_at) VALUES (?, 'https://example.com', 1, 1)").run(code);
}

test('hit 只写内存，flush 后落库', async () => {
  const { store, settings } = makeStore();
  seedLink(store, 'cnt1');
  const counter = new ClickCounter(store, settings, silentLogger);
  for (let i = 0; i < 5; i += 1) counter.hit('cnt1', { day: '2025-01-01', ref: 'google.com', platform: 'ios' });
  assert.equal(store.sql.getLinkByCode.get('cnt1').clicks, 0, '未 flush 前数据库不应变化');
  assert.equal(counter.stats().pendingClicks, 5);

  const flushed = await counter.flush();
  assert.equal(flushed, 5);
  assert.equal(store.sql.getLinkByCode.get('cnt1').clicks, 5);
  assert.equal(store.sql.linkDaily.all('cnt1', '2025-01-01')[0].clicks, 5);
  assert.equal(store.sql.linkRefs.all('cnt1', 10)[0].host, 'google.com');
  assert.equal(store.sql.linkAgents.all('cnt1', 10)[0].platform, 'ios');
  assert.equal(counter.stats().pendingClicks, 0);
  store.close();
});

test('多次 flush 累加而不是覆盖', async () => {
  const { store, settings } = makeStore();
  seedLink(store, 'cnt2');
  const counter = new ClickCounter(store, settings, silentLogger);
  counter.hit('cnt2', { day: '2025-01-01' });
  await counter.flush();
  counter.hit('cnt2', { day: '2025-01-01' });
  counter.hit('cnt2', { day: '2025-01-01' });
  await counter.flush();
  assert.equal(store.sql.getLinkByCode.get('cnt2').clicks, 3);
  assert.equal(store.sql.linkDaily.all('cnt2', '2025-01-01')[0].clicks, 3);
  store.close();
});

test('空缓冲 flush 返回 0 且不报错', async () => {
  const { store, settings } = makeStore();
  const counter = new ClickCounter(store, settings, silentLogger);
  assert.equal(await counter.flush(), 0);
  store.close();
});

test('last_click_at 记录最新一次点击时间', async () => {
  const { store, settings } = makeStore();
  seedLink(store, 'cnt3');
  const counter = new ClickCounter(store, settings, silentLogger);
  counter.hit('cnt3', { day: '2025-01-01' });
  await counter.flush();
  const link = store.sql.getLinkByCode.get('cnt3');
  assert.ok(link.last_click_at > 0);
  store.close();
});

test('同一批次内多短码分别累加', async () => {
  const { store, settings } = makeStore();
  seedLink(store, 'a1');
  seedLink(store, 'b2');
  const counter = new ClickCounter(store, settings, silentLogger);
  counter.hit('a1', { day: '2025-01-01' });
  counter.hit('a1', { day: '2025-01-01', platform: 'ios' });
  counter.hit('b2', { day: '2025-01-01' });
  assert.equal(await counter.flush(), 3);
  assert.equal(store.sql.getLinkByCode.get('a1').clicks, 2);
  assert.equal(store.sql.getLinkByCode.get('b2').clicks, 1);
  store.close();
});

test('落库失败时批次回流缓冲，不丢计数', async () => {
  const { store, settings } = makeStore();
  seedLink(store, 'fail1');
  const counter = new ClickCounter(store, settings, silentLogger);
  counter.hit('fail1', { day: '2025-01-01' });
  counter.hit('fail1', { day: '2025-01-01' });

  const original = store.tx.bind(store);
  store.tx = () => {
    throw new Error('磁盘满了');
  };
  await assert.rejects(() => counter.flush(), /磁盘满了/);
  assert.equal(counter.stats().pendingClicks, 2);
  assert.equal(counter.stats().bufferedKeys, 1);

  store.tx = original;
  assert.equal(await counter.flush(), 2);
  assert.equal(store.sql.getLinkByCode.get('fail1').clicks, 2);
  store.close();
});

test('start / stop 管理定时器', async () => {
  const { store, settings } = makeStore();
  seedLink(store, 'timer1');
  settings.update({ countFlushMs: 100 });
  const counter = new ClickCounter(store, settings, silentLogger).start();
  counter.hit('timer1', { day: '2025-01-01' });
  await new Promise((r) => setTimeout(r, 260));
  assert.equal(store.sql.getLinkByCode.get('timer1').clicks, 1);
  counter.stop();
  counter.hit('timer1', { day: '2025-01-01' });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(store.sql.getLinkByCode.get('timer1').clicks, 1, 'stop 后不再自动 flush');
  store.close();
});
