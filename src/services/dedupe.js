/**
 * 点击去重：同一 IP 对同一短链在窗口期内的重复点击只算一次。
 *
 * 场景很实际——有人把短链贴进群里，几十个人同时点；或者同一个人刷新几遍页面，
 * 点击数就虚高了。这里只记「最近一次计入的时间」，命中窗口就跳过计数，
 * 但跳转照常发生：去重影响的是统计，不是可用性。
 *
 * 实现上全部在内存，跳转热路径不做任何 IO。
 */
export class ClickDeduper {
  constructor({ maxKeys = 50000 } = {}) {
    this.maxKeys = maxKeys;
    this.seenAt = new Map();
    this.skipped = 0;
  }

  /** @returns {boolean} true 表示窗口内重复，不应计入 */
  isDuplicate(code, ip, windowSec) {
    const windowMs = Number(windowSec) * 1000;
    if (!windowMs || windowMs <= 0) return false;
    const key = `${String(code).toLowerCase()}|${ip}`;
    const now = Date.now();
    const last = this.seenAt.get(key);
    if (last && now - last < windowMs) {
      this.skipped += 1;
      return true;
    }
    if (this.seenAt.size >= this.maxKeys) this.sweep(windowMs);
    this.seenAt.set(key, now);
    return false;
  }

  /** 只清理已经过期的条目，窗口外的记录留着也没用 */
  sweep(windowMs) {
    const cutoff = Date.now() - windowMs;
    for (const [key, at] of this.seenAt) {
      if (at < cutoff) this.seenAt.delete(key);
    }
    // 极端情况下（全是新条目）再丢一半，避免 Map 无界增长
    if (this.seenAt.size >= this.maxKeys) {
      let drop = Math.floor(this.maxKeys / 2);
      for (const key of this.seenAt.keys()) {
        this.seenAt.delete(key);
        if (--drop <= 0) break;
      }
    }
  }

  stats() {
    return { tracked: this.seenAt.size, skipped: this.skipped };
  }
}
