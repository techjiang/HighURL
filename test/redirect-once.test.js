import test from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer } from './helpers.js';

/**
 * 跳转路径必须严格「一次响应」。
 *
 * 曾经的 bug：`handleRedirect` 结尾写的是 `return redirect(...)`，
 * 而 `redirect()` 返回 undefined —— 外层把它当作「没处理」，接着走 404 分支，
 * 对着已经 end 掉的 response 再 writeHead 一次。客户端拿到的仍是 302（先发的赢），
 * 但每次正常跳转都会在日志里留下一条假的 500 ERR_HTTP_HEADERS_SENT，
 * `/metrics` 的 errors 也跟着涨，等于给监控埋了一颗长期的假警报。
 */
async function boot() {
  const errors = [];
  const srv = await startTestServer({
    logger: {
      debug() {},
      info() {},
      warn() {},
      error: (...args) => errors.push(args.map(String).join(' ')),
    },
  });
  return { srv, errors };
}

test('成功跳转只响应一次，不写重复响应头', async () => {
  const { srv, errors } = await boot();
  try {
    await srv.ctx.links.create({ url: 'https://example.com/a', code: 'once' });
    const res = await srv.fetch('/once');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://example.com/a');
    // 等一拍：错误是在响应写完之后才可能被 catch 到的
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(errors, [], `跳转不该报错，实际：${errors.join(' | ')}`);
  } finally {
    await srv.stop();
  }
});

test('带子路径透传的跳转同样只响应一次', async () => {
  const { srv, errors } = await boot();
  try {
    await srv.ctx.links.create({ url: 'https://example.com/base', code: 'sub' });
    const res = await srv.fetch('/sub/docs?x=1');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://example.com/base/docs?x=1');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(errors, []);
  } finally {
    await srv.stop();
  }
});

test('不存在的短码仍然 404，不被跳转吞掉', async () => {
  const { srv, errors } = await boot();
  try {
    const res = await srv.fetch('/nothing-here');
    assert.equal(res.status, 404);
    const html = await res.text();
    assert.match(html, /404|找不到/);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(errors, []);
  } finally {
    await srv.stop();
  }
});

test('停用与过期短链分别返回 404 / 410', async () => {
  const { srv, errors } = await boot();
  try {
    const off = await srv.ctx.links.create({ url: 'https://example.com/off', code: 'off' });
    await srv.ctx.links.update(off.id, { status: 'disabled' });
    assert.equal((await srv.fetch('/off')).status, 404);

    await srv.ctx.links.create({
      url: 'https://example.com/old',
      code: 'old',
      expireAt: Date.now() - 86400000,
    });
    assert.equal((await srv.fetch('/old')).status, 410);

    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(errors, []);
  } finally {
    await srv.stop();
  }
});

test('HEAD 探活不算一次点击', async () => {
  const { srv } = await boot();
  try {
    await srv.ctx.links.create({ url: 'https://example.com/head', code: 'hd' });
    const head = await srv.fetch('/hd', { method: 'HEAD' });
    assert.equal(head.status, 302);
    await srv.ctx.counter.flush();
    assert.equal(srv.ctx.store.findLinkByCode('hd').clicks, 0);

    const get = await srv.fetch('/hd');
    assert.equal(get.status, 302);
    await srv.ctx.counter.flush();
    assert.equal(srv.ctx.store.findLinkByCode('hd').clicks, 1);
  } finally {
    await srv.stop();
  }
});

test('PUT / DELETE / OPTIONS 打到短码上不跳转', async () => {
  const { srv } = await boot();
  try {
    await srv.ctx.links.create({ url: 'https://example.com/m', code: 'm1' });
    for (const method of ['PUT', 'DELETE', 'OPTIONS']) {
      const res = await srv.fetch('/m1', { method });
      assert.equal(res.status, 404, `${method} /m1 应该是 404`);
      assert.equal(res.headers.get('location'), null);
    }
    await srv.ctx.counter.flush();
    assert.equal(srv.ctx.store.findLinkByCode('m1').clicks, 0);
  } finally {
    await srv.stop();
  }
});
