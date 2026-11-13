/**
 * 运营日报：把最近发生了什么整理成一段话，不落库、不缓存。
 *
 * 管理台的数据已经散在概览、来源、漏斗、实时流、举报箱、链接健康六处，
 * 但「今天跟昨天比好在哪、差在哪」始终要人自己在几个页面之间对。
 * 这里只做一件事：按固定的顺序把结论算出来，让前端照着念。
 *
 * 三条约定：
 *   1. 只报变化和异常，不报「一切正常」的漂亮话——没有变化就不说
 *   2. 每条都带可点进去的入口，结论和证据不能隔着一个页面
 *   3. 数据不够时老实说「样本太小」，不为了热闹把 3 次点击说成大新闻
 */

import { dateKey } from '../lib/util.js';

/**
 * 按「天」切窗口。click_daily 只有天粒度，硬用小时会切出半个桶，
 * 于是「最近 24 小时」实际是「昨天 + 今天」两天的合计——说清这一点比精确到小时重要。
 */
function dayKeyOf(ms) {
  return dateKey(new Date(ms));
}

/** 对比窗口内外的相对变化；分母太小的时候不判涨跌 */
function delta(current, previous, { min = 5 } = {}) {
  if (previous < min && current < min) return null;
  if (previous === 0) return current >= min ? 1 : null;
  const rate = (current - previous) / previous;
  if (Math.abs(rate) < 0.1) return 0;
  return rate;
}

function pct(rate) {
  const n = Math.round(Math.abs(rate) * 100);
  return `${n}%`;
}

/**
 * @param {import('../lib/db.js').Store} store
 * @param {{now?:number, hours?:number}} options
 */
export function buildDigest(store, { now = Date.now(), hours = 24 } = {}) {
  // 窗口只接受整天：底层三张统计表都是天粒度，开一个「最近 5 小时」的口子，
  // 出来的数字其实还是整天，界面上的时间范围就成了假的
  const span = Math.max(24, Math.min(720, Math.round((Number(hours) || 24) / 24) * 24));

  const scalar = (sql, ...params) => store.db.prepare(sql).get(...params)?.n || 0;

  // 按天粒度切两个相邻的整日窗口：click_daily 只有天，硬按小时切会切出半个桶，
  // 于是「最近 24 小时」实际是「今天 + 昨天」，而「上一个 24 小时」就是「昨天 + 前天」。
  // 用滚动窗口去凑，会让同一天的数据在两期里各算一次
  const days = span / 24;
  const fromKey = dayKeyOf(now - (days - 1) * 86400000);
  const prevFromKey = dayKeyOf(now - (days * 2 - 1) * 86400000);
  const sumSince = (table, key) =>
    scalar(
      `SELECT COALESCE(SUM(${table === 'click_daily' ? 'clicks' : 'views'}), 0) AS n FROM ${table}
       WHERE day >= ? AND code NOT IN (SELECT code FROM links WHERE deleted_at IS NOT NULL)`,
      key,
    );
  const clicksNow = sumSince('click_daily', fromKey);
  const clicksPrev = Math.max(0, sumSince('click_daily', prevFromKey) - clicksNow);
  const viewsNow = sumSince('landing_views', fromKey);
  const viewsPrev = Math.max(0, sumSince('landing_views', prevFromKey) - viewsNow);
  const createdNow = scalar(
    'SELECT COUNT(*) AS n FROM links WHERE deleted_at IS NULL AND created_at >= ?',
    new Date(`${fromKey}T00:00:00`).getTime(),
  );
  const expired = store.sql.expiredLinks.get(now).n;
  const dead = scalar("SELECT COUNT(*) AS n FROM links WHERE deleted_at IS NULL AND health_status = 'dead'");
  const openReports = store.sql.countOpenReports.get().n;
  const trashed = store.sql.countDeleted.get().n;

  const items = [];
  const push = (kind, text, link = '', value = null) => items.push({ kind, text, link, value });

  // 1. 点击涨跌
  // 时间单位按窗口实际长度说：一天 → 昨天，多天 → 前 N 天
  const spanText = days === 1 ? '昨天' : `前 ${days} 天`;
  const clickRate = delta(clicksNow, clicksPrev);
  if (clickRate !== null && clickRate !== 0) {
    push(
      clickRate > 0 ? 'up' : 'down',
      `点击较${spanText}${clickRate > 0 ? '涨' : '跌'} ${pct(clickRate)}（${clicksPrev} → ${clicksNow}）`,
      '#/sources',
      `${clickRate > 0 ? '+' : '-'}${pct(clickRate)}`,
    );
  } else if (clicksNow > 0) {
    push('flat', `点击与${spanText}持平（${clicksNow} 次）`, '#/sources');
  } else if (clicksPrev > 0) {
    push('down', `这期间一次点击都没有，${spanText}还有 ${clicksPrev} 次`, '#/sources');
  }

  // 2. 落地率变化：只在这段时间真的有曝光时才提，否则是在拿 0 分母说事
  if (viewsNow > 0 && viewsPrev > 0) {
    const rateNow = clicksNow / viewsNow;
    const ratePrev = clicksPrev / viewsPrev;
    const diff = rateNow - ratePrev;
    if (Math.abs(diff) >= 0.05) {
      push(
        diff > 0 ? 'up' : 'down',
        `建页落点率从 ${(ratePrev * 100).toFixed(0)}% 变成 ${(rateNow * 100).toFixed(0)}%，曝光 ${viewsNow} 次落地 ${clicksNow} 次`,
        '#/funnel',
        `${diff > 0 ? '+' : ''}${(diff * 100).toFixed(0)}pt`,
      );
    }
  } else if (viewsNow > 0) {
    push('info', `建页曝光 ${viewsNow} 次、落地 ${clicksNow} 次，${spanText}没有曝光可对比`, '#/funnel');
  }

  // 3. 新增短链
  if (createdNow > 0) push('info', `新增 ${createdNow} 条短链`, '#/links');

  // 4. 需要人动手的三类
  if (openReports > 0) push('warn', `有 ${openReports} 条举报还没处理`, '#/reports', String(openReports));
  if (dead > 0) push('warn', `${dead} 条短链的目标地址已确认打不开`, '#/links?health=dead', String(dead));
  if (expired > 0) push('warn', `${expired} 条短链已过有效期`, '#/links', String(expired));
  if (trashed > 0) push('muted', `回收站里有 ${trashed} 条，到期会自动清理`, '#/trash', String(trashed));

  const hot = store.hotLinks({ hours: span, limit: 5, now });
  const level = items.some((i) => i.kind === 'warn') ? 'warn' : items.some((i) => i.kind === 'up') ? 'up' : 'ok';

  return {
    hours: span,
    days,
    from: now - span * 3600000,
    fromDay: fromKey,
    level,
    counts: { clicks: clicksNow, clicksPrev, views: viewsNow, viewsPrev, created: createdNow },
    items,
    hot: hot.rows.map((r) => ({
      code: r.code,
      title: r.title,
      group: r.group_id ? { id: r.group_id, name: r.group_name || '' } : null,
      windowClicks: r.window_clicks,
      windowViews: r.window_views,
      totalClicks: r.total_clicks,
      lastClickAt: r.last_click_at,
    })),
  };
}
