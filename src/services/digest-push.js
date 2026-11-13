import { buildDigest } from './insights.js';
import { dateKey, truncate } from '../lib/util.js';

/**
 * 定期摘要：把「本期要点」按天 / 按周推到人手上。
 *
 * 前面的通知解决的是「事情发生了」，但不解决「今天整体怎么样」。
 * 单条事件推得再及时，人的脑子里也不会自动拼出「昨天涨了 12%、有 3 件事等我处理」。
 * 这一层只做一件事：到点把 buildDigest() 已经算好的结论推出去。
 *
 * 几条取舍：
 * - **不另算一套统计**。摘要内容和概览页那一段完全同源，两处数字不一样就没法信了
 * - **一天只推一次**。挂在 30 秒心跳上，不设闸就是一天推两千次
 * - **没内容就不推**。既没有点击也没有待办时，一条「今天什么都没有」的推送
 *   只会消耗人对这条通道的注意力
 * - **推不出去不重试到死**。走的是通知那套退避，失败留底，不阻塞维护循环
 */

export const DIGEST_KINDS = {
  off: '关闭',
  daily: '每天推一次',
  weekly: '每周一推一次',
};

export const DIGEST_KIND_KEYS = Object.keys(DIGEST_KINDS);

/** 本地日期键：摘要按站点时区分天，不走 UTC */
function localDay(at) {
  return dateKey(at);
}

/**
 * 这一轮该推的槽位标识。
 *
 * 用「周期 + 日期」而不是时间戳做幂等键：进程在同一个小时内重启两次，
 * 或者维护循环因为某次异常多转了一圈，都不该变成两条摘要。
 * 周报带上 ISO 周号，跨周那天自动是新槽位。
 */
export function digestSlot(kind, at = new Date()) {
  if (kind === 'weekly') {
    const day = new Date(at.getTime());
    // ISO 周：以周四所在的周为准，跨年时不会出现「第 0 周」
    const d = new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    return `weekly-${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }
  return `daily-${localDay(at)}`;
}

/** 摘要窗口天数：日报 1 天，周报 7 天，也可用设置覆盖（1–30） */
export function digestWindowDays(kind, configured) {
  const n = Number(configured);
  if (Number.isFinite(n) && n >= 1 && n <= 30) return kind === 'weekly' && n === 1 ? 7 : n;
  return kind === 'weekly' ? 7 : 1;
}

/** 周报只在周一推；其余周期每天都推 */
export function isDigestDay(kind, at = new Date()) {
  if (kind === 'weekly') return at.getDay() === 1;
  return true;
}

/**
 * 摘要正文。写成「人话 + 能点」：
 * 第一行给结论，后面几行给细节，最后一行给入口。
 * 推送通道里能看到的就是这几行，界面上的卡片是另一回事。
 */
export function formatDigest(digest, { siteName = 'HighURL', baseUrl = '', at = new Date() } = {}) {
  const label = digest.days === 1 ? '近 1 天' : `近 ${digest.days} 天`;
  const head = `【${siteName}】${localDay(at)} 运营摘要（${label}）`;
  const lines = [];
  const info = digest.items.filter((i) => i.kind !== 'warn');
  const todo = digest.items.filter((i) => i.kind === 'warn');
  for (const item of info) lines.push(`· ${item.text}`);
  if (!info.length && !todo.length) lines.push(`· ${label}没有点击、也没有新增`);
  if (todo.length) {
    lines.push(`· 待处理 ${todo.length} 项：${todo.map((i) => i.text).join('；')}`);
  }
  // 没配 baseUrl 时不硬造相对路径：收到推送的人在手机/群里点不进 /admin#/dashboard，
  // 那串东西对他只是噪音
  const link = baseUrl ? `${String(baseUrl).replace(/\/+$/, '')}/admin#/dashboard` : '';
  return {
    title: '运营摘要',
    text: truncate([head, ...lines, link ? `详情 ${link}` : ''].filter(Boolean).join('\n'), 3500),
    subject: digestSlot('daily', at),
    link,
  };
}

export class DigestPusher {
  constructor({ store, settings, notify, logger = console }) {
    this.store = store;
    this.settings = settings;
    this.notify = notify;
    this.logger = logger;
  }

  config() {
    const kind = DIGEST_KIND_KEYS.includes(String(this.settings.get('digestPushKind') || ''))
      ? String(this.settings.get('digestPushKind'))
      : 'off';
    const hour = Math.max(0, Math.min(23, Math.floor(Number(this.settings.get('digestPushHour')) || 0)));
    return { kind, hour, windowDays: digestWindowDays(kind, this.settings.get('digestPushWindowDays')) };
  }

  /** 这个槽位是不是已经推过了。查投递记录而不是只记内存：进程重启后不该重推 */
  alreadyPushed(slot) {
    const row = this.store.db
      .prepare("SELECT id FROM notify_deliveries WHERE event = 'digest.periodic' AND subject = ? LIMIT 1")
      .get(String(slot));
    return Boolean(row);
  }

  /** 下一次推送时间，界面上写「下次 明天 09:00」比写一串配置直观 */
  nextRun(at = new Date()) {
    const { kind, hour } = this.config();
    if (kind === 'off') return null;
    const next = new Date(at.getTime());
    next.setHours(hour, 0, 0, 0);
    if (next <= at || !isDigestDay(kind, next)) {
      do {
        next.setDate(next.getDate() + 1);
        next.setHours(hour, 0, 0, 0);
      } while (!isDigestDay(kind, next));
    }
    return next.getTime();
  }

  /** 当前窗口的摘要内容，界面上的卡片和推送正文共用这一份 */
  build({ now = Date.now(), windowDays } = {}) {
    const cfg = this.config();
    const days = windowDays || cfg.windowDays;
    const digest = buildDigest(this.store, { now, hours: days * 24 });
    const formatted = formatDigest(digest, {
      siteName: this.settings.get('siteName'),
      baseUrl: this.settings.get('baseUrl'),
      at: new Date(now),
    });
    return { digest, ...formatted, windowDays: days, kinds: DIGEST_KINDS };
  }

  /**
   * 推送一次。
   *
   * `force` 用在界面上的「立即推送一次」：不看时间、不看有没有推过，
   * 但**仍然尊重渠道的事件订阅与静默时段**——手动点一下不该把静默里的人吵醒。
   */
  push({ now = Date.now(), force = false, slot } = {}) {
    const cfg = this.config();
    if (cfg.kind === 'off' && !force) return { pushed: 0, skipped: 'off' };
    const key = slot || digestSlot(cfg.kind === 'off' ? 'daily' : cfg.kind, new Date(now));
    if (!force && this.alreadyPushed(key)) return { pushed: 0, skipped: 'done', slot: key };
    const built = this.build({ now });
    // 空摘要不发：没有点击、也没有待办时，这条推送只是在消耗注意力
    if (!force && !built.digest.counts.clicks && !built.digest.items.length) {
      return { pushed: 0, skipped: 'empty', slot: key };
    }
    // 记下这次推之前的最大记录 id：同一个槽位手动推第二次时，
    // 按 subject 统计会把上一次的记录一起数进来
    const before = this.store.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM notify_deliveries').get().m;
    const sent = this.notify?.emit?.('digest.periodic', {
      subject: key,
      title: built.title,
      text: built.text,
      link: built.link,
      // 手动触发不走去重：同一个槽位再点一次，人期待的是「再发一遍」
      dedupe: !force,
      data: {
        windowDays: built.windowDays,
        counts: built.digest.counts,
        items: built.digest.items,
        hot: built.digest.hot?.slice(0, 5) || [],
      },
    }) || 0;
    // emit 只告诉我们「入队了几条」，但静默期内的那几条是挂起的。
    // 界面上要说清「几条真出去了、几条等到静默结束」，所以回头查一次这次的记录
    const detail = { queued: 0, held: 0, dropped: 0 };
    for (const row of this.store.db
      .prepare("SELECT status, COUNT(*) AS n FROM notify_deliveries WHERE event = 'digest.periodic' AND id > ? GROUP BY status")
      .all(before)) {
      if (row.status === 'held') detail.held += row.n;
      else if (row.status === 'dropped') detail.dropped += row.n;
      else detail.queued += row.n;
    }
    return { pushed: sent, slot: key, windowDays: built.windowDays, text: built.text, detail };
  }

  /** 维护循环里每 30 秒调一次：到点、是对的日子、还没推过，才推 */
  tick(now = new Date()) {
    const cfg = this.config();
    if (cfg.kind === 'off') return { pushed: 0, skipped: 'off' };
    if (now.getHours() < cfg.hour) return { pushed: 0, skipped: 'early' };
    if (!isDigestDay(cfg.kind, now)) return { pushed: 0, skipped: 'not-today' };
    const slot = digestSlot(cfg.kind, now);
    if (this.alreadyPushed(slot)) return { pushed: 0, skipped: 'done', slot };
    const out = this.push({ now: now.getTime(), slot });
    if (out.pushed) this.logger.info?.(`[digest] 已推送 ${slot}，${out.pushed} 个渠道`);
    return out;
  }
}
