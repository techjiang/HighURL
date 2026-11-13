import { HttpError } from '../lib/http.js';
import { normalizeUrl } from './links.js';

/**
 * 多目标分流：一个短码后面挂多个目标地址，按权重随机命中，或不看权重按地域指定。
 *
 * 两件事在这里被刻意分开：
 * - 「哪些目标参与」由 enabled / weight 决定（权重 0 等于临时关掉，但配置还在）
 * - 「最终给谁」由地域优先、权重兜底决定
 *
 * 为什么不用 Math.random 之外的随机：抽签必须便宜。跳转热路径上多一次
 * crypto 调用不会出错，但没必要——这不是安全决策，选哪个目标不构成攻击面。
 */

const CODE_RE = /^[A-Za-z]{2}$/;
export const MAX_TARGETS = 8;
const MAX_WEIGHT = 10000;

/** 解析区域列表：'CN, HK' / ['cn','hk'] / '' (全球) */
export function normalizeRegions(input) {
  if (input === undefined || input === null) return '';
  const list = Array.isArray(input) ? input : String(input).split(/[,，\s]+/);
  const out = [];
  for (const raw of list) {
    const code = String(raw).trim().toUpperCase();
    if (!code) continue;
    if (!CODE_RE.test(code)) {
      throw new HttpError(400, `地区代码「${raw}」不合法，应为两位国家/区域码，例如 CN、US、HK`, 'region_invalid');
    }
    if (!out.includes(code)) out.push(code);
  }
  return out.join(',');
}

export function regionList(regions) {
  return String(regions || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

/**
 * 从请求头解析访客地区。
 *
 * 零依赖意味着没有内置 GeoIP 库（那玩意儿动辄几十兆，还要按月更新）。
 * 所以只认反向代理已经算好的国家码：
 * - `CF-IPCountry` 由 Cloudflare 写入并会覆盖客户端自带的值，可以无条件信任
 * - 其余自定义头只在开了 trustProxy 时才认，否则客户端随便伪造就能挑目标
 *
 * 取不到就返回空串，让分流退回「全球目标」——地区识别失败不该让链接打不开。
 */
export function countryOf(req, { trustProxy = false } = {}) {
  const headers = req?.headers || {};
  const pick = (name) => {
    const value = headers[name];
    const first = Array.isArray(value) ? value[0] : value;
    const code = String(first || '').trim().toUpperCase();
    // XX = Cloudflare 的「未知」，T1 = Tor，都不是真实地区
    if (!CODE_RE.test(code) || code === 'XX' || code === 'T1') return '';
    return code;
  };
  const cf = pick('cf-ipcountry');
  if (cf) return cf;
  if (!trustProxy) return '';
  return pick('x-country-code') || pick('x-geo-country') || '';
}

/** 按权重抽一个目标。权重都是 0 时退化成等概率，避免「配置了却永远不选中」 */
export function weightedPick(targets, rand = Math.random) {
  if (!targets || !targets.length) return null;
  const total = targets.reduce((sum, t) => sum + Math.max(0, Number(t.weight) || 0), 0);
  if (total <= 0) return targets[Math.floor(rand() * targets.length) % targets.length];
  let roll = rand() * total;
  for (const t of targets) {
    roll -= Math.max(0, Number(t.weight) || 0);
    if (roll < 0) return t;
  }
  return targets[targets.length - 1];
}

/**
 * 选出这次访问要跳的目标，返回 { url, target } 或 null（用默认目标）。
 *
 * 顺序是「精确优先、兜底其次、默认最后」：
 * 1. 有地区匹配的目标 → 在匹配里的按权重抽
 * 2. 否则在全球目标（regions 为空）里按权重抽
 * 3. 都没有 → 回默认 links.url，链接永远能打开
 */
export function pickTarget(targets, country = '', rand = Math.random) {
  const usable = (targets || []).filter((t) => t.enabled && Number(t.weight) > 0);
  if (!usable.length) return null;
  const cc = String(country || '').toUpperCase();
  if (cc) {
    const local = usable.filter((t) => regionList(t.regions).includes(cc));
    if (local.length) {
      const hit = weightedPick(local, rand);
      return hit ? { url: hit.url, target: hit } : null;
    }
  }
  const global = usable.filter((t) => !regionList(t.regions).length);
  if (global.length) {
    const hit = weightedPick(global, rand);
    return hit ? { url: hit.url, target: hit } : null;
  }
  return null;
}

/** 校验并规范化一条目标输入 */
export function normalizeTarget(input) {
  const url = normalizeUrl(input?.url);
  const label = String(input?.label ?? '').trim().slice(0, 40);
  const weight = input?.weight === undefined || input?.weight === '' ? 100 : Number(input.weight);
  if (!Number.isFinite(weight) || weight < 0 || weight > MAX_WEIGHT) {
    throw new HttpError(400, `权重需在 0–${MAX_WEIGHT} 之间，0 表示暂不参与`, 'weight_invalid');
  }
  return {
    id: input?.id === undefined ? 0 : Number(input.id) || 0,
    url,
    label,
    weight: Math.floor(weight),
    regions: normalizeRegions(input?.regions),
    enabled: input?.enabled === false || input?.enabled === 0 || input?.enabled === '0' ? 0 : 1,
  };
}

/**
 * 补丁式的目标集合同步：按 id 更新、没有 id 的新增、不在列表里的删掉。
 * 管理台一次提交整组，语义是「提交后就是这样」，所以删除由缺省推断。
 */
export class TargetService {
  constructor({ store, logger = console }) {
    this.store = store;
    this.logger = logger;
  }

  list(linkId) {
    return this.store.listTargets(linkId).map(serializeTarget);
  }

  /**
   * 整组替换。空数组表示取消分流，回到单一默认目标。
   * @returns {{targets: object[], removed: number}}
   */
  replace(linkId, inputs) {
    const link = this.store.sql.getLinkByIdAny.get(Number(linkId)) || this.store.sql.getLinkById.get(Number(linkId));
    if (!link) throw new HttpError(404, '短链不存在', 'link_not_found');
    const list = Array.isArray(inputs) ? inputs : [];
    if (list.length > MAX_TARGETS) {
      throw new HttpError(400, `最多 ${MAX_TARGETS} 个分流目标`, 'too_many_targets');
    }
    const normalized = list.map(normalizeTarget);
    if (normalized.length === 1) {
      const only = normalized[0];
      // 只有一个目标且是「全球、100 权重、启用」时，它和默认目标完全等价，
      // 存下来只会让人以为开了 A/B。直接拒绝，比事后解释省事。
      if (only.regions === '' && only.weight === 100 && only.enabled === 1 && only.url === link.url) {
        throw new HttpError(400, '只有一个与默认目标相同的分流目标，等于没开分流', 'target_redundant');
      }
    }
    const existing = new Set(this.store.listTargets(link.id).map((t) => t.id));
    const keep = new Set();
    let removed = 0;
    this.store.tx(() => {
      for (const item of normalized) {
        const id = Number(item.id);
        if (id && existing.has(id)) {
          this.store.sql.updateTarget.run(item.url, item.label, item.weight, item.regions, item.enabled, id, link.id);
          keep.add(id);
        } else {
          this.store.sql.insertTarget.run(link.id, item.url, item.label, item.weight, item.regions, item.enabled, Date.now());
        }
      }
      for (const id of existing) {
        if (keep.has(id)) continue;
        this.store.sql.deleteTarget.run(id, link.id);
        removed += 1;
      }
    });
    return { targets: this.list(link.id), removed };
  }
}

export function serializeTarget(t) {
  return {
    id: t.id,
    url: t.url,
    label: t.label || '',
    weight: t.weight,
    regions: regionList(t.regions),
    enabled: Boolean(t.enabled),
    clicks: t.clicks || 0,
    health: {
      status: t.health_status || 'unknown',
      code: t.health_code ?? null,
      at: t.health_at ?? null,
      error: t.health_error || '',
      miss: t.health_miss || 0,
    },
  };
}

/** 本地生成一个稳定的随机源，仅测试用 */
export function seededRandom(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
