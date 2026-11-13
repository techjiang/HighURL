import http from 'node:http';
import https from 'node:https';

import { assertPublicHost } from './titles.js';
import { truncate } from '../lib/util.js';

/**
 * 目标链接健康巡检。
 *
 * 短链的寿命往往比目标链接长：站点改版、换域名、页面下线，短链还印在物料上，
 * 点过去却是 404。这件事自己不会暴露出来——点击数变零也能解释成「没人点」。
 *
 * 所以定期主动去敲一下目标地址，把结论落到 links 上。
 *
 * 几条取舍：
 * - 只请求首字节就断开。我们要的只是状态码，不是内容；下载整页会让巡检变成带宽黑洞。
 * - 一次 404 不算死。CDN 抖动、临时 502、限流都会发生，连续失败达到阈值才判定。
 * - 每个跳转都重新做 SSRF 校验。目标地址可能 302 到 127.0.0.1，只校验第一跳等于没校验。
 * - 巡检结果不写 updated_at：检查过和改过是两件事。
 */

const MAX_HOPS = 5;
const UA = 'Mozilla/5.0 (compatible; HighURL-Health/1.0; +https://github.com/highurl)';

/** 一次探测：返回最终状态码、耗时与判定 */
export async function probeUrl(target, { timeout = 8000, hops = MAX_HOPS } = {}) {
  const started = Date.now();
  let url = String(target);
  for (let hop = 0; hop < hops; hop += 1) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, status: 0, ms: Date.now() - started, error: '链接格式非法' };
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      return { ok: false, status: 0, ms: Date.now() - started, error: '只支持 http(s)' };
    }
    try {
      await assertPublicHost(parsed.hostname);
    } catch (err) {
      return { ok: false, status: 0, ms: Date.now() - started, error: err.message || '目标地址不可访问' };
    }

    let res;
    try {
      res = await head(parsed.href, timeout);
    } catch (err) {
      const reason = err?.code === 'ETIMEDOUT' || /timed? ?out/i.test(err?.message || '')
        ? '连接超时'
        : friendlyError(err);
      return { ok: false, status: 0, ms: Date.now() - started, error: reason };
    }

    const location = res.headers.location;
    if (res.status >= 300 && res.status < 400 && location) {
      try {
        url = new URL(location, parsed.href).href;
      } catch {
        return { ok: false, status: res.status, ms: Date.now() - started, error: '跳转地址非法' };
      }
      continue;
    }
    return {
      ok: res.status < 400,
      status: res.status,
      ms: Date.now() - started,
      error: res.status >= 400 ? `HTTP ${res.status}` : '',
    };
  }
  return { ok: false, status: 0, ms: Date.now() - started, error: `跳转超过 ${hops} 次` };
}

function friendlyError(err) {
  const code = err?.code || '';
  const map = {
    ENOTFOUND: '域名解析失败',
    ECONNREFUSED: '连接被拒绝',
    ECONNRESET: '连接被重置',
    EHOSTUNREACH: '主机不可达',
    ENETUNREACH: '网络不可达',
    CERT_HAS_EXPIRED: '证书已过期',
    DEPTH_ZERO_SELF_SIGNED_CERT: '证书不受信任',
    ERR_TLS_CERT_ALTNAME_INVALID: '证书域名不匹配',
  };
  if (map[code]) return map[code];
  return truncate(err?.message || '请求失败', 120);
}

/**
 * 发一次 GET，拿到响应头就把连接断掉。
 * 不用 HEAD：不少站点对 HEAD 返回 405 或直接挂住，检查结果会变成误报。
 */
function head(url, timeout) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.request(
      url,
      {
        method: 'GET',
        timeout,
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
          // 只要第一段就够了，省掉整页下载
          Range: 'bytes=0-0',
        },
      },
      (res) => {
        res.resume();
        req.destroy();
        resolve({ status: res.statusCode || 0, headers: res.headers });
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('连接超时'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

/** 通知里给人点得动的完整短链地址 */
function shortUrlOf(settings, code) {
  const base = String(settings.get('baseUrl') || '').replace(/\/+$/, '');
  return base ? `${base}/${code}` : `/${code}`;
}

/** 判定：连续失败达到阈值才算死链，别把一次抖动写成故障 */
export function classify(result, previousMiss, threshold = 2) {
  if (result.ok) return { status: 'ok', miss: 0 };
  const miss = Number(previousMiss || 0) + 1;
  return { status: miss >= threshold ? 'dead' : 'warn', miss };
}

/**
 * 巡检器：每次挑「最久没检查过」的一批跑完落库。
 * 并发压在小范围（默认 6），不至于把自己当成 DDoS，也不会让一次巡检拖上几分钟。
 */
export class HealthChecker {
  constructor({ store, settings, logger = console, probe = probeUrl, notify = null } = {}) {
    this.store = store;
    this.settings = settings;
    this.logger = logger;
    this.probe = probe;
    // 通知是可选的：巡检本身跑起来不依赖它，测试里也不用凑一个真的推送通道
    this.notify = notify;
    this.running = null;
    this.lastRun = null;
  }

  get threshold() {
    return 2;
  }

  /**
   * 跑一轮巡检。
   * @param {{limit?:number, concurrency?:number, timeout?:number, only?:string[]}} options
   */
  async run({ limit = 200, concurrency = 6, timeout = 8000, only = null } = {}) {
    if (this.running) return this.running;
    this.running = this.#run({ limit, concurrency, timeout, only }).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async #run({ limit, concurrency, timeout, only }) {
    const started = Date.now();
    let rows;
    if (Array.isArray(only) && only.length) {
      // 指定短码时按点名顺序测，用于「立即检测这一条」
      rows = only
        .map((code) => this.store.findLinkByCode(code))
        .filter(Boolean)
        .map((r) => ({ id: r.id, code: r.code, url: r.url }));
    } else {
      rows = this.store.sql.healthQueue.all(Math.max(1, Math.min(2000, limit)));
    }

    const result = { checked: 0, ok: 0, dead: 0, warn: 0, error: 0, ms: 0 };
    if (!rows.length) {
      result.ms = Date.now() - started;
      this.lastRun = { ...result, at: Date.now() };
      return result;
    }

    // 分流目标也要巡检：主目标活着不代表备选活着，
    // 权重抽到一个 404 的备选，用户看到的就是坏链接
    if (!Array.isArray(only) || !only.length) {
      const targets = this.store.sql.healthTargetQueue.all(Math.max(1, Math.min(2000, limit)));
      rows = rows.concat(targets.map((t) => ({ id: t.id, code: t.code, url: t.url, target: true })));
    }

    const queue = rows.slice();
    const worker = async () => {
      while (queue.length) {
        const row = queue.shift();
        const previous = row.target
          ? this.store.db.prepare('SELECT health_miss, health_status FROM link_targets WHERE id = ?').get(row.id)
          : this.store.sql.getLinkByCodeAny.get(row.code);
        const probe = await this.probe(row.url, { timeout }).catch((err) => ({
          ok: false,
          status: 0,
          ms: 0,
          error: truncate(err?.message || '请求失败', 120),
        }));
        const verdict = classify(probe, previous?.health_miss, this.threshold);
        try {
          const stmt = row.target ? this.store.sql.setTargetHealth : this.store.sql.setHealth;
          stmt.run(
            verdict.status,
            probe.status || null,
            Date.now(),
            probe.ms || null,
            probe.error || '',
            verdict.miss,
            row.id,
          );
        } catch (err) {
          this.logger.warn?.(`[health] 写入失败 ${row.code}: ${err.message}`);
        }
        // 只在「刚变成死链」时推一次。死链在下一轮巡检里还会被判死，
        // 每次都对着一件已经知道的事发通知，人就学会忽略通知了
        if (verdict.status === 'dead' && previous?.health_status !== 'dead') {
          const link = row.target ? null : this.store.sql.getLinkByCodeAny.get(row.code);
          this.notify?.emit('link.dead', {
            subject: row.code,
            text: `短链 /${row.code} 的目标地址连续 ${verdict.miss} 次探测失败：${probe.error || `HTTP ${probe.status}`}`,
            link: link ? shortUrlOf(this.settings, link.code) : '',
            data: { code: row.code, url: row.url, status: probe.status, error: probe.error || '', miss: verdict.miss, target: Boolean(row.target) },
          });
        }
        result.checked += 1;
        if (verdict.status === 'ok') result.ok += 1;
        else if (verdict.status === 'dead') result.dead += 1;
        else result.warn += 1;
        if (!probe.ok && !probe.status) result.error += 1;
      }
    };

    const workers = [];
    for (let i = 0; i < Math.max(1, Math.min(20, concurrency)); i += 1) workers.push(worker());
    await Promise.all(workers);

    result.ms = Date.now() - started;
    this.lastRun = { ...result, at: Date.now() };
    if (result.checked) {
      try {
        this.store.sql.insertAudit.run(
          Date.now(),
          'system',
          'link.health_check',
          `checked:${result.checked} dead:${result.dead}`,
        );
      } catch {
        /* 审计失败不影响巡检 */
      }
    }
    this.logger.info?.(`[health] 巡检 ${result.checked} 条，异常 ${result.dead + result.warn}，耗时 ${result.ms}ms`);
    return result;
  }

  /** 概览用：状态分布 + 最近确认的死链 */
  summary() {
    const counts = { ok: 0, warn: 0, dead: 0, unknown: 0 };
    for (const row of this.store.sql.healthSummary.all()) {
      if (row.status in counts) counts[row.status] = row.n;
    }
    const total = this.store.db.prepare('SELECT COUNT(*) AS n FROM links WHERE deleted_at IS NULL').get().n;
    counts.unknown = Math.max(0, total - counts.ok - counts.warn - counts.dead);
    // 分流目标单独计数：一个短链的健康和它备选目标的健康不是一回事
    const targetCounts = { ok: 0, warn: 0, dead: 0, unknown: 0 };
    for (const row of this.store.sql.healthTargetSummary.all()) {
      if (row.status in targetCounts) targetCounts[row.status] = row.n;
    }
    const targetTotal = this.store.db.prepare('SELECT COUNT(*) AS n FROM link_targets WHERE enabled = 1').get().n;
    targetCounts.unknown = Math.max(0, targetTotal - targetCounts.ok - targetCounts.warn - targetCounts.dead);
    return {
      counts,
      total,
      targets: { counts: targetCounts, total: targetTotal },
      broken: this.store.sql.healthBroken.all(6),
      // 死掉的分流目标也要露出来：主目标活着不代表备选活着
      brokenTargets: this.store.sql.healthTargetBroken.all(6),
      lastRun: this.lastRun,
      running: Boolean(this.running),
    };
  }
}
