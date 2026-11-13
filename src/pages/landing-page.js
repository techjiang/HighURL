import { pageShell } from './layout.js';
import { escapeHtml } from '../lib/html.js';
import { expireText } from './preview.js';

/** 主题：auto 跟随系统（默认），dark / light 由管理员钉死 */
const THEMES = ['auto', 'dark', 'light'];

export function normalizeTheme(input) {
  return THEMES.includes(String(input || '')) ? String(input) : 'auto';
}

/**
 * 跳转前的自动建页（interstitial）。
 *
 * 这不是「密码门」，是「先让你看清楚再决定」。区别很重要：
 * 密码门在没有口令的人那里等于把链接变成死链，而这里任何人都能走完，
 * 只是多花两秒钟看一眼目标域名、标题和剩余时间。
 *
 * 几个刻意的处理：
 * - **不自动跳**，必须点一次。自动跳的等待页只是噪音，几秒钟后自己跳走的话，
 *   那个「看清楚」的窗口根本不成立
 * - **域名加粗单独一行**，目标完整 URL 用等宽小字放下面。人判断安全性看的是域名，
 *   而一眼看整条 URL 反而只会记住最后那截路径
 * - **用 GET 表单去 /<code>?go=1**，而不是直接把目标地址放在 href 里：
 *   目标地址不落到 HTML 的链接上，就不会被各种预取、扫描、爬虫顺手点走，
 *   落地页被收藏或被转发出去，别人点开也只是又看一遍介绍页
 * - 停用 / 过期也照常渲染，只是把「继续访问」换成原因说明：
 *   「打不开」比「可能被人改了」好处理得多
 */
export function renderInterstitial(ctx, link, {
  shortUrl = '',
  host = '',
  reason = '',
  theme = 'auto',
  note = '',
  accent = '#8b5cf6',
  now = Date.now(),
  org = null,
} = {}) {
  const siteName = ctx.settings.get('siteName');
  // 组织级配置一处设好、全站建页共用：单条链接上再填一遍免责声明，
  // 一是没人会填，二是各填各的必然不一致
  const orgName = String(org?.name || '').trim();
  const logo = String(org?.logoUrl || '').trim();
  const disclaimer = String(org?.disclaimer || '').trim();
  const countdown = Math.max(0, Math.min(30, Number(org?.countdown) || 0));
  const title = String(link.title || '').trim() || host || '外部链接';
  const meta = [];
  if (host) meta.push(['目标域名', host]);
  if (link.group_name) meta.push(['分组', link.group_name]);
  const expire = expireText(link.expire_at, now);
  if (expire) meta.push(['有效期', expire]);
  if (note) meta.push(['说明', note]);

  const blocked = reason === 'expired'
    ? '这条短链已经超过有效期，管理员设置的有效时间已到。'
    : reason === 'disabled'
      ? '这条短链已被管理员停用，暂时无法访问。'
      : '';

  // 倒数提示不是自动跳转：只是把「你正要离开本站」这句话说重一点。
  // 真的做了自动跳，那个「看清楚目标域名」的窗口就不成立了
  const countdownHtml = countdown > 0
    ? `<p class="lp-countdown muted">留 ${escapeHtml(String(countdown))} 秒确认目标域名——页面不会自己跳走</p>`
    : '';

  const action = blocked
    ? `<div class="lp-blocked" role="alert">${escapeHtml(blocked)}</div>`
    : `<form method="get" action="/${encodeURIComponent(link.code)}" class="lp-go">
         <input type="hidden" name="go" value="1">
         <button type="submit" class="btn btn-primary lp-go-btn">继续访问${host ? ` ${escapeHtml(host)}` : ''}</button>
       </form>
       ${countdownHtml}`;

  const body = `<div class="lp" data-theme="${escapeHtml(normalizeTheme(theme))}" style="--lp-accent:${escapeHtml(accent)}">
  <div class="lp-glow" aria-hidden="true"></div>
  <header class="lp-nav">
    <a class="brand" href="/"><img src="${escapeHtml(logo || '/img/logo.svg')}" alt="" width="26" height="26">${escapeHtml(orgName || siteName)}</a>
    ${orgName ? `<span class="lp-org">由 ${escapeHtml(orgName)} 创建</span>` : ''}
  </header>
  <main class="lp-card">
    <p class="lp-kicker">你要前往</p>
    <h1 class="lp-host mono">${escapeHtml(host || '未知站点')}</h1>
    <p class="lp-title">${escapeHtml(title)}</p>
    <p class="lp-url mono">${escapeHtml(link.url)}</p>
    ${action}
    <dl class="lp-meta">
      ${meta.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}
    </dl>
    <p class="lp-foot">短链由 <code>/${escapeHtml(link.code)}</code>${shortUrl ? `（${escapeHtml(shortUrl.replace(/^https?:\/\//, ''))}）` : ''} 指向。确认域名是你要去的地方再继续。</p>
    ${disclaimer ? `<div class="lp-disclaimer">${disclaimer.split(/\r?\n/).filter(Boolean).map((line) => `<p>${escapeHtml(line)}</p>`).join('')}</div>` : ''}
  </main>
</div>`;

  return pageShell({
    version: ctx.version,
    title: `即将前往 ${host || '外部站点'} · ${siteName}`,
    body,
    bodyClass: 'page-lp',
    head: '<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">',
  });
}
