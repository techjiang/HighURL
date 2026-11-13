import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server.js';
import { openDatabase } from '../src/lib/db.js';
import { Settings } from '../src/services/settings.js';
import { loadConfig } from '../src/config.js';

const TMP_ROOTS = [];

export function tmpDir(prefix = 'highurl-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP_ROOTS.push(dir);
  return dir;
}

export function cleanupTmp() {
  while (TMP_ROOTS.length) {
    const dir = TMP_ROOTS.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** 建一个独立的内存/临时库 + Settings */
export function makeStore(overrides = {}) {
  const dir = tmpDir();
  const config = { ...loadConfig({ dataDir: dir }), ...overrides };
  const store = openDatabase(path.join(dir, 'test.db'));
  const settings = new Settings(store, config);
  return { store, settings, config, dir };
}

export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** 起一个真实 HTTP 服务，返回 baseUrl 与关闭函数 */
export async function startTestServer(overrides = {}) {
  const dir = overrides.dataDir || tmpDir();
  const server = await createServer({ dataDir: dir, port: 0, logger: silentLogger, ...overrides });
  // 测试里不抓标题，避免依赖外网与超时拖慢用例
  if (overrides.titleFetch === undefined) server.ctx.settings.update({ titleFetch: false });
  await new Promise((resolve) => server.server.listen(0, '127.0.0.1', resolve));
  const { port } = server.server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    ...server,
    base,
    dir,
    async stop() {
      await server.close();
    },
    fetch: (pathname, init = {}) => fetch(`${base}${pathname}`, { redirect: 'manual', ...init }),
    async json(pathname, init = {}) {
      const res = await fetch(`${base}${pathname}`, {
        redirect: 'manual',
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
      });
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { res, body };
    },
  };
}
