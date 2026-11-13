import { HttpError } from '../lib/http.js';
import { truncate } from '../lib/util.js';

/**
 * 短链版本历史。
 *
 * 审计日志回答「谁在什么时候改了什么」，回答不了「改之前是什么」。
 * 而后者才是真正会被问到的问题——「我是不是把目标地址改错了」。
 * 所以每次改动前先存一份当时的快照，需要时按版本回滚。
 *
 * 几条取舍：
 * - 快照是完整 JSON，不做字段级 diff。字段还会长（分流、密码、地区），
 *   做 diff 意味着永远要跟着加，而历史记录本来就是「当时的样子」。
 * - 只留最近 N 条（默认 20）。历史是给自己留后路的，不是数据库备份；
 *   真按份数无上限地留，改得勤的短链会把库撑歪。
 * - 回滚本身也走一次 snapshot，所以「回滚错了」还能再回滚回来。
 */

const KEEP_PER_LINK = 20;

/** 一条短链当前的可回滚字段。密码不进来：它只在不同密码之间来回没有意义 */
export function snapshotOf(store, linkId) {
  const row = store.sql.getLinkByIdAny.get(Number(linkId));
  if (!row) return null;
  const targets = store.listTargets(row.id).map((t) => ({
    url: t.url,
    label: t.label,
    weight: t.weight,
    regions: t.regions,
    enabled: t.enabled,
  }));
  return {
    url: row.url,
    title: row.title,
    note: row.note,
    tags: row.tags,
    status: row.status,
    group_id: row.group_id ?? null,
    group_name: row.group_name || '',
    expire_at: row.expire_at ?? null,
    // 建页也是「这一版长什么样」的一部分：只回滚目标地址、却留着上一版的
    // 落地页说明，页面上就会出现一段指向别处的文字
    landing: {
      enabled: Boolean(row.interstitial),
      theme: row.landing_theme || 'auto',
      note: row.interstitial_note || '',
    },
    targets,
  };
}

export class HistoryService {
  constructor({ store, cache = null, settings = null, logger = console } = {}) {
    this.store = store;
    this.cache = cache;
    this.settings = settings;
    this.logger = logger;
  }

  /** 记一版。失败不冒泡——历史记不上不该让主操作失败 */
  record(linkId, { action = 'update', actor = 'admin' } = {}) {
    try {
      const row = this.store.sql.getLinkByIdAny.get(Number(linkId));
      if (!row) return null;
      const snapshot = snapshotOf(this.store, row.id);
      this.store.sql.insertHistory.run(row.id, row.code, action, String(actor || ''), JSON.stringify(snapshot), Date.now());
      this.trim(row.id);
      return snapshot;
    } catch (err) {
      this.logger?.warn?.('[history] 记录失败', err?.message || err);
      return null;
    }
  }

  /** 每个短链只留最近 KEEP_PER_LINK 条 */
  trim(linkId) {
    const keep = Number(this.settings?.get?.('historyKeep') || KEEP_PER_LINK) || KEEP_PER_LINK;
    const rows = this.store.db
      .prepare('SELECT id FROM link_history WHERE link_id = ? ORDER BY id DESC LIMIT -1 OFFSET ?')
      .all(Number(linkId), keep);
    if (!rows.length) return 0;
    const stmt = this.store.db.prepare('DELETE FROM link_history WHERE id = ?');
    this.store.tx(() => {
      for (const r of rows) stmt.run(r.id);
    });
    return rows.length;
  }

  list(linkId, { page = 1, perPage = 20 } = {}) {
    const total = this.store.sql.countHistory.get(Number(linkId)).n;
    const rows = this.store.sql.listHistory.all(Number(linkId), perPage, (page - 1) * perPage);
    return {
      total,
      page,
      perPage,
      pages: Math.max(1, Math.ceil(total / perPage)),
      items: rows.map((r) => {
        let snapshot = null;
        try {
          snapshot = JSON.parse(r.snapshot);
        } catch {
          snapshot = null;
        }
        return {
          id: r.id,
          action: r.action,
          actor: r.actor,
          at: r.created_at,
          summary: summaryOf(snapshot),
          snapshot,
        };
      }),
    };
  }

  /**
   * 两版之间差了什么。`toId` 传 0 表示当前状态。
   */
  diff(linkId, fromId, toId) {
    const link = this.store.sql.getLinkByIdAny.get(Number(linkId));
    if (!link) throw new HttpError(404, '短链不存在', 'link_not_found');
    const read = (id) => {
      if (Number(id) === 0) return snapshotOf(this.store, link.id);
      const row = this.store.sql.getHistory.get(Number(id));
      if (!row || Number(row.link_id) !== Number(link.id)) {
        throw new HttpError(404, '该版本不存在', 'history_not_found');
      }
      try {
        return JSON.parse(row.snapshot);
      } catch {
        throw new HttpError(400, '该版本快照已损坏，无法对比', 'history_corrupt');
      }
    };
    const a = read(fromId);
    const b = read(toId);
    const changes = diffSnapshots(a, b);
    return { changes, same: changes.length === 0 };
  }

  /**
   * 回滚到某一版。
   *
   * 先把「现在」也记一版，再写回去——回滚本身也是一次改动，
   * 不记的话「回滚错了」就真的回不去了。
   */
  rollback(linkId, historyId, { actor = 'admin' } = {}) {
    const link = this.store.sql.getLinkByIdAny.get(Number(linkId));
    if (!link) throw new HttpError(404, '短链不存在', 'link_not_found');
    const entry = this.store.sql.getHistory.get(Number(historyId));
    if (!entry || Number(entry.link_id) !== Number(link.id)) {
      throw new HttpError(404, '该版本不存在', 'history_not_found');
    }
    let snap;
    try {
      snap = JSON.parse(entry.snapshot);
    } catch {
      throw new HttpError(400, '该版本快照已损坏，无法回滚', 'history_corrupt');
    }
    this.record(link.id, { action: 'rollback_before', actor });

    this.store.tx(() => {
      this.store.sql.updateLink.run(
        snap.url || link.url,
        snap.title ?? '',
        snap.note ?? '',
        snap.tags ?? '',
        snap.status === 'disabled' ? 'disabled' : 'active',
        snap.expire_at ?? null,
        Date.now(),
        link.id,
      );
      // 分组按 id 落，但本机可能已经没有这个分组了——那就落 null，
      // 不留下一个指向不存在分组的幽灵引用
      const groupId = snap.group_id
        ? this.store.sql.getGroupById.get(Number(snap.group_id))?.id ?? null
        : null;
      this.store.sql.setLinkGroup.run(groupId, Date.now(), link.id);
      if (snap.landing && typeof snap.landing === 'object') {
        this.store.sql.updateLinkLanding.run(
          snap.landing.enabled ? 1 : 0,
          snap.landing.theme || 'auto',
          snap.landing.note || '',
          Date.now(),
          link.id,
        );
      }
      if (Array.isArray(snap.targets)) {
        this.store.sql.deleteTargetsByLink.run(link.id);
        for (const t of snap.targets) {
          if (!t?.url) continue;
          this.store.sql.insertTarget.run(
            link.id, String(t.url), String(t.label || ''), Number(t.weight) || 0,
            String(t.regions || ''), t.enabled === 0 ? 0 : 1, Date.now(),
          );
        }
      }
    });

    this.cache?.invalidate(link.code);
    // 回滚后的状态也要留一版，方便「回滚到了错的版本」时再往前走
    this.record(link.id, { action: 'rollback', actor });
    return this.store.sql.getLinkByIdAny.get(link.id);
  }
}

/**
 * 逐字段比较两版快照。
 *
 * 为什么不做成文字 diff：短链的字段就那几个，各自是独立的语义单位
 * （目标地址、标题、分组、分流目标……）。按字段比，出来的永远是
 * 「哪个字段从什么变成什么」，比按字符比一行 URL 有用得多。
 *
 * `b` 传 0 表示「和当前状态比」——「我是不是把它改坏了」这个问题
 * 的参照物通常是现在，而不是某个历史版本。
 */
export function diffSnapshots(a, b) {
  const left = a || {};
  const right = b || {};
  const out = [];
  const push = (field, label, from, to, kind = 'text') => {
    const l = from === undefined || from === null ? '' : from;
    const r = to === undefined || to === null ? '' : to;
    if (String(l) === String(r)) return;
    out.push({ field, label, from: l, to: r, kind });
  };

  push('url', '目标地址', left.url, right.url);
  push('title', '标题', left.title, right.title);
  push('note', '备注', left.note, right.note);
  push('tags', '标签', left.tags, right.tags);
  push('status', '状态', statusLabel(left.status), statusLabel(right.status));
  push('group_name', '分组', left.group_name || '未分组', right.group_name || '未分组');
  push('expire_at', '有效期', dateLabel(left.expire_at), dateLabel(right.expire_at));
  push('landing', '跳转前建页', landingLabel(left.landing), landingLabel(right.landing));

  // 分流目标按 URL 对：整组换掉是常态，按下标比会得到「全变了」的噪音
  const urlsOf = (snap) => new Set((Array.isArray(snap.targets) ? snap.targets : []).map((t) => String(t?.url || '')).filter(Boolean));
  const before = urlsOf(left);
  const after = urlsOf(right);
  const added = [...after].filter((u) => !before.has(u));
  const removed = [...before].filter((u) => !after.has(u));
  if (added.length || removed.length) {
    out.push({
      field: 'targets',
      label: '分流目标',
      from: [...before].join('\n'),
      to: [...after].join('\n'),
      added,
      removed,
      kind: 'targets',
    });
  }
  return out;
}

function landingLabel(landing) {
  if (!landing || typeof landing !== 'object') return '';
  const bits = [landing.enabled ? '开启' : '关闭'];
  if (landing.enabled && landing.theme && landing.theme !== 'auto') bits.push(landing.theme === 'dark' ? '暗色' : '亮色');
  if (landing.enabled && landing.note) bits.push(landing.note);
  return bits.join(' · ');
}

function statusLabel(status) {
  if (status === 'disabled') return '已停用';
  if (status === 'active') return '生效中';
  return String(status || '');
}

/** 有效期是毫秒时间戳，比之前先落成「有 / 无 + 日期」，省得比对一串数字 */
function dateLabel(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date(n).toISOString().slice(0, 10);
}

/** 给列表用的简述：只讲人看得懂的那部分 */
function summaryOf(snap) {
  if (!snap) return '快照不可读';
  const bits = [];
  if (snap.url) bits.push(truncate(snap.url, 60));
  if (snap.status === 'disabled') bits.push('已停用');
  if (snap.expire_at) bits.push(`有效期 ${new Date(Number(snap.expire_at)).toLocaleDateString('zh-CN')}`);
  if (snap.group_name) bits.push(`分组 ${snap.group_name}`);
  if (snap.landing?.enabled) bits.push('开启建页');
  if (Array.isArray(snap.targets) && snap.targets.length) bits.push(`${snap.targets.length} 个分流目标`);
  return bits.join(' · ') || '（空）';
}

export { KEEP_PER_LINK };
