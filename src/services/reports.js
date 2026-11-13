import { clientIp } from '../lib/util.js';

/**
 * 名片页上的「举报这条链」。
 *
 * 自托管站点里短链是管理员自己建的，但转发出去之后，收到的人没有任何反馈渠道——
 * 出了问题只能去别处骂，而管理员这边什么都看不到。举报箱把这条回路接上。
 *
 * 几条克制的处理：
 * - **不自动处置**。举报只进队列，处理与否由人决定。自动停链等于把「谁能打掉一条链接」
 *   交给匿名访问者，这比垃圾链接本身更麻烦
 * - **同 IP 同短链一天只收一条**。不做的话，一个人连点就能把队列刷满
 * - **不信任正文**。reason 走白名单，note 截断，IP 只做限流依据、界面里脱敏
 * - 举报记录**比短链活得久**：短链被彻底删除后，举报还在，否则「有人投诉过」这件事会凭空消失
 */

const REASONS = ['spam', 'phishing', 'malware', 'illegal', 'other'];

export const REASON_LABEL = {
  spam: '垃圾广告',
  phishing: '钓鱼诈骗',
  malware: '恶意软件',
  illegal: '违法内容',
  other: '其它问题',
};

const MAX_NOTE = 500;
/** 同 IP 同短链一天一条：够用，也不至于让一个人刷满队列 */
const WINDOW_MS = 86400000;

export class ReportBox {
  constructor(store) {
    /** @type {Map<string, number>} `ip\0code` → 上次提交时间 */
    this.recent = new Map();
    this.store = store;
  }

  normalize(reason) {
    const r = String(reason || '').trim().toLowerCase();
    return REASONS.includes(r) ? r : 'other';
  }

  /** 只做节流判断，不写库；返回 true 表示这次该被拦下 */
  throttled(code, ip) {
    const key = `${ip}\u0000${String(code).toLowerCase()}`;
    const last = this.recent.get(key);
    const now = Date.now();
    if (last && now - last < WINDOW_MS) return true;
    this.recent.set(key, now);
    // 顺手清过期项，避免 Map 无界增长（一天窗口意味着条目天然很少）
    if (this.recent.size > 5000) {
      for (const [k, at] of this.recent) if (now - at >= WINDOW_MS) this.recent.delete(k);
    }
    return false;
  }

  add({ code, reason, note, ip, ua }) {
    const row = {
      code: String(code || ''),
      reason: this.normalize(reason),
      note: String(note || '').trim().slice(0, MAX_NOTE),
      ip: String(ip || '').slice(0, 60),
      ua: String(ua || '').slice(0, 250),
    };
    if (!row.code) throw new Error('code required');
    this.store.sql.insertReport.run(row.code, row.reason, row.note, row.ip, row.ua, Date.now());
    return row;
  }

  list({ page = 1, perPage = 20, status = '' } = {}) {
    const p = Math.max(1, Number(page) || 1);
    const size = Math.min(100, Math.max(1, Number(perPage) || 20));
    const all = this.store.sql.listReports.all(1000, 0);
    const filtered = status ? all.filter((r) => r.status === status) : all;
    return {
      items: filtered.slice((p - 1) * size, p * size),
      total: filtered.length,
      page: p,
      perPage: size,
      open: this.store.sql.countOpenReports.get().n,
    };
  }

  handle(id, { status = 'handled', actor = '' } = {}) {
    const next = ['open', 'handled', 'ignored'].includes(String(status)) ? String(status) : 'handled';
    this.store.sql.setReportStatus.run(next, Date.now(), String(actor), Number(id));
    return this.store.sql.getReport.get(Number(id));
  }

  ipOf(req) {
    return clientIp(req, false);
  }
}

export { REASONS };
