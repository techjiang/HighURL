import { pageShell } from './layout.js';
import { escapeHtml } from '../lib/html.js';

/** 统一的提示页：404 / 410 / 403 / 密码页 / 错误页 */
export function renderMessage(ctx, { status = 400, title, desc = '', code = '', form = null, logo = true }) {
  const badge = status ? `<span class="msg-status">${status}</span>` : '';
  const formHtml = form
    ? `<form class="msg-form" action="${escapeHtml(form.action)}" method="post">
         <input type="password" name="password" placeholder="访问密码" autocomplete="current-password" required autofocus>
         <button type="submit" class="btn btn-primary">解锁</button>
       </form>`
    : '';
  const home = `<a class="btn btn-ghost" href="/">返回首页</a>`;
  const body = `<main class="msg-wrap">
  <div class="msg-card">
    ${logo ? `<img class="msg-logo" src="/img/logo.svg" alt="" width="56" height="56">` : ''}
    ${badge}
    <h1>${escapeHtml(title)}</h1>
    ${desc ? `<p>${escapeHtml(desc)}</p>` : ''}
    ${code ? `<code class="msg-code">/${escapeHtml(code)}</code>` : ''}
    ${formHtml}
    ${home}
  </div>
</main>`;
  return pageShell({ title: `${title} · ${ctx.settings.get('siteName')}`, body, bodyClass: 'page-msg', version: ctx.version });
}
