/**
 * UA / IP 屏蔽：规则存库，进程内缓存编译后的正则，规则变更时失效。
 */
export class UaFilter {
  constructor(store, settings, { maxCache = 4096 } = {}) {
    this.store = store;
    this.settings = settings;
    this.rules = { ua: [], ip: [] };
    this.skipped = [];
    this.hits = [];
    this.maxCache = maxCache;
    this.reload();
  }

  reload() {
    const rows = this.store.sql.listRules.all();
    const next = { ua: [], ip: [] };
    const skipped = [];
    for (const row of rows) {
      if (!row.enabled) continue;
      const bucket = row.kind === 'ip' ? next.ip : next.ua;
      try {
        bucket.push({ id: row.id, pattern: row.pattern, re: compileRule(row.pattern) });
      } catch (err) {
        skipped.push({ id: row.id, pattern: row.pattern, reason: err.message });
      }
    }
    this.rules = next;
    this.skipped = skipped;
    this.hits = [];
    return this.rules;
  }

  /** 命中返回规则，未命中返回 null */
  match({ ua = '', ip = '' }) {
    for (const rule of this.rules.ip) {
      if (rule.re.test(ip)) return this.#hit(rule, 'ip');
    }
    for (const rule of this.rules.ua) {
      if (rule.re.test(ua)) return this.#hit(rule, 'ua');
    }
    return null;
  }

  #hit(rule, kind) {
    // 命中计数同样走内存，避免屏蔽本身就变成写入热点
    const found = this.hits.find((h) => h.id === rule.id);
    if (found) found.hits += 1;
    else this.hits.push({ id: rule.id, hits: 1 });
    return { ...rule, kind };
  }

  flushHits() {
    if (!this.hits.length) return 0;
    const batch = this.hits;
    this.hits = [];
    this.store.tx(() => {
      // 按累加值一条 SQL 落库。之前是命中几次就发几条 UPDATE，
      // 遇上刷同一规则的爬虫，一个节拍里能攒出上万条语句
      for (const item of batch) this.store.sql.bumpRuleHitsBy.run(item.hits, item.id);
    });
    return batch.length;
  }

  summary() {
    return {
      uaRules: this.rules.ua.length,
      ipRules: this.rules.ip.length,
      skipped: this.skipped,
    };
  }
}

export function compileRule(pattern) {
  const text = String(pattern || '').trim();
  if (!text) throw new Error('规则为空');
  // 支持 /regex/flags 写法，其余按「关键字 + 通配符 *」处理
  const slash = /^\/(.+)\/([gimsuy]*)$/.exec(text);
  if (slash) return safeRegex(slash[1], slash[2].replace(/g/g, ''));
  if (text.includes('*')) {
    const escaped = text
      .split('*')
      .map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return safeRegex(escaped, 'i');
  }
  return safeRegex(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

function safeRegex(source, flags) {
  const re = new RegExp(source, flags);
  // 防 ReDoS：对超长输入直接截断
  const test = re.test.bind(re);
  re.test = (input) => test(String(input).slice(0, 8192));
  return re;
}
