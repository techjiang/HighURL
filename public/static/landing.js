// 落地页：公开创建（仅在站点开启 publicCreate 时生效）
(() => {
  const form = document.getElementById('shorten-form');
  if (!form) return;
  const input = document.getElementById('url-input');
  const result = document.getElementById('result');

  const show = (html, cls = '') => {
    result.hidden = false;
    result.innerHTML = html;
    if (cls) result.className = `result ${cls}`;
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const url = input.value.trim();
    if (!url) return;
    const button = form.querySelector('button');
    button.disabled = true;
    button.textContent = '处理中…';
    try {
      const res = await fetch('/api/shorten', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data?.error?.message || '创建失败');
      const short = data.result.shortUrl;
      show(`<div class="result-card">
        <div style="flex:1;min-width:0">
          <div class="muted" style="font-size:12px">短链接</div>
          <div class="short">${escapeHtml(short)}</div>
        </div>
        <button class="btn btn-primary btn-sm" type="button" id="copy-short">复制</button>
        <a class="btn btn-ghost btn-sm" href="${escapeHtml(short)}" target="_blank" rel="noopener">打开</a>
      </div>`);
      document.getElementById('copy-short').addEventListener('click', async (e) => {
        await navigator.clipboard.writeText(short).catch(() => {});
        e.target.textContent = '已复制';
        setTimeout(() => (e.target.textContent = '复制'), 1500);
      });
      input.value = '';
      document.querySelectorAll('.stat b')[0].textContent = String(Number(document.querySelectorAll('.stat b')[0].textContent) + 1);
    } catch (err) {
      show(`<div class="result-card" style="border-color:rgba(248,113,113,.4);background:rgba(248,113,113,.08)">
        <span style="color:#ffc9c9">${escapeHtml(err.message)}</span></div>`);
    } finally {
      button.disabled = false;
      button.textContent = '缩短';
    }
  });
})();

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
