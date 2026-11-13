#!/usr/bin/env node
/**
 * HighURL 本地压测：直连跳转热路径，测 QPS 与延迟分位。
 *
 *   node scripts/bench.js [--links 200] [--conns 50] [--duration 10] [--port 18099] [--targets 3]
 *
 * 会在临时数据目录建一个独立实例，压完自动清理。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server.js';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? Number(args[idx + 1]) : fallback;
};

const LINK_COUNT = arg('links', 200);
const CONNS = arg('conns', 50);
const DURATION = arg('duration', 10);
const PORT = arg('port', 18099);
const FLUSH_MS = arg('flush', 1000);
// 每条短链挂几个分流目标：用来验证「开了 A/B 之后热路径掉多少」
const TARGETS = arg('targets', 0);

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'highurl-bench-'));
  const app = await createServer({ dataDir, port: PORT, host: '127.0.0.1', logger: silent });
  app.ctx.settings.update({ titleFetch: false, rateLimitPerMinute: 1000000, countFlushMs: FLUSH_MS });
  app.ctx.limiter.max = 1000000;

  const codes = [];
  const ts = Date.now();
  app.ctx.store.tx(() => {
    const stmt = app.ctx.store.db.prepare(
      "INSERT INTO links (code, url, status, clicks, created_at, updated_at) VALUES (?, ?, 'active', 0, ?, ?)",
    );
    for (let i = 0; i < LINK_COUNT; i += 1) {
      const code = `b${i.toString(36)}`;
      stmt.run(code, `https://example.com/target/${i}`, ts, ts);
      codes.push(code);
    }
  });

  if (TARGETS > 0) {
    const ids = app.ctx.store.db.prepare('SELECT id FROM links').all().map((r) => r.id);
    app.ctx.store.tx(() => {
      const stmt = app.ctx.store.db.prepare(
        "INSERT INTO link_targets (link_id, url, label, weight, regions, enabled, clicks, created_at) VALUES (?, ?, '', 100, ?, 1, 0, ?)",
      );
      for (const id of ids) {
        for (let t = 0; t < TARGETS; t += 1) {
          // 末尾那条什么都不填（全球目标），其余按地区分，模拟真实配置
          stmt.run(id, `https://example.com/variant/${t}`, t === TARGETS - 1 ? '' : 'CN', ts);
        }
      }
    });
  }

  await new Promise((resolve) => app.server.listen(PORT, '127.0.0.1', resolve));

  const agent = new http.Agent({ keepAlive: true, maxSockets: CONNS });
  const latencies = [];
  let ok = 0;
  let failed = 0;
  let inflight = 0;
  let stopAt = 0;

  const cpuStart = process.cpuUsage();
  const memStart = process.memoryUsage().rss;
  const started = Date.now();
  stopAt = started + DURATION * 1000;

  await new Promise((resolve) => {
    const fire = () => {
      if (Date.now() >= stopAt && inflight === 0) return resolve();
      if (Date.now() >= stopAt) return undefined;
      inflight += 1;
      const code = codes[Math.floor(Math.random() * codes.length)];
      const t0 = process.hrtime.bigint();
      const req = http.request(
        { host: '127.0.0.1', port: PORT, path: `/${code}`, agent, headers: { 'User-Agent': 'bench/1.0 (Mozilla)' } },
        (res) => {
          res.resume();
          res.on('end', () => {
            const ms = Number(process.hrtime.bigint() - t0) / 1e6;
            latencies.push(ms);
            if (res.statusCode === 302) ok += 1;
            else failed += 1;
            inflight -= 1;
            fire();
          });
        },
      );
      req.on('error', () => {
        failed += 1;
        inflight -= 1;
        fire();
      });
      req.end();
      return undefined;
    };
    for (let i = 0; i < CONNS; i += 1) fire();
  });

  const elapsed = (Date.now() - started) / 1000;
  await app.ctx.counter.flush();
  const cpu = process.cpuUsage(cpuStart);
  const cpuSec = (cpu.user + cpu.system) / 1e6;
  const rssMb = (process.memoryUsage().rss - memStart) / 1048576;

  latencies.sort((a, b) => a - b);
  const total = ok + failed;
  const qps = total / elapsed;
  const storedClicks = app.ctx.store.sql.sumClicks.get().n;

  const lines = [
    '',
    '  HighURL 跳转压测',
    `  短链 ${LINK_COUNT} 条 · 并发 ${CONNS} · 时长 ${elapsed.toFixed(1)}s · 缓存命中率 ${(app.ctx.cache.stats().hitRate * 100).toFixed(1)}%${TARGETS ? ` · 每条 ${TARGETS} 个分流目标` : ''}`,
    '',
    `  QPS          ${Math.round(qps).toLocaleString()}`,
    `  请求总数      ${total.toLocaleString()}（成功 ${ok.toLocaleString()} / 失败 ${failed}）`,
    `  延迟 avg     ${(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2)} ms`,
    `  延迟 p50     ${pct(latencies, 50).toFixed(2)} ms`,
    `  延迟 p95     ${pct(latencies, 95).toFixed(2)} ms`,
    `  延迟 p99     ${pct(latencies, 99).toFixed(2)} ms`,
    `  落库点击      ${storedClicks.toLocaleString()}`,
    `  CPU ${(cpuSec / elapsed * 100).toFixed(0)}% · 内存 +${rssMb.toFixed(1)} MB · ${os.cpus().length} 核 ${(os.totalmem() / 1e9).toFixed(0)} GB`,
    '',
  ];
  console.log(lines.join('\n'));

  agent.destroy();
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
