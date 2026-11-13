import { pageShell, assetQuery } from './layout.js';
import { escapeHtml } from '../lib/html.js';

export function renderLogin(ctx, { error = '' } = {}) {
  const body = `<div class="auth">
  <form class="auth-card" method="post" action="/login">
    <a class="brand" href="/"><img src="/img/logo.svg" alt="" width="30" height="30">${escapeHtml(ctx.settings.get('siteName'))}</a>
    <h1>登录管理台</h1>
    <p class="sub">使用管理员账号继续</p>
    ${error ? `<div class="banner err" style="margin-bottom:16px">${escapeHtml(error)}</div>` : ''}
    <div class="field">
      <label for="username">用户名</label>
      <input id="username" name="username" autocomplete="username" required autofocus>
    </div>
    <div class="field">
      <label for="password">密码</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
    </div>
    <button class="btn btn-primary" type="submit">登录</button>
    <p class="hint" style="margin-top:14px;text-align:center"><a href="/">返回首页</a></p>
  </form>
</div>`;
  return pageShell({ title: `登录 · ${ctx.settings.get('siteName')}`, body, bodyClass: 'auth-body', version: ctx.version });
}

export function renderInstall(ctx) {
  const body = `<div class="auth">
  <form class="auth-card" method="post" action="/install">
    <a class="brand" href="/"><img src="/img/logo.svg" alt="" width="30" height="30">${escapeHtml(ctx.settings.get('siteName'))}</a>
    <h1>初始化 HighURL</h1>
    <p class="sub">创建第一个管理员账号，完成后即可开始使用</p>
    <div class="field">
      <label for="username">管理员用户名</label>
      <input id="username" name="username" value="admin" autocomplete="username" required minlength="3" maxlength="32">
      <p class="hint">3–32 位，支持字母、数字与 _ . @ -</p>
    </div>
    <div class="field">
      <label for="password">密码</label>
      <input id="password" name="password" type="password" autocomplete="new-password" required minlength="8">
      <p class="hint">至少 8 位，建议包含大小写与数字</p>
    </div>
    <div class="field">
      <label for="siteName">站点名称</label>
      <input id="siteName" name="siteName" value="${escapeHtml(ctx.settings.get('siteName'))}" maxlength="60">
    </div>
    <div class="field">
      <label for="baseUrl">站点地址（可选）</label>
      <input id="baseUrl" name="baseUrl" placeholder="https://s.example.com" inputmode="url">
      <p class="hint">用于生成完整短链接，绑定域名后填写</p>
    </div>
    <button class="btn btn-primary" type="submit">创建并进入</button>
  </form>
</div>`;
  return pageShell({ title: `初始化 · ${ctx.settings.get('siteName')}`, body, bodyClass: 'auth-body', version: ctx.version });
}

// 导航图标用内联 SVG：字符图标在不同系统字体下粗细不一，看着很脏
const ICON = {
  dashboard: '<path d="M4 20v-5M9.3 20V9M14.7 20v-7M20 20V5"/>',
  links: '<path d="M4 12h13M11 6l6 6-6 6"/>',
  sources: '<path d="M4 5h16M7 12h10M10 19h4"/>',
  create: '<path d="M12 5v14M5 12h14"/>',
  rules: '<path d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6z"/>',
  migrate: '<path d="M4 8h14l-3-3M20 16H6l3 3"/>',
  api: '<path d="M9 8 5 12l4 4M15 8l4 4-4 4"/>',
  audit: '<path d="M5 4h14v16H5zM8.5 9h7M8.5 13h7M8.5 17h4"/>',
  backup: '<path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.6M12 18.4V21M3 12h2.6M18.4 12H21M5.6 5.6l1.9 1.9M16.5 16.5l1.9 1.9M18.4 5.6l-1.9 1.9M7.5 16.5l-1.9 1.9"/>',
  groups: '<path d="M4 7a2 2 0 1 0 0-.01M4 17a2 2 0 1 0 0-.01M10 7h10M10 17h10"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
  funnel: '<path d="M4 5h16l-6 7v6l-4 2v-8z"/>',
  report: '<path d="M12 4l8 15H4zM12 10v4M12 16.5v.5"/>',
};

const NAV = [
  ['dashboard', '概览'],
  ['links', '短链'],
  ['groups', '分组'],
  ['sources', '来源分析'],
  ['funnel', '渠道漏斗'],
  ['reports', '举报箱'],
  ['create', '新建'],
  ['rules', 'UA 屏蔽'],
  ['migrate', '数据迁移'],
  ['api', 'API 密钥'],
  ['audit', '审计日志'],
  ['backup', '备份恢复'],
  ['trash', '回收站'],
  ['settings', '系统设置'],
];

export function renderAdminShell(ctx, me) {
  const nav = NAV.map(
    ([key, label]) =>
      `<a class="navlink" href="#/${key}" data-nav="${key}"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICON[key] || ''}</svg><span>${label}</span></a>`,
  ).join('');

  const body = `<div class="shell">
  <aside class="side">
    <a class="brand" href="#/dashboard"><img src="/img/logo.svg" alt="" width="30" height="30">${escapeHtml(ctx.settings.get('siteName'))}</a>
    <nav>${nav}</nav>
    <div class="side-foot">
      <span class="row"><span class="dot" style="width:6px;height:6px;border-radius:50%;background:#34d399"></span> v${escapeHtml(ctx.version || '0.0.0')}</span>
      <span class="truncate">${escapeHtml(me.username)}</span>
      <form method="post" action="/logout"><button class="btn btn-ghost btn-sm" type="submit" style="width:100%">退出登录</button></form>
    </div>
  </aside>
  <main class="main" id="view">
    <div class="empty"><img src="/img/logo.svg" width="42" height="42" alt=""><span>加载中…</span></div>
  </main>
</div>
<div id="toasts"></div>
<script src="/static/admin.js${assetQuery(ctx.version)}" defer></script>`;
  return pageShell({ title: `管理台 · ${ctx.settings.get('siteName')}`, body, bodyClass: 'admin', version: ctx.version });
}
