const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => MAP[ch]);
}

/** 只允许安全协议，供 href 使用 */
export function safeUrl(url) {
  const raw = String(url ?? '').trim();
  if (/^(https?:|mailto:|tel:|\/)/i.test(raw)) return escapeHtml(raw);
  return '#';
}
