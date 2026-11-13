import { HttpError } from '../lib/http.js';
import { DEFAULTS } from '../config.js';
import { verifyBackup } from './backup.js';

/**
 * 备份恢复：管理台与命令行共用同一套实现。
 *
 * 以前两条路各写一遍，结果互相漏：
 * - 管理台恢复了短链和统计，但**没恢复分组表**，短链挂着的 group_id 因为
 *   「本机没有这个分组」被一律置空——备份里明明有分组，恢复完全变成未分组
 * - 命令行恢复了分组，却漏了分流目标、访客地区、UA 规则
 *
 * 同一件事写两遍就会这样分叉。这里把「备份里有什么、怎么落地」收在一处，
 * 两个入口只负责传参和返回。
 *
 * 一条原则：**恢复是让另一台机器变成这台机器的样子**，所以顺序必须是
 * 分组 → 短链 → 分流目标 → 统计，否则外键关系落不下去。
 */

/** 备份里能识别的集合，缺了就跳过而不是报错，兼容早期版本的备份文件 */
const COLLECTIONS = ['links', 'groups', 'link_targets', 'click_daily', 'click_refs', 'click_agents', 'click_countries', 'click_slots', 'link_history', 'landing_views', 'reports'];

/**
 * 预检：只读文件，判断这份备份能恢复出什么。
 * 恢复是不可逆操作，先把账算清楚再点确认。
 */
export function inspectBackup(raw, store) {
  const data = typeof raw === 'string' ? safeParse(raw) : raw;
  if (!data || typeof data !== 'object') throw new HttpError(400, '备份文件不是合法 JSON', 'bad_backup');
  if (!Array.isArray(data.links)) throw new HttpError(400, '不是有效的 HighURL 备份文件', 'bad_backup');

  const existing = new Set(store.db.prepare('SELECT code FROM links').all().map((r) => String(r.code).toLowerCase()));
  const seen = new Set();
  let create = 0;
  let overwrite = 0;
  let skipped = 0;
  for (const raw of data.links) {
    const code = String(raw?.code ?? '').trim();
    const url = String(raw?.url ?? '').trim();
    if (!code || !/^https?:\/\//i.test(url)) {
      skipped += 1;
      continue;
    }
    const key = code.toLowerCase();
    // 备份内部自己重复时后者覆盖前者，不把两边都算一遍
    if (seen.has(key)) {
      overwrite += 1;
      continue;
    }
    seen.add(key);
    if (existing.has(key)) overwrite += 1;
    else create += 1;
  }

  const counts = {};
  for (const name of COLLECTIONS) counts[name] = Array.isArray(data[name]) ? data[name].length : 0;

  // 完整性校验：能确认对得上、确认对不上、还是根本没得确认，三态要分开给前端
  const integrity = verifyBackup(data);

  return {
    format: 'highurl',
    version: data.version ?? null,
    integrity,
    // 预检界面要显示「这份备份是谁导的」——机器名和程序版本都在 manifest 里，
    // 只给 integrity 的话前端拿不到，只能显示「未知主机」
    manifest: data.manifest && typeof data.manifest === 'object'
      ? { hostname: data.manifest.hostname || '', appVersion: data.manifest.appVersion || '', schemaVersion: data.manifest.schemaVersion ?? null }
      : null,
    exportedAt: data.exportedAt ?? null,
    links: { total: data.links.length, create, overwrite, skipped },
    counts,
    settings: Array.isArray(data.settings) ? data.settings.filter((s) => s && s.key in DEFAULTS && s.key !== 'port').length : 0,
    rules: Array.isArray(data.ua_rules) ? data.ua_rules.length : 0,
  };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, '备份文件不是合法 JSON', 'bad_backup');
  }
}

/**
 * 执行恢复。
 *
 * @param {object} opts
 * @param {'merge'|'replace'} opts.mode  replace 会先清空短链与统计（分组表也在内）
 * @param {boolean} opts.withSettings  是否把备份里的站点设置写回来。
 *   默认不写：备份经常是从试验机拿来的，悄悄把线上站点的 baseUrl 改了，
 *   后果比「设置没恢复」严重得多。要恢复就明确说要。
 */
export function restoreBackup(store, raw, { mode = 'merge', withSettings = false, force = false } = {}) {
  const data = typeof raw === 'string' ? safeParse(raw) : raw;
  if (!data || !Array.isArray(data.links)) throw new HttpError(400, '不是有效的 HighURL 备份文件', 'bad_backup');
  // 校验和对不上说明文件被改过或缺了内容。合并模式会把「缺的那半」当成
  // 「不需要恢复」静静跳过，然后报成功——这种失败最难追，所以默认拦住，
  // 要恢复就明确 force。
  const integrity = verifyBackup(data);
  if (integrity.status === 'mismatch' && !force) {
    throw new HttpError(400, `备份完整性校验未通过：${integrity.reason}。确认要用这份文件，请勾选「忽略校验」`, 'backup_checksum');
  }
  const replace = mode === 'replace';
  const result = { mode, restored: 0, skipped: 0, groups: 0, targets: 0, stats: 0, rules: 0, settings: 0, history: 0, reports: 0 };

  store.tx(() => {
    if (replace) {
      // 顺序按依赖反着来：先清子表再清主表，分组最后清（短链的 group_id 指向它）
      store.db.exec(`
        DELETE FROM click_daily; DELETE FROM click_refs; DELETE FROM click_agents;
        DELETE FROM click_countries; DELETE FROM link_targets; DELETE FROM link_history; DELETE FROM links;
      `);
      // 分组保留：备份里的分组要按名字并进来，先清空会把 merge 的语义也打乱
    }

    // ---- 1. 分组：按名字（不区分大小写）落库，记录 备份id → 本机id ----
    const groupIds = new Map();
    const pickGroup = store.db.prepare('SELECT id FROM groups WHERE name = ? COLLATE NOCASE');
    const upsertGroup = store.db.prepare(`INSERT INTO groups (name, color, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET color = excluded.color, note = excluded.note, updated_at = excluded.updated_at`);
    for (const g of data.groups || []) {
      const name = String(g?.name ?? '').trim();
      if (!name) continue;
      upsertGroup.run(name, g.color || '', g.note || '', g.created_at || Date.now(), g.updated_at || Date.now());
      const row = pickGroup.get(name);
      if (!row) continue;
      // 备份里的分组 id 是本机的自增号，换台机器就错位；名字才是稳定标识
      if (g.id !== undefined) groupIds.set(Number(g.id), row.id);
      result.groups += 1;
    }

    // ---- 2. 短链 ----
    const linkStmt = store.db.prepare(`INSERT INTO links
        (code, url, title, note, tags, status, password, clicks, created_at, updated_at, last_click_at, expire_at, group_id, deleted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET url = excluded.url, title = excluded.title, note = excluded.note,
          tags = excluded.tags, status = excluded.status, password = excluded.password, clicks = excluded.clicks,
          updated_at = excluded.updated_at, last_click_at = excluded.last_click_at, expire_at = excluded.expire_at,
          group_id = excluded.group_id, deleted_at = excluded.deleted_at`);
    const localCodes = new Map();
    for (const l of data.links) {
      const code = String(l?.code ?? '').trim();
      const url = String(l?.url ?? '').trim();
      if (!code || !/^https?:\/\//i.test(url)) {
        result.skipped += 1;
        continue;
      }
      // 指向本机不存在的分组时落 null，不留下 group_id=99 这种幽灵引用
      const groupId = l.group_id !== undefined && l.group_id !== null ? groupIds.get(Number(l.group_id)) ?? null : null;
      linkStmt.run(code, url, l.title || '', l.note || '', l.tags || '', l.status || 'active', l.password || null,
        Number(l.clicks) || 0, l.created_at || Date.now(), l.updated_at || Date.now(),
        l.last_click_at ?? null, l.expire_at ?? null, groupId, l.deleted_at ?? null);
      localCodes.set(code.toLowerCase(), code);
      result.restored += 1;
    }

    // 短链落完再按短码取本机 id：备份里的 link_id 在这里没有意义
    const idByCode = new Map(
      store.db.prepare('SELECT id, code FROM links').all().map((r) => [String(r.code).toLowerCase(), r.id]),
    );
    const linkIdOf = (entry) => {
      const byCode = entry.code ? idByCode.get(String(entry.code).toLowerCase()) : undefined;
      if (byCode) return byCode;
      // 老版本备份的 link_targets 只有 link_id，只能按本机 id 硬对
      const byId = Number(entry.link_id) || 0;
      return byId ? store.db.prepare('SELECT id FROM links WHERE id = ?').get(byId)?.id : undefined;
    };

    // ---- 3. 分流目标：整组替换，只碰备份里出现的短链 ----
    const touched = new Set();
    for (const t of data.link_targets || []) {
      const linkId = linkIdOf(t);
      if (!linkId) continue;
      if (!touched.has(linkId)) {
        store.db.prepare('DELETE FROM link_targets WHERE link_id = ?').run(linkId);
        touched.add(linkId);
      }
      // 早期备份的 link_targets 只有 url / label，没有 weight / enabled。
      // 以前写成 `Number(t.weight) ?? 100`，而 Number(undefined) 是 NaN 不是
      // nullish，?? 兜不住，直接把 NaN 写进 NOT NULL 列，整个恢复事务回滚。
      const weight = Number.isFinite(Number(t.weight)) ? Math.max(0, Math.floor(Number(t.weight))) : 100;
      const enabled = t.enabled === 0 || t.enabled === '0' || t.enabled === false ? 0 : 1;
      store.db.prepare(`INSERT INTO link_targets
          (link_id, url, label, weight, regions, enabled, clicks, created_at, health_status, health_code, health_at, health_ms, health_error, health_miss)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(linkId, t.url, t.label || '', weight, t.regions || '', enabled, Number(t.clicks) || 0,
          t.created_at || Date.now(), t.health_status || '', t.health_code ?? null, t.health_at ?? null, t.health_ms ?? null,
          t.health_error || '', t.health_miss || 0);
      result.targets += 1;
    }

    // ---- 4. 统计：三类明细 + 地区，全部累加 ----
    for (const d of data.click_daily || []) {
      if (!d?.code || !d?.day) continue;
      store.sql.upsertDaily.run(d.code, d.day, Number(d.clicks) || 0);
      result.stats += 1;
    }
    for (const r of data.click_refs || []) {
      if (!r?.code || !r?.host) continue;
      store.sql.upsertRef.run(r.code, r.host, Number(r.clicks) || 0);
      result.stats += 1;
    }
    for (const a of data.click_agents || []) {
      if (!a?.code || !a?.platform) continue;
      store.sql.upsertAgent.run(a.code, a.platform, Number(a.clicks) || 0);
      result.stats += 1;
    }
    for (const c of data.click_countries || []) {
      if (!c?.code || !c?.country) continue;
      store.sql.upsertCountry.run(c.code, c.country, Number(c.clicks) || 0);
      result.stats += 1;
    }
    // 时段桶：dow / hour 越界的行直接丢，不然会把热力图的格子算到数组外
    for (const s of data.click_slots || []) {
      const dow = Number(s?.dow);
      const hour = Number(s?.hour);
      if (!s?.code || !Number.isInteger(dow) || !Number.isInteger(hour)) continue;
      if (dow < 0 || dow > 6 || hour < 0 || hour > 23) continue;
      store.sql.upsertSlot.run(s.code, dow, hour, Number(s.clicks) || 0);
      result.stats += 1;
    }

    // ---- 4.4 建页曝光：和点击一样累加。老备份里没有这一项，跳过即可 ----
    for (const v of data.landing_views || []) {
      if (!v?.code || !v?.day) continue;
      store.sql.upsertLanding.run(v.code, String(v.day), String(v.host || ''), Number(v.views) || 0);
      result.stats += 1;
    }

    // ---- 4.6 举报：只补本机没有的（按 code+created_at 判重），不覆盖本机处理结论 ----
    for (const r of data.reports || []) {
      const code = String(r?.code ?? '').trim();
      const createdAt = Number(r?.created_at) || 0;
      if (!code || !createdAt) continue;
      if (store.db.prepare('SELECT id FROM reports WHERE code = ? AND created_at = ?').get(code, createdAt)) continue;
      store.sql.insertReport.run(code, String(r.reason || ''), String(r.note || ''), String(r.ip || ''), String(r.ua || ''), createdAt);
      result.reports += 1;
    }

    // ---- 4.5 变更历史：按短码对齐，整组替换只碰备份里出现的短链 ----
    const historyTouched = new Set();
    for (const h of data.link_history || []) {
      const code = String(h?.code ?? '');
      const linkId = code ? idByCode.get(code.toLowerCase()) : undefined;
      if (!linkId) continue;
      if (!historyTouched.has(linkId)) {
        store.sql.deleteHistoryByLink.run(linkId);
        historyTouched.add(linkId);
      }
      store.sql.insertHistory.run(linkId, code, String(h.action || 'update'), String(h.actor || ''), String(h.snapshot || '{}'), Number(h.created_at) || Date.now());
      result.history += 1;
    }

    // ---- 5. UA 规则：按 类型+规则 去重，不覆盖本机同名规则 ----
    const ruleExists = store.db.prepare('SELECT id FROM ua_rules WHERE kind = ? AND pattern = ?');
    for (const r of data.ua_rules || []) {
      const pattern = String(r?.pattern ?? '').trim();
      if (!pattern) continue;
      const kind = r.kind === 'ip' ? 'ip' : 'ua';
      if (ruleExists.get(kind, pattern)) continue;
      store.sql.insertRule.run(kind, pattern, String(r.note || '').slice(0, 120), r.enabled === 0 ? 0 : 1, Date.now());
      result.rules += 1;
    }

    // ---- 6. 站点设置：默认不动 ----
    if (withSettings) {
      for (const s of data.settings || []) {
        if (!s?.key || !(s.key in DEFAULTS) || s.key === 'port') continue;
        store.sql.setSetting.run(s.key, String(s.value));
        result.settings += 1;
      }
    }
    void localCodes;
  });

  return result;
}
