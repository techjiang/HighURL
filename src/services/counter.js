import { todayKey } from '../lib/util.js';

/**
 * 延迟计数：跳转只写内存计数，定时批量落库。
 * 高并发下 SQLite 写入次数从「每次点击一次」降到「每个批次每个短码一次」。
 */
export class ClickCounter {
  constructor(store, settings, logger = console) {
    this.store = store;
    this.settings = settings;
    this.logger = logger;
    this.buffer = new Map();
    this.timer = null;
    this.flushing = false;
    this.flushedTotal = 0;
    this.pendingTotal = 0;
    this.maxKeys = settings.get('countCacheMax') || 20000;
  }

  start() {
    const interval = this.settings.get('countFlushMs') || 1000;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.flush().catch((err) => this.logger.error?.('[counter] flush failed', err?.message || err));
    }, interval);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 记录一次点击（O(1)，不碰数据库）。
   *
   * country / targetId 只在开了分流或地区统计时才有值，
   * 没有值就只是少加两个 Map，不进也不多余判断。
   */
  hit(code, { day = todayKey(), ref = '', platform = 'unknown', country = '', targetId = null, at = 0 } = {}) {
    let entry = this.buffer.get(code);
    if (!entry) {
      if (this.buffer.size >= this.maxKeys) {
        // 缓存打满时先同步落一次，避免内存无界增长
        this.flush().catch(() => {});
      }
      entry = {
        clicks: 0, last: 0, day,
        daily: new Map(), refs: new Map(), agents: new Map(), countries: new Map(), targets: new Map(),
        // 时段桶：键是 dow*24+hour，值就是次数。跳转时取一次本地时间，
        // 热路径上不额外 new Date（同一个毫秒戳算出来是一样的）
        slots: new Map(),
      };
      this.buffer.set(code, entry);
    }
    entry.clicks += 1;
    entry.last = Date.now();
    entry.daily.set(day, (entry.daily.get(day) || 0) + 1);
    if (ref) entry.refs.set(ref, (entry.refs.get(ref) || 0) + 1);
    if (platform && platform !== 'unknown') {
      entry.agents.set(platform, (entry.agents.get(platform) || 0) + 1);
    }
    if (country) entry.countries.set(country, (entry.countries.get(country) || 0) + 1);
    if (targetId) entry.targets.set(targetId, (entry.targets.get(targetId) || 0) + 1);
    // 时段：星期 + 小时。用本地时区——「我们的用户几点活跃」问的是运营者所在时区，
    // 存 UTC 只会让人对着热力图算时差
    const when = at ? new Date(at) : new Date();
    const slotKey = when.getDay() * 24 + when.getHours();
    entry.slots.set(slotKey, (entry.slots.get(slotKey) || 0) + 1);
    this.pendingTotal += 1;
  }

  /**
   * 记一次「建页被看见」。
   *
   * 和 hit() 分开两个桶：曝光不是点击，混在一起会让所有点击数从建页上线那天起不可比。
   * 代价同样只是一次 Map 写，落库跟着同一个批次走。
   */
  view(code, { day = todayKey(), host = '' } = {}) {
    if (!this.views) this.views = new Map();
    let entry = this.views.get(code);
    if (!entry) {
      if (this.views.size >= this.maxKeys) this.flush().catch(() => {});
      entry = new Map();
      this.views.set(code, entry);
    }
    entry.set(`${day}\u0000${host}`, (entry.get(`${day}\u0000${host}`) || 0) + 1);
    this.viewsPending = (this.viewsPending || 0) + 1;
  }

  get pendingViews() {
    return this.viewsPending || 0;
  }

  get pending() {
    return this.pendingTotal;
  }

  /** 批量刷盘，单事务提交 */
  async flush() {
    const views = this.views || new Map();
    if (this.flushing || (this.buffer.size === 0 && views.size === 0)) return 0;
    this.flushing = true;
    const batch = this.buffer;
    this.buffer = new Map();
    const viewBatch = views;
    this.views = new Map();
    let count = 0;
    try {
      this.store.tx(() => {
        for (const [code, entry] of batch) {
          this.store.sql.bumpClicks.run(entry.clicks, entry.last, code);
          for (const [day, n] of entry.daily) this.store.sql.upsertDaily.run(code, day, n);
          for (const [host, n] of entry.refs) this.store.sql.upsertRef.run(code, host, n);
          for (const [platform, n] of entry.agents) this.store.sql.upsertAgent.run(code, platform, n);
          for (const [country, n] of entry.countries || []) this.store.sql.upsertCountry.run(code, country, n);
          for (const [targetId, n] of entry.targets || []) this.store.sql.bumpTargetClicks.run(n, targetId);
          for (const [slot, n] of entry.slots || []) {
            this.store.sql.upsertSlot.run(code, Math.floor(slot / 24), slot % 24, n);
          }
          count += entry.clicks;
        }
        for (const [code, entries] of viewBatch) {
          for (const [k, n] of entries) {
            const [day, host] = k.split('\u0000');
            this.store.sql.upsertLanding.run(code, day, host || '', n);
          }
        }
      });
      this.flushedTotal += count;
      this.pendingTotal = Math.max(0, this.pendingTotal - count);
      this.viewsPending = 0;
      return count;
    } catch (err) {
      // 回滚失败时把批次还回缓冲，下一次再试
      for (const [code, entry] of batch) {
        const exist = this.buffer.get(code);
        if (!exist) {
          this.buffer.set(code, entry);
          continue;
        }
        exist.clicks += entry.clicks;
        exist.last = Math.max(exist.last, entry.last);
        for (const [k, v] of entry.daily) exist.daily.set(k, (exist.daily.get(k) || 0) + v);
        for (const [k, v] of entry.refs) exist.refs.set(k, (exist.refs.get(k) || 0) + v);
        for (const [k, v] of entry.agents) exist.agents.set(k, (exist.agents.get(k) || 0) + v);
        for (const [k, v] of entry.countries || []) exist.countries.set(k, (exist.countries.get(k) || 0) + v);
        for (const [k, v] of entry.targets || []) exist.targets.set(k, (exist.targets.get(k) || 0) + v);
        for (const [k, v] of entry.slots || []) exist.slots.set(k, (exist.slots.get(k) || 0) + v);
      }
      // 曝光也还回去，否则一次写盘失败就把这批曝光悄悄丢了
      for (const [code, entries] of viewBatch) {
        if (!this.views) this.views = new Map();
        let back = this.views.get(code);
        if (!back) {
          back = new Map();
          this.views.set(code, back);
        }
        for (const [k, v] of entries) back.set(k, (back.get(k) || 0) + v);
        this.viewsPending = (this.viewsPending || 0) + [...entries.values()].reduce((a, b) => a + b, 0);
      }
      throw err;
    } finally {
      this.flushing = false;
    }
  }

  stats() {
    return {
      bufferedKeys: this.buffer.size,
      pendingClicks: this.pendingTotal,
      pendingViews: this.viewsPending || 0,
      flushedTotal: this.flushedTotal,
    };
  }
}
