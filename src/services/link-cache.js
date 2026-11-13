/**
 * 跳转热路径缓存：命中即返回，避免每次点击都读库。
 * 写入/删除/改设置时整体失效，简单可靠。
 */
export class LinkCache {
  constructor(store, { ttlMs = 30000, max = 20000 } = {}) {
    this.store = store;
    this.ttlMs = ttlMs;
    this.max = max;
    this.map = new Map();
    this.targets = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * 缓存键统一小写：短码判重本来就不分大小写，/MiXeD 与 /mixed 是同一个入口。
   * 用两个键存同一份数据只会让失效漏掉一个，变成「改完还是旧链接」。
   */
  key(code) {
    return String(code ?? '').toLowerCase();
  }

  get(code) {
    const entry = this.map.get(this.key(code));
    if (!entry) {
      this.misses += 1;
      return null;
    }
    if (entry.exp < Date.now()) {
      // 这里删的是「缓存键」，不是原始入参：乱序大小写进来时
      // delete(code) 匹配不到任何条目，过期的僵尸数据会一直占着 Map 的位置
      this.map.delete(this.key(code));
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    // LRU：命中后挪到队尾
    this.map.delete(this.key(code));
    this.map.set(this.key(code), entry);
    return entry.link;
  }

  set(code, link) {
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(this.key(code), { link, exp: Date.now() + this.ttlMs });
  }

  load(code) {
    const cached = this.get(code);
    if (cached) return cached;
    // 精确命中走索引，大小写不一致时用 NOCASE 兜底，不在这里各自拼一遍
    const row = this.store.findLinkByCode(code);
    if (!row) return null;
    this.set(code, row);
    return row;
  }

  /**
   * 分流目标同样缓存，键与短链一致。
   *
   * 跳转热路径上多一次查库就是多一次 fs 保护，而目标只在管理台改动，
   * 30 秒的 TTL 足够。没有目标时缓存空数组：空数组也是信息，
   * 否则每次跳转都要去问一次库「这条到底有没有分流」。
   */
  loadTargets(code) {
    const key = this.key(code);
    const entry = this.targets.get(key);
    if (entry && entry.exp > Date.now()) return entry.list;
    // 复用短链缓存：一次多目标查询不该变成「先查链再查目标」两次往返
    const link = this.load(code);
    const list = link ? this.store.pickTargets(link.id) : [];
    if (this.targets.size >= this.max) {
      const oldest = this.targets.keys().next().value;
      if (oldest !== undefined) this.targets.delete(oldest);
    }
    this.targets.set(key, { list, exp: Date.now() + this.ttlMs });
    return list;
  }

  invalidate(code) {
    if (code) {
      this.map.delete(this.key(code));
      this.targets.delete(this.key(code));
    } else {
      this.map.clear();
      this.targets.clear();
    }
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      size: this.map.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total ? Number((this.hits / total).toFixed(4)) : 0,
    };
  }
}
