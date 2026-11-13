/**
 * 内联 SVG 图标。字符图标（◔ ▦ 🗑）在 Linux 上会落到彩色 emoji 字体，
 * 与暗色界面完全不搭，统一换成随文字颜色走的描边图标。
 */
const PATHS = {
  shorten: 'M4 12h13M11 6l6 6-6 6',
  manage: 'M4 6h16M7 12h13M10 18h10',
  timer: 'M12 8v5l3 2M12 21a8 8 0 1 1 0-16 8 8 0 0 1 0 16z',
  title: 'M5 7V5h14v2M12 5v14M9 19h6',
  shield: 'M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6z',
  migrate: 'M4 8h14l-3-3M20 16H6l3 3',
  api: 'M9 8 5 12l4 4M15 8l4 4-4 4',
  server: 'M4 5h16v5H4zM4 14h16v5H4zM7 7.5h.01M7 16.5h.01',
  chart: 'M4 19V9M9.3 19V5M14.7 19v-6M20 19V7',
  pulse: 'M3 12h3.5l2.5-7 4 14 2.5-7H21',
  live: 'M12 12h.01M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z',
  edit: 'M4 20h4l10-10-4-4L4 16zM14 6l4 4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  plus: 'M12 5v14M5 12h14',
  tag: 'M4 12l8-8h8v8l-8 8zM15 9h.01',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
};

/** 生成一个跟随文字颜色的图标；size 为像素 */
export function icon(name, { size = 16, stroke = 1.9, cls = '' } = {}) {
  const klass = cls ? ` class="${cls}"` : '';
  const d = PATHS[name];
  const body = d ? `<path d="${d}"/>` : '';
  return `<svg${klass} viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
