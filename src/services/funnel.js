/**
 * 渠道漏斗：建页被看了多少次，其中多少次真的点进去了。
 *
 * 为什么需要这份数据：建页把「目标地址」从 HTML 里拿掉了，于是 click_refs
 * 只记「真的跳过去」的那批。投放之后看到的点击数是**落地数**，
 * 而 1000 次曝光里只有 30 次落地和 1000 次曝光里 800 次落地，
 * 说明的是完全不同的两件事（前者要么话术不对，要么按钮坏了）。
 *
 * 三条口径上的规矩：
 * - **曝光不算点击**。混进去会让「点击数」从建页上线那天起不可比
 * - **漏斗是按短链累计的，不按天对**。click_daily 只有 (code, day)，
 *   没有 host，拿它对日期只能造出一个看似精确的假数字
 * - **空渠道单独成行，不并进「直接访问」**。曝光侧的空渠道是真的「没有 referrer」，
 *   落地侧没有 referrer 的点击根本不进 click_refs —— 两边含义不同，混在一起就错了
 */

/** 落点比例：注意分母为 0 时返回 null，不能返回 0 —— 「没有曝光」和「一个都没点」是两件事 */
export function rateOf(views, clicks) {
  if (!views) return null;
  return clicks / views;
}

export function funnelRows(store, { code = '', limit = 30 } = {}) {
  const rows = store.funnelByHost({ code });
  return rows.slice(0, limit).map((row) => ({
    host: row.host,
    views: row.views,
    clicks: row.clicks,
    rate: rateOf(row.views, row.clicks),
  }));
}

export function funnelSummary(store) {
  const rows = store.funnelByHost({});
  const views = rows.reduce((s, r) => s + r.views, 0);
  const clicks = rows.reduce((s, r) => s + r.clicks, 0);
  return {
    views,
    clicks,
    rate: rateOf(views, clicks),
    hosts: rows.length,
    // 只有曝光没有落地的渠道：投放里最该被看见的一类
    dead: rows.filter((r) => r.views > 0 && r.clicks === 0).length,
  };
}

/**
 * 投放复盘的下钻：某个渠道里，各条短链各自的落点率。
 *
 * 为什么单独一条查询，而不是复用 funnelByHost + 前端过滤：
 * 「这条链在这个渠道的落点率」= 该渠道的曝光 + **该渠道的**落地。
 * 拿全量落地去除渠道曝光，得到的是跨渠道混出来的数字——看着精确，实际错。
 * 所以渠道一旦指定，曝光和落地两边都按 host 过滤，缺一边就都不是这个渠道的数。
 *
 * 排序按「曝光 × 未落点」倒推：先看人多且没进来的那些，
 * 那是话术或按钮的问题，不是流量的错。零落地单独标出来。
 */
export function hostDrilldown(store, host, { limit = 50 } = {}) {
  const views = new Map();
  for (const row of store.sql.landingByHost.all(host)) {
    views.set(row.code, (views.get(row.code) || 0) + (Number(row.views) || 0));
  }
  const clicks = new Map();
  for (const row of store.sql.redirectsByHost.all(host)) {
    clicks.set(row.code, (clicks.get(row.code) || 0) + (Number(row.clicks) || 0));
  }
  const codes = new Set([...views.keys(), ...clicks.keys()]);
  const rows = [];
  for (const code of codes) {
    const v = views.get(code) || 0;
    const c = clicks.get(code) || 0;
    const link = store.findLinkByCode(code);
    rows.push({
      code,
      // 短链被软删除后仍在统计表里；下钻列表要能看出这一条已经不在库中
      title: link ? link.title || '' : '',
      gone: !link,
      views: v,
      clicks: c,
      rate: rateOf(v, c),
      lost: Math.max(0, v - c),
    });
  }
  rows.sort((a, b) => b.lost - a.lost || b.views - a.views || a.code.localeCompare(b.code));
  return rows.slice(0, limit);
}
