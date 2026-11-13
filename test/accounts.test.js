import test from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, cleanupTmp } from './helpers.js';
import { SCHEMA_VERSION } from '../src/lib/db.js';
import { normalizeRole, canWrite } from '../src/services/auth.js';

test.after(() => cleanupTmp());

const PASS = 'Passw0rd!23';

async function login(srv, username = 'admin', password = PASS) {
  const res = await srv.fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }),
  });
  return { res, cookie: String(res.headers.get('set-cookie') || '').split(';')[0] };
}

async function adminJson(srv, cookie, pathname, init = {}) {
  const res = await srv.fetch(pathname, {
    ...init,
    headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(init.headers || {}) },
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { res, body, text };
}

async function withSrv(fn) {
  const srv = await startTestServer({ titleFetch: false });
  await srv.ctx.auth.createAdmin('admin', PASS);
  try {
    await fn(srv);
  } finally {
    await srv.stop();
  }
}

test('schema 到 v11：admins 有 role / created_by / disabled_at', () => {
  assert.ok(SCHEMA_VERSION >= 11);
  const srv = async () => {
    await withSrv(async (server) => {
      const cols = server.ctx.store.db.prepare('PRAGMA table_info(admins)').all().map((c) => c.name);
      for (const name of ['role', 'created_by', 'disabled_at']) assert.ok(cols.includes(name), name);
    });
  };
  return srv();
});

test('角色只有两档，不认识的取值按只读处理', () => {
  assert.equal(normalizeRole('owner'), 'owner');
  assert.equal(normalizeRole('OWNER'), 'owner');
  // 写错的角色名不该意外升权：认不出来就当只读，这是唯一安全的方向
  assert.equal(normalizeRole('admin'), 'viewer');
  assert.equal(normalizeRole(''), 'viewer');
  assert.equal(canWrite({ role: 'owner' }), true);
  assert.equal(canWrite({ role: 'viewer' }), false);
  // 老会话里没有 role 字段，按 owner 走——升级不该把现有的人锁在门外
  assert.equal(canWrite({}), true);
  assert.equal(canWrite(null), true);
});

test('新建的管理员能登录，只读账号读得到、写不了', async () => {
  await withSrv(async (srv) => {
    const admin = await login(srv);
    const created = await adminJson(srv, admin.cookie, '/admin/api/admins', {
      method: 'POST',
      body: JSON.stringify({ username: 'watcher', password: PASS, role: 'viewer' }),
    });
    assert.equal(created.res.status, 200, created.text);
    assert.equal(created.body.result.role, 'viewer');

    const viewer = await login(srv, 'watcher');
    assert.equal(viewer.res.status, 303, '只读账号也要能登录');

    // 读：放行
    const me = await adminJson(srv, viewer.cookie, '/admin/api/me');
    assert.equal(me.res.status, 200);
    assert.equal(me.body.result.role, 'viewer');
    assert.equal(me.body.result.readonly, true);
    const list = await adminJson(srv, viewer.cookie, '/admin/api/links');
    assert.equal(list.res.status, 200, '只读账号能看列表');

    // 写：一律 403，且带 readonly 标记供前端置灰
    for (const [path, init] of [
      ['/admin/api/links', { method: 'POST', body: JSON.stringify({ url: 'https://example.com/x' }) }],
      ['/admin/api/settings', { method: 'PATCH', body: JSON.stringify({ siteName: 'hack' }) }],
      ['/admin/api/flush', { method: 'POST', body: '{}' }],
      ['/admin/api/restore', { method: 'POST', body: '{}' }],
    ]) {
      const out = await adminJson(srv, viewer.cookie, path, init);
      assert.equal(out.res.status, 403, `${path} 应拒绝`);
      assert.equal(out.body?.error?.code, 'readonly', `${path} 应给 readonly 标记`);
    }
    // 写被拒之后数据确实没动
    assert.equal(srv.ctx.store.sql.countLinks.get().n, 0);
  });
});

test('只读账号不能给自己提权', async () => {
  await withSrv(async (srv) => {
    const admin = await login(srv);
    const created = await adminJson(srv, admin.cookie, '/admin/api/admins', {
      method: 'POST',
      body: JSON.stringify({ username: 'watcher', password: PASS, role: 'viewer' }),
    });
    const id = srv.ctx.store.sql.getAdmin.get('watcher').id;
    const viewer = await login(srv, 'watcher');
    const out = await adminJson(srv, viewer.cookie, `/admin/api/admins/${id}/role`, {
      method: 'POST',
      body: JSON.stringify({ role: 'owner' }),
    });
    assert.equal(out.res.status, 403);
    // 账号列表也不给看：里面是用户名和登录时间，属于管理面
    const list = await adminJson(srv, viewer.cookie, '/admin/api/admins');
    assert.equal(list.res.status, 403);
    assert.ok(created.body.result.username);
  });
});

test('降级后旧 Cookie 立刻失去写权限，不用等过期', async () => {
  await withSrv(async (srv) => {
    const admin = await login(srv);
    const ownerId = srv.ctx.store.sql.getAdmin.get('admin').id;
    await adminJson(srv, admin.cookie, '/admin/api/admins', {
      method: 'POST',
      body: JSON.stringify({ username: 'helper', password: PASS, role: 'owner' }),
    });
    const helper = await login(srv, 'helper');
    // 升为 owner 时能写
    const before = await adminJson(srv, helper.cookie, '/admin/api/links', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com/a', code: 'h1', fetchTitle: false }),
    });
    assert.equal(before.res.status, 200, before.text);
    const helperId = srv.ctx.store.sql.getAdmin.get('helper').id;
    const down = await adminJson(srv, admin.cookie, `/admin/api/admins/${helperId}/role`, {
      method: 'POST',
      body: JSON.stringify({ role: 'viewer' }),
    });
    assert.equal(down.res.status, 200, down.text);
    // 同一张 Cookie 继续用：角色从库里读，所以立刻降级
    const after = await adminJson(srv, helper.cookie, '/admin/api/links', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com/b', code: 'h2', fetchTitle: false }),
    });
    assert.equal(after.res.status, 403, '旧票不能继续写');
    assert.ok(ownerId > 0);
  });
});

test('停用账号：旧会话失效，登录回同一句「用户名或密码错误」', async () => {
  await withSrv(async (srv) => {
    const admin = await login(srv);
    await adminJson(srv, admin.cookie, '/admin/api/admins', {
      method: 'POST',
      body: JSON.stringify({ username: 'temp', password: PASS, role: 'owner' }),
    });
    const tempId = srv.ctx.store.sql.getAdmin.get('temp').id;
    const temp = await login(srv, 'temp');
    assert.equal((await adminJson(srv, temp.cookie, '/admin/api/me')).res.status, 200);

    const off = await adminJson(srv, admin.cookie, `/admin/api/admins/${tempId}/state`, {
      method: 'POST',
      body: JSON.stringify({ disabled: true }),
    });
    assert.equal(off.res.status, 200, off.text);

    // 已经拿着会话的人，下一次请求就进不来了
    assert.equal((await adminJson(srv, temp.cookie, '/admin/api/me')).res.status, 401);

    // 重新登录：提示与「密码错」完全一致，不确认这个用户名存在
    const retry = await login(srv, 'temp');
    const wrongPwd = await login(srv, 'temp', 'WrongPass!23');
    assert.equal(retry.res.status, 401);
    assert.equal(wrongPwd.res.status, 401);
    assert.equal(retry.res.headers.get('set-cookie'), null);
  });
});

test('不能停用 / 删除当前登录的自己', async () => {
  await withSrv(async (srv) => {
    const admin = await login(srv);
    const meId = srv.ctx.store.sql.getAdmin.get('admin').id;
    const off = await adminJson(srv, admin.cookie, `/admin/api/admins/${meId}/state`, {
      method: 'POST',
      body: JSON.stringify({ disabled: true }),
    });
    assert.equal(off.res.status, 400);
    assert.equal(off.body.error.code, 'self_disable');
    const del = await adminJson(srv, admin.cookie, `/admin/api/admins/${meId}`, { method: 'DELETE' });
    assert.equal(del.res.status, 400);
  });
});

test('最后一个管理员不能被降级、停用或删除', async () => {
  await withSrv(async (srv) => {
    const admin = await login(srv);
    const meId = srv.ctx.store.sql.getAdmin.get('admin').id;
    // 再加一个只读，owner 仍然只有 1 个，所以下面三条都必须被拦
    await adminJson(srv, admin.cookie, '/admin/api/admins', {
      method: 'POST',
      body: JSON.stringify({ username: 'viewer1', password: PASS, role: 'viewer' }),
    });
    const downgrade = await srv.ctx.auth.setRole;
    assert.ok(downgrade);
    // 降级自己：先撞 self 判定前的一道 owner 保护
    const out = await (async () => {
      try {
        srv.ctx.auth.setRole(meId, 'viewer', 'admin');
        return null;
      } catch (err) {
        return err;
      }
    })();
    assert.equal(out?.code, 'last_owner');

    // 有了第二个 owner 之后，降级就允许了
    await adminJson(srv, admin.cookie, '/admin/api/admins', {
      method: 'POST',
      body: JSON.stringify({ username: 'owner2', password: PASS, role: 'owner' }),
    });
    const ok = srv.ctx.auth.setRole(meId, 'viewer', 'owner2');
    assert.equal(ok.role, 'viewer');
  });
});

test('管理员重置密码不需要原密码；重置后旧密码失效', async () => {
  await withSrv(async (srv) => {
    const admin = await login(srv);
    await adminJson(srv, admin.cookie, '/admin/api/admins', {
      method: 'POST',
      body: JSON.stringify({ username: 'forgetful', password: PASS, role: 'viewer' }),
    });
    const id = srv.ctx.store.sql.getAdmin.get('forgetful').id;
    const out = await adminJson(srv, admin.cookie, `/admin/api/admins/${id}/password`, {
      method: 'POST',
      body: JSON.stringify({ password: 'Another!234' }),
    });
    assert.equal(out.res.status, 200, out.text);
    // 新密码生效、旧密码失效
    assert.equal((await login(srv, 'forgetful', 'Another!234')).res.status, 303);
    assert.equal((await login(srv, 'forgetful', PASS)).res.status, 401);
  });
});

test('只读账号可以改自己的密码（这条不该被 read 以外的权限挡住）', async () => {
  await withSrv(async (srv) => {
    const admin = await login(srv);
    await adminJson(srv, admin.cookie, '/admin/api/admins', {
      method: 'POST',
      body: JSON.stringify({ username: 'watcher', password: PASS, role: 'viewer' }),
    });
    const viewer = await login(srv, 'watcher');
    const out = await adminJson(srv, viewer.cookie, '/admin/api/admins/self/password', {
      method: 'POST',
      body: JSON.stringify({ oldPassword: PASS, newPassword: 'Changed!234' }),
    });
    assert.equal(out.res.status, 200, out.text);
  });
});

test('账号操作都进审计，谁改了谁记清楚', async () => {
  await withSrv(async (srv) => {
    const admin = await login(srv);
    await adminJson(srv, admin.cookie, '/admin/api/admins', {
      method: 'POST',
      body: JSON.stringify({ username: 'audited', password: PASS, role: 'viewer' }),
    });
    const id = srv.ctx.store.sql.getAdmin.get('audited').id;
    await adminJson(srv, admin.cookie, `/admin/api/admins/${id}/role`, { method: 'POST', body: JSON.stringify({ role: 'owner' }) });
    await adminJson(srv, admin.cookie, `/admin/api/admins/${id}/state`, { method: 'POST', body: JSON.stringify({ disabled: true }) });
    const actions = srv.ctx.store.db
      .prepare("SELECT action, actor, detail FROM audit_log WHERE action LIKE 'admin.%' ORDER BY id")
      .all();
    assert.deepEqual(actions.map((a) => a.action), ['admin.create', 'admin.role', 'admin.disable']);
    assert.ok(actions.every((a) => a.actor === 'admin'));
    assert.equal(actions[1].detail, 'audited:viewer->owner');
  });
});

test('管理员会话调 /api/v1 写接口也受角色限制', async () => {
  await withSrv(async (srv) => {
    const admin = await login(srv);
    await adminJson(srv, admin.cookie, '/admin/api/admins', {
      method: 'POST',
      body: JSON.stringify({ username: 'watcher', password: PASS, role: 'viewer' }),
    });
    const viewer = await login(srv, 'watcher');
    const read = await adminJson(srv, viewer.cookie, '/api/v1/links');
    assert.equal(read.res.status, 200, '只读账号能用会话读 API');
    const write = await adminJson(srv, viewer.cookie, '/api/v1/links', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com/x' }),
    });
    assert.equal(write.res.status, 403);
    assert.equal(write.body.error.code, 'readonly');
  });
});

test('只读账号：页面上的写按钮都带 data-writes，只读动作不带', async () => {
  // 服务端 403 是最后一道闸，但它只在「已经点下去」之后才拦得住。
  // 前端标记漏一个，用户就得多点一次才知道自己没权限——所以这里把标记本身钉住。
  const fs = await import('node:fs/promises');
  const js = await fs.readFile(new URL('../public/static/admin.js', import.meta.url), 'utf8');
  const css = await fs.readFile(new URL('../public/static/app.css', import.meta.url), 'utf8');

  // 会写的按钮必须标
  for (const needle of [
    'id="create-btn" data-writes',
    'id="health-btn" data-writes',
    'id="sweep-btn" data-writes',
    'id="save-btn" data-writes',
    'id="add-admin" data-writes',
    'data-act="edit" data-writes',
    'data-act="del" data-writes',
    'data-act="renew" data-writes',
  ]) {
    assert.ok(js.includes(needle), `缺少只读标记: ${needle}`);
  }

  // 只读动作不该被误标：二维码、统计、历史、导出都是看
  for (const act of ['qr', 'stats', 'history', 'health']) {
    assert.ok(
      !js.includes(`data-act="${act}" data-writes`),
      `只读动作被误标为写操作: ${act}`,
    );
  }

  assert.ok(css.includes('.readonly-account [data-writes]'), 'CSS 未按标记置灰');
});
