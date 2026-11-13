import { pageShell } from './layout.js';
import { escapeHtml } from '../lib/html.js';

/** 把毫秒时间戳写成「还有 3 天」「明天」「今天结束」这种人话 */
export function expireText(expireAt, now = Date.now()) {
  if (expireAt === null || expireAt === undefined || expireAt === '') return '';
  const ms = Number(expireAt) - now;
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return '已过期';
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return `还有 ${days} 天到期`;
  const hours = Math.floor(ms / 3600000);
  if (hours >= 1) return `还有 ${hours} 小时到期`;
  return '不到 1 小时到期';
}

const REPORT_REASONS = [
  ['spam', '垃圾广告'],
  ['phishing', '钓鱼诈骗'],
  ['malware', '恶意软件'],
  ['illegal', '违法内容'],
  ['other', '其它问题'],
];

/**
 * 举报区块。
 *
 * 用原生 `<details>` 而不是弹窗：这页没有加载任何脚本，为一个举报表单拉一套
 * 前端逻辑不值得，而 `<details>` 零成本就有展开收起。
 * 表单 POST 回 `/<code>`，和密码解锁共用一个地址，靠隐藏的 kind 区分。
 */
function reportBlock(link, { canReport, reported }) {
  if (!canReport) return '';
  if (reported) {
    return '<p class="preview-reported">举报已提交，管理员会核对该链接。</p>';
  }
  const options = REPORT_REASONS.map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join('');
  return `<details class="preview-report">
    <summary>这条链接有问题？</summary>
    <form method="post" action="/${escapeHtml(link.code)}" class="preview-report-form">
      <input type="hidden" name="kind" value="report">
      <div class="field"><label>问题类型</label><select name="reason">${options}</select></div>
      <div class="field"><label>补充说明（可选）</label><textarea name="note" rows="3" maxlength="500" placeholder="说明一下具体情况，方便管理员判断"></textarea></div>
      <button class="btn btn-ghost btn-sm" type="submit">提交举报</button>
      <p class="hint">举报不会自动停用链接，会由管理员人工核对。</p>
    </form>
  </details>`;
}

/**
 * 短链名片页 /<code>+ 。
 *
 * 用「加号」而不是「预览」这类路径段：短码允许 1–64 位任意字母数字，
 * 任何英文单词都可能正好是别人的短码。`+` 不在短码字符集里，永远不会撞。
 *
 * 这页只做展示，不计数——「想看清楚这条链指向哪」不是一次访问，
 * 记进去只会让点击数变得不可信。
 */
export function renderLinkPreview(ctx, link, { shortUrl, qr, expireAt = null, canReport = false, reported = false }) {
  const siteName = ctx.settings.get('siteName');
  const title = link.title || link.url;
  const meta = [];
  if (link.group_name) meta.push(['分组', link.group_name]);
  if (link.tags) meta.push(['标签', String(link.tags).split(',').filter(Boolean).join(' · ')]);
  if (expireAt) meta.push(['有效期', expireText(expireAt)]);
  meta.push(['累计点击', `${Number(link.clicks) || 0} 次`]);
  meta.push(['创建于', new Date(Number(link.created_at) || Date.now()).toISOString().slice(0, 16).replace('T', ' ')]);

  const body = `<div class="preview">
  <header class="nav">
    <a class="brand" href="/"><img src="/img/logo.svg" alt="" width="26" height="26">${escapeHtml(siteName)}</a>
    <span class="spacer"></span>
    <a class="btn btn-ghost btn-sm" href="/">首页</a>
  </header>
  <main class="preview-card">
    <p class="preview-kicker"><code>/${escapeHtml(link.code)}</code><span class="dot-sep"></span>短链名片</p>
    <h1>${escapeHtml(title)}</h1>
    <p class="preview-target mono truncate">${escapeHtml(link.url)}</p>
    <!-- 内联 SVG 而不是 <img src="data:...">：<img> 里的 SVG 不能跟随页面字体与样式，
         而且 data URL 需要额外编码，直接嵌进来最简单也最稳 -->
    <div class="preview-qr" role="img" aria-label="短链二维码">${qr}</div>
    <dl class="preview-meta">
      ${meta.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}
    </dl>
    <div class="preview-actions">
      <a class="btn btn-primary" href="/${escapeHtml(link.code)}">前往目标页面</a>
      <a class="btn btn-ghost" href="${escapeHtml(shortUrl)}">打开短链</a>
    </div>
    <p class="hint">目标链接由本站管理员创建。看不出来源就先别输密码，更别付款——这一步比什么都管用。</p>
    ${reportBlock(link, { canReport, reported })}
  </main>
</div>`;
  return pageShell({
    version: ctx.version,
    title: `/${link.code} · 短链名片`,
    body,
    head: '<meta name="robots" content="noindex, nofollow">',
  });
}
