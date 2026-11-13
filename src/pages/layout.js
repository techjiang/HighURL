import { escapeHtml } from '../lib/html.js';

/**
 * 静态资源带上进程启动时的版本号。
 *
 * 不只为了「部署后立刻拿到新样式」，更为了**跨主题的那几个颜色**：
 * 落地页浅色主题的标题色、按钮文字色都是后加的，浏览器一旦缓存了旧的
 * app.css，页面结构是对的、只是文字看不见——这种缺陷最容易被当成「设计就这样」漏掉。
 */
export function assetQuery(version) {
  return version ? `?v=${encodeURIComponent(String(version))}` : '';
}

export function pageShell({ title, body, bodyClass = '', head = '', script = '', version = '' }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(title)}</title>
<meta name="color-scheme" content="dark light">
<link rel="icon" href="/img/favicon.ico" sizes="any">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/img/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#0B0A1F">
<link rel="stylesheet" href="/static/app.css${assetQuery(version)}">
${head}
</head>
<body class="${escapeHtml(bodyClass)}">
${body}
${script}
</body>
</html>`;
}
