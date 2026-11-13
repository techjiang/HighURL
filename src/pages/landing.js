import { pageShell, assetQuery } from './layout.js';
import { escapeHtml } from '../lib/html.js';
import { icon } from '../lib/icons.js';

const FEATURES = [
  ['短链生成', '粘贴长链接即可得到清爽短链，支持自定义短码、有效期与备注。', 'shorten'],
  ['链接管理', '搜索、筛选、批量操作、导出 CSV，改链接不用重建。', 'manage'],
  ['分组归类', '按项目、活动或团队给短链分组，删分组不会伤到里面的链接。', 'tag'],
  ['延迟计数', '点击先在内存累加，定时批量落库，高并发也不拖慢跳转。', 'timer'],
  ['标题抓取', '自动读取目标页标题，列表里一眼认出是哪条链接。', 'title'],
  ['UA 屏蔽', '自定义关键字、通配符或正则，恶意爬虫直接挡在门外。', 'shield'],
  ['回收站', '删除先进回收站，误删能救回；短码继续占位，不会被抢注。', 'trash'],
  ['数据迁移', '一键导入 YOURLS 的 MySQL dump，短码和点击数原样保留。', 'migrate'],
  ['死链巡检', '定期敲一下目标地址，页面下线、域名失效会在管理台里标出来。', 'pulse'],
  ['实时访问', '谁在什么时候点了哪条短链，管理台首页滚动显示，IP 已脱敏。', 'live'],
  ['开放 API', 'Bearer Token 鉴权，创建、查询、统计都能脚本化。', 'api'],
  ['零依赖部署', '单文件 SQLite + Node 内置模块，一个容器就能跑。', 'server'],
];

export function renderLanding(ctx, { publicCreate, latest = [], stats }) {
  const siteName = ctx.settings.get('siteName');
  const desc = ctx.settings.get('siteDescription');
  const featureCards = FEATURES.map(
    ([title, text, name]) => `<article class="feature">
      <h3><span class="ico">${icon(name, { size: 15 })}</span>${escapeHtml(title)}</h3>
      <p>${escapeHtml(text)}</p>
    </article>`,
  ).join('');

  const createPanel = publicCreate
    ? `<form class="shorten" id="shorten-form" autocomplete="off">
        <input type="url" name="url" id="url-input" placeholder="https://example.com/very/long/link?utm=..." required aria-label="长链接">
        <button class="btn btn-primary" type="submit">缩短</button>
      </form>
      <div class="result" id="result" hidden></div>`
    : `<div class="shorten" style="justify-content:center;padding:18px">
        <span class="muted">当前站点仅管理员可创建短链</span>
        <a class="btn btn-primary" href="/admin">进入管理台</a>
      </div>`;

  const statsStrip = `<div class="stats-strip">
    <div class="stat"><b>${formatNumber(stats.total)}</b><span>短链接</span></div>
    <div class="stat"><b>${formatNumber(stats.clicks)}</b><span>累计点击</span></div>
    <div class="stat"><b>${formatNumber(stats.active)}</b><span>生效中</span></div>
    <div class="stat"><b>${formatNumber(stats.today)}</b><span>今日点击</span></div>
  </div>`;

  const latestHtml = latest.length
    ? `<div class="section-title"><h2>最近创建</h2><p>看看大家都在用 ${escapeHtml(siteName)} 分享什么</p></div>
       <div class="features">${latest
         .map(
           (l) => `<article class="feature">
            <h3 class="truncate"><span class="ico">${icon('shorten', { size: 15 })}</span>${escapeHtml(l.title || l.url)}</h3>
            <p class="truncate mono">/${escapeHtml(l.code)}</p>
            <p class="truncate muted" style="margin-top:6px">${formatNumber(l.clicks)} 次点击</p>
          </article>`,
         )
         .join('')}</div>`
    : '';

  const body = `<div class="landing">
  <header class="nav">
    <a class="brand" href="/"><img src="/img/logo.svg" alt="" width="30" height="30">${escapeHtml(siteName)}</a>
    <span class="spacer"></span>
    <a class="btn btn-ghost btn-sm" href="/docs">API 文档</a>
    <a class="btn btn-primary btn-sm" href="/admin">管理台</a>
  </header>

  <section class="hero">
    <span class="pill"><span class="dot"></span>自托管 · 零依赖 · 开箱即用</span>
    <h1>把长链接<br><span class="grad-text">剪短、提速、管起来</span></h1>
    <p class="lead">${escapeHtml(desc)}</p>
    ${createPanel}
  </section>

  ${statsStrip}

  <div class="section-title"><h2>功能特点</h2><p>该有的都有，不该慢的绝不慢</p></div>
  <section class="features">${featureCards}</section>

  ${latestHtml}

  <footer class="footer">
    <span>© ${new Date().getFullYear()} ${escapeHtml(siteName)} · 自托管短链接系统</span>
    <span class="row"><a href="/docs">API</a><span class="muted">·</span><a href="/health">健康检查</a><span class="muted">·</span><a href="/admin">管理台</a></span>
  </footer>
</div>
<script src="/static/landing.js${assetQuery(ctx.version)}" defer></script>`;

  return pageShell({
    version: ctx.version,
    title: `${siteName} · ${desc}`,
    body,
    head: `<meta name="description" content="${escapeHtml(desc)}">
<meta property="og:title" content="${escapeHtml(siteName)}">
<meta property="og:description" content="${escapeHtml(desc)}">
<meta property="og:image" content="/img/og.png">
<meta name="twitter:card" content="summary_large_image">`,
  });
}

export function formatNumber(n) {
  const num = Number(n) || 0;
  if (num >= 1e9) return `${(num / 1e9).toFixed(1)}B`;
  if (num >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
  if (num >= 1e4) return `${(num / 1e3).toFixed(1)}K`;
  return String(num);
}
