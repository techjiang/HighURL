/* HighURL 管理台 · 原生 JS 单页应用 */
'use strict';

const state = {
  me: null,
  view: 'dashboard',
  links: { page: 1, q: '', status: '', sort: 'created_desc', tag: '', group: '', health: '', heat: '', expiring: '' },
  audit: { page: 1, filter: '' },
  trash: { page: 1 },
};
/** 跨页保存的批量选择 */
const selected = new Set();

/* ---------- 基础工具 ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 内联图标：字符图标在 Linux 会渲染成彩色 emoji，与暗色界面冲突 */
const ICONS = {
  chart: 'M4 19V9M9.3 19V5M14.7 19v-6M20 19V7',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z',
  edit: 'M4 20h4l10-10-4-4L4 16zM14 6l4 4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6 6 18',
  folder: 'M4 7a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z',
  restore: 'M4 12a8 8 0 1 0 3-6.2M4 4v5h5',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  sheet: 'M6 3h9l3 3v15H6zM15 3v3h3M9 11h6M9 15h6',
  pulse: 'M3 12h3.5l2.5-7 4 14 2.5-7H21',
  shield: 'M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6z',
  refresh: 'M20 11a8 8 0 1 0-2.6 6M20 5v6h-6',
  split: 'M6 4v5a4 4 0 0 0 4 4h4M18 4v5a4 4 0 0 1-4 4M12 13v7M9 17l3 3 3-3',
  history: 'M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4M12 8v4l3 2',
  trend: 'M4 17l5-6 3.5 3L20 6M20 6h-4.5M20 6v4.5',
  alert: 'M12 4l8 15H4zM12 10v4M12 16.5v.5',
  info: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 11v5M12 8v.5',
  clock: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4.3l2.8 1.7',
};

function ic(name, size = 15) {
  const d = ICONS[name];
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d ? `<path d="${d}"/>` : ''}</svg>`;
}

function toast(message, kind = '') {
  const box = document.createElement('div');
  box.className = `toast ${kind}`;
  box.textContent = message;
  $('#toasts').appendChild(box);
  setTimeout(() => {
    box.style.opacity = '0';
    box.style.transition = 'opacity .2s';
    setTimeout(() => box.remove(), 220);
  }, 2600);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('未登录');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data?.error?.message || `请求失败 (${res.status})`);
  }
  return data;
}

function num(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
  return v.toLocaleString('zh-CN');
}

/** 自定义文件选择器：显示选中的文件名 */
function bindFileName(input) {
  const wrap = input.closest('.file-field');
  if (!wrap) return;
  const file = input.files?.[0];
  wrap.classList.toggle('has-file', Boolean(file));
  const name = wrap.querySelector('.file-name');
  if (name) name.textContent = file ? `${file.name}（${(file.size / 1024).toFixed(1)} KB）` : '未选择任何文件';
}

function timeAgo(ts) {
  if (!ts) return '—';
  const diff = Date.now() - Number(ts);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(Number(ts)).toLocaleDateString('zh-CN');
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${v} B`;
}

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(Number(ts)).toLocaleString('zh-CN', { hour12: false });
}

/** 到期时间：到分钟就够，秒数对「这条还能用多久」这个判断没有任何帮助 */
function fmtExpire(ts) {
  const d = new Date(Number(ts));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板', 'ok');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('已复制', 'ok');
  }
}

/* ---------- 弹窗 ---------- */
/** 触发一次下载：走 a 标签而不是 location，避免 SPA 被导航走 */
function download(href) {
  const a = document.createElement('a');
  a.href = href;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function modal({ title, bodyHtml, confirmText = '保存', danger = false, onConfirm, wide = false, cancelText = '取消' }) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  // 纯展示型弹窗（cancelText 传 null）不摆「取消」——没有可以取消的动作
  mask.innerHTML = `<div class="modal" ${wide ? 'style="width:min(760px,100%)"' : ''}>
    <header><h3>${esc(title)}</h3><button class="btn btn-ghost btn-sm btn-icon" data-close aria-label="关闭">${ic('close')}</button></header>
    <div class="modal-body">${bodyHtml}</div>
    <footer>
      ${cancelText ? `<button class="btn btn-ghost" data-close>${esc(cancelText)}</button>` : ''}
      ${onConfirm ? `<button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(confirmText)}</button>` : ''}
    </footer>
  </div>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('[data-close]')) close();
  });
  const ok = $('[data-ok]', mask);
  if (ok) {
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      try {
        const keep = await onConfirm(mask);
        if (keep !== false) close();
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        ok.disabled = false;
      }
    });
  }
  const first = mask.querySelector('input, textarea, select');
  if (first) first.focus();
  return { close, el: mask };
}

/**
 * 二次确认。按钮文案必须由调用方给：写死「确认删除」的话，
 * 恢复备份这种非破坏性操作也会顶着一个「确认删除」，看着就让人不敢点。
 */
function confirmDialog(title, text, onOk, { confirmText = '确定', danger = true } = {}) {
  modal({ title, bodyHtml: `<p class="dim">${esc(text)}</p>`, confirmText, danger, onConfirm: onOk });
}

/* ---------- 实时访问流 ---------- */
/**
 * 管理台的实时面板。用 EventSource 挂在 /admin/api/stream 上。
 *
 * 两个坑都在这处理了：
 * 1. 页面切走时必须关掉连接，不然每切一次标签就多一条长连接，浏览器的
 *    同域连接数（6 条）很快被吃光，之后的请求会全部排队。
 * 2. 代理可能把 SSE 缓冲住（Nginx 默认 buffering on），表现为「连上了但没数据」。
 *    EventSource 的 onerror 不区分这种情况，所以额外挂了超时兜底：连上后
 *    30 秒内一条都没收到，就退化成轮询。
 */
let liveSource = null;

function closeLiveFeed() {
  if (liveSource) {
    liveSource.close();
    liveSource = null;
  }
  if (livePollTimer) {
    clearInterval(livePollTimer);
    livePollTimer = null;
  }
}
let livePollTimer = null;

const OUTCOME_LABEL = {
  redirect: ['跳转', 'tag-ok'],
  deduped: ['去重未计', 'tag'],
  locked: ['需要密码', 'tag-warn'],
  expired: ['已过期', 'tag-warn'],
  disabled: ['已停用', 'tag-err'],
  blocked: ['已拦截', 'tag-err'],
};

function visitRow(v) {
  const [label, cls] = OUTCOME_LABEL[v.outcome] || OUTCOME_LABEL.redirect;
  const secs = Math.max(0, Math.round((Date.now() - v.at) / 1000));
  const when = secs < 5 ? '刚刚' : secs < 60 ? `${secs} 秒前` : timeAgo(v.at);
  return `<div class="feed-item live-item" data-id="${v.id}">
    <span class="tag ${cls}">${esc(label)}</span>
    <div class="min0">
      <b class="mono">/${esc(v.code)}</b>
      <span class="truncate muted">${esc(v.ref || '直接访问')} · ${esc(PLATFORM_LABEL[v.platform] || v.platform || '未知')} · ${esc(v.ip || '—')}</span>
    </div>
    <span class="muted nowrap">${esc(when)}</span>
  </div>`;
}

function mountLiveFeed(initial = []) {
  closeLiveFeed();
  const list = $('#live-list');
  if (!list) return;
  let total = 0;

  const render = (items) => {
    if (!items.length) {
      list.innerHTML = '<p class="muted">还没有访问。把一条短链打开试试，这里会立刻出现。</p>';
      return;
    }
    list.innerHTML = items.map(visitRow).join('');
  };

  const setState = (text, kind = '') => {
    const el = $('#live-state');
    if (el) {
      el.textContent = text;
      el.className = `tag ${kind}`;
    }
    const dot = $('#live-dot');
    if (dot) dot.classList.toggle('on', kind === 'tag-ok');
  };

  const push = (v) => {
    total += 1;
    const el = $('#live-count');
    if (el) el.textContent = `已接收 ${total} 条`;
    const empty = list.querySelector('p.muted');
    if (empty) list.innerHTML = '';
    list.insertAdjacentHTML('afterbegin', visitRow(v));
    // 只保留最近 30 条，DOM 节点别无限涨
    while (list.children.length > 30) list.lastElementChild.remove();
  };

  render(initial);

  const paused = () => $('#live-pause')?.dataset.paused === '1';
  const startPolling = () => {
    if (livePollTimer) return;
    setState('轮询中', 'tag-warn');
    livePollTimer = setInterval(async () => {
      if (paused()) return;
      try {
        const { result } = await api('/admin/api/stream/recent?limit=20');
        render(result.items || []);
      } catch {
        /* 下一轮再试 */
      }
    }, 5000);
  };

  try {
    liveSource = new EventSource('/admin/api/stream');
    let received = false;
    liveSource.onopen = () => {
      setState('已连接', 'tag-ok');
    };
    liveSource.onmessage = (ev) => {
      received = true;
      if (paused()) return;
      try {
        push(JSON.parse(ev.data));
      } catch {
        /* 坏数据跳过 */
      }
    };
    liveSource.onerror = () => {
      // CONNECTING 表示浏览器自己在重连，别急着降级
      if (liveSource && liveSource.readyState === EventSource.CONNECTING) {
        setState('重连中', 'tag-warn');
        return;
      }
      setState('已断开', 'tag-err');
      startPolling();
    };
    setTimeout(() => {
      if (!received && liveSource) startPolling();
    }, 30000);
  } catch {
    startPolling();
  }

  $('#live-pause')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const next = btn.dataset.paused === '1' ? '0' : '1';
    btn.dataset.paused = next;
    btn.textContent = next === '1' ? '继续' : '暂停';
    setState(next === '1' ? '已暂停' : '已连接', next === '1' ? '' : 'tag-ok');
  });
}

/**
 * 运营日报：概览顶部那一条。
 *
 * 只报变化和需要动手的事，不给「一切正常」的漂亮话——用户打开管理台是来
 * 找问题的，不是来被安慰的。空数组时整块不渲染，概览不会凭空多出一个空框。
 */
function digestBlock(d) {
  if (!d || !d.items.length) return '';
  const cls = d.level === 'warn' ? 'warn' : '';
  // 两类结论在视觉上要分开：「涨了/持平」是信息，「有人投诉、有死链」是该现在动手的
  const info = d.items.filter((i) => i.kind !== 'warn');
  const todo = d.items.filter((i) => i.kind === 'warn');
  const row = (i) => {
    const icoName = i.kind === 'warn' ? 'alert' : i.kind === 'up' || i.kind === 'down' ? 'trend' : 'info';
    return `<a class="digest-item k-${esc(i.kind)}" href="${esc(i.link || '#/dashboard')}">
        <span class="digest-ico">${ic(icoName, 14)}</span>
        <span class="digest-text">${esc(i.text)}</span>
        ${i.value ? `<b class="digest-val mono">${esc(i.value)}</b>` : ''}
      </a>`;
  };
  const todoTitle = todo.length ? `<p class="digest-sub">待处理 ${todo.length} 项</p>${todo.map(row).join('')}` : '';
  return `<section class="card digest ${cls}">
    <div class="card-head"><h2>本期要点</h2><span class="tag">${esc(digestSpan(d.hours))} · 点任意一条进入对应页面</span></div>
    <div class="card-body digest-list">${info.map(row).join('')}${todoTitle}</div>
  </section>`;
}

function digestSpan(hours) {
  const days = Math.round(hours / 24);
  if (days <= 1) return '今天对比昨天';
  return `近 ${days} 天对比前 ${days} 天`;
}

/**
 * 热点榜：最近 24 小时新增点击最多的几条，带窗口内曝光。
 *
 * 用「窗口新增」而不是累计点击数：累计榜永远是那几条老的，
 * 而这条榜单要回答的是「现在什么在被点」。曝光那一列是为了区分
 * 「没人来」和「来了没进来」——这两种情况要做的处理完全相反。
 */
function hotRows(items) {
  if (!items || !items.length) {
    return '<p class="muted">最近 24 小时还没有点击。短链被访问后这里会实时排出来。</p>';
  }
  const max = Math.max(1, ...items.map((i) => i.windowClicks));
  return items
    .map(
      (i) => `<div class="hot-row">
      <span class="hot-badge">${num(i.windowClicks)}</span>
      <div class="min0">
        <a class="hot-title truncate" href="#/links?q=${encodeURIComponent(i.code)}">${esc(i.title || '/' + i.code)}</a>
        <div class="hot-meta">
          <span class="mono">/${esc(i.code)}</span>
          ${i.group ? `<span class="tag tag-brand">${esc(i.group.name)}</span>` : ''}
          <span class="muted">${i.windowViews ? `曝光 ${num(i.windowViews)} 次` : '没有建页曝光'}</span>
        </div>
        <span class="hot-bar"><i style="width:${Math.max(3, (i.windowClicks / max) * 100)}%"></i></span>
      </div>
      <span class="muted nowrap">${i.lastClickAt ? timeAgo(i.lastClickAt) : '—'}</span>
    </div>`,
    )
    .join('');
}

/* ---------- 视图：概览 ---------- */
async function viewDashboard(root) {
  const { result } = await api('/admin/api/overview');
  // 只读账号看到的第一句话就该说明这件事：不然他会点五个按钮，
  // 每个都回一句「无权限」，然后以为是系统坏了
  const roBanner = state.me?.readonly
    ? '<div class="banner" style="margin-bottom:14px">当前账号为<b>只读</b>权限：数据都能看，改动一律不生效。需要写权限请让管理员在「账号」页调整。</div>'
    : '';
  const max = Math.max(1, ...result.daily.map((d) => d.clicks));
  const bars = result.daily
    .map((d) => `<div class="bar" style="height:${Math.max(3, (d.clicks / max) * 100)}%" title="${esc(d.day)} · ${d.clicks} 次"></div>`)
    .join('');
  const axis = result.daily.length
    ? `<div class="bars-axis"><span>${esc(result.daily[0].day.slice(5))}</span><span>${esc(result.daily[result.daily.length - 1].day.slice(5))}</span></div>`
    : '';

  const topRows = result.top.length
    ? result.top
        .map(
          (l) => `<tr>
        <td><div class="cell-title"><b class="truncate">${esc(l.title || l.url)}</b><span class="cell-url">/${esc(l.code)}</span></div></td>
        <td style="text-align:right" class="mono">${num(l.clicks)}</td>
      </tr>`,
        )
        .join('')
    : '<tr><td colspan="2" class="muted">还没有数据</td></tr>';

  const activity = (result.activity || []).length
    ? result.activity
        .map(
          (a) => `<div class="feed-item">
        <span class="dot"></span>
        <div class="min0"><b>${esc(ACTION_LABEL[a.action] || a.action)}</b><span class="truncate muted"> ${esc(a.detail || '')}</span></div>
        <span class="muted nowrap">${timeAgo(a.at)}</span>
      </div>`,
        )
        .join('')
    : '<p class="muted">暂无操作记录</p>';

  // 分组分布：最多展示 6 个，剩下的归到「其它分组」，避免排行条把卡片拉太长
  const gs = result.groups || [];
  const topGroups = gs.slice(0, 6);
  const gTotal = gs.reduce((s2, g) => s2 + g.links, 0) + (result.ungrouped || 0);
  const gMax = Math.max(1, ...topGroups.map((g) => g.links), result.ungrouped || 0);
  const groupRow = (label, count, color) => `<div class="rank">
      <span class="rank-name truncate"><i class="dotcolor" style="background:${color || 'rgba(139,152,214,.45)'}"></i>${esc(label)}</span>
      <span class="rank-bar"><i style="width:${count ? Math.max(2, (count / gMax) * 100) : 0}%"></i></span>
      <span class="rank-num mono">${num(count)}</span>
    </div>`;
  const groupBars = gTotal
    ? topGroups.map((g) => groupRow(g.name, g.links, g.color)).join('') +
      groupRow('未分组', result.ungrouped || 0, '') +
      (gs.length > 6 ? `<p class="hint">另有 ${gs.length - 6} 个分组，去「分组」页看全部</p>` : '')
    : '<p class="muted">还没有分组，去「分组」页建一个，比如「官网」「活动页」。</p>';

  const h = result.health || { counts: { ok: 0, warn: 0, dead: 0, unknown: 0 }, total: 0, broken: [] };
  const checked = h.counts.ok + h.counts.warn + h.counts.dead;
  const brokenTargets = h.brokenTargets || [];
  const brokenRows = (h.broken || []).length || brokenTargets.length
    ? (h.broken || [])
        .map(
          (l) => `<div class="feed-item">
        <span class="dot dot-err"></span>
        <div class="min0"><b>/${esc(l.code)}</b><span class="truncate muted"> ${esc(l.health_error || '目标地址不可达')}</span></div>
        <span class="muted nowrap">${l.health_miss} 次</span>
      </div>`,
        )
        .concat(
          brokenTargets.map(
            (t) => `<div class="feed-item">
        <span class="dot dot-err"></span>
        <div class="min0"><b>/${esc(t.code)}</b><span class="truncate muted"> 分流目标 ${esc(t.label || t.url)} · ${esc(t.health_error || '不可达')}</span></div>
        <span class="muted nowrap">${t.health_miss} 次</span>
      </div>`,
          ),
        )
        .join('')
    : checked
      ? '<p class="muted">没有检测出死链。</p>'
      : '<p class="muted">还没有巡检过，去「短链」页点「巡检目标链接」。</p>';

  root.innerHTML = `
  <div class="topbar"><div><h1>概览</h1><div class="sub">最近 14 天运行情况</div></div><span class="spacer"></span>
    <button class="btn btn-ghost btn-sm" id="flush-btn">立即落库计数</button>
    <a class="btn btn-primary btn-sm" href="#/create" data-writes>${ic('plus')} 新建短链</a>
  </div>
  ${roBanner}
  ${digestBlock(result.digest)}
  <div class="grid-cards">
    <div class="kpi"><div class="label">短链总数</div><div class="value">${num(result.total)}</div><div class="delta">${num(result.active)} 条生效中 · 今日新增 ${num(result.todayNew || 0)}</div></div>
    <div class="kpi"><div class="label">累计点击</div><div class="value">${num(result.clicks)}</div><div class="delta">今日 ${num(result.todayClicks)}</div></div>
    <div class="kpi"><div class="label">待落库点击</div><div class="value">${num(result.counter.pendingClicks)}</div><div class="delta">${num(result.counter.bufferedKeys)} 个短码在缓冲</div></div>
    <div class="kpi"><div class="label">缓存命中率</div><div class="value">${(result.cache.hitRate * 100).toFixed(1)}%</div><div class="delta">${num(result.cache.size)} 条热数据</div></div>
  </div>
  <div class="split">
    <section class="card chart-card">
      <div class="card-head"><h2>点击趋势</h2><span class="tag">${num(result.daily.reduce((s, d) => s + d.clicks, 0))} 次</span></div>
      <div class="card-body"><div class="bars-wrap"><div class="bars">${bars}</div>${axis}</div></div>
    </section>
    <section class="card">
      <div class="card-head"><h2>热门短链</h2><a class="btn btn-ghost btn-sm" href="#/links">全部</a></div>
      <div class="table-wrap"><table class="tbl-top"><tbody>${topRows}</tbody></table></div>
    </section>
  </div>
  <section class="card" style="margin-top:18px">
    <div class="card-head">
      <h2>热点榜</h2>
      <span class="row" style="gap:8px">
        <span class="tag">最近 24 小时新增点击</span>
        <a class="btn btn-ghost btn-sm" href="#/links?sort=recent">按热度看全部</a>
      </span>
    </div>
    <div class="card-body stack" style="gap:12px">${hotRows(result.hot)}</div>
  </section>
  <div class="split" style="margin-top:18px">
    <section class="card live-card">
      <div class="card-head">
        <h2>实时访问</h2>
        <span class="row" style="gap:8px">
          <span class="live-dot" id="live-dot" title="连接状态"></span>
          <span class="tag" id="live-state">连接中</span>
          <button class="btn btn-ghost btn-sm" id="live-pause">暂停</button>
        </span>
      </div>
      <div class="card-body feed live-feed" id="live-list"></div>
      <div class="live-foot"><span class="muted" id="live-count">还没有访问</span><span class="spacer"></span><span class="muted">IP 已脱敏</span></div>
    </section>
    <section class="card">
      <div class="card-head"><h2>链接健康</h2><a class="btn btn-ghost btn-sm" href="#/links?health=dead">查看死链</a></div>
      <div class="card-body stack" style="gap:12px">
        <div class="health-bar">
          <i class="hb-ok" style="flex:${h.counts.ok || 0}"></i>
          <i class="hb-warn" style="flex:${h.counts.warn || 0}"></i>
          <i class="hb-dead" style="flex:${h.counts.dead || 0}"></i>
          <i class="hb-unknown" style="flex:${h.counts.unknown || 0}"></i>
        </div>
        <div class="health-legend">
          <span><i class="dotcolor" style="background:var(--ok)"></i>正常 ${num(h.counts.ok)}</span>
          <span><i class="dotcolor" style="background:var(--warn)"></i>疑似失效 ${num(h.counts.warn)}</span>
          <span><i class="dotcolor" style="background:var(--err)"></i>死链 ${num(h.counts.dead)}</span>
          <span><i class="dotcolor" style="background:rgba(139,152,214,.45)"></i>未检测 ${num(h.counts.unknown)}</span>
        </div>
        ${h.targets?.total ? `<div class="health-legend" style="margin-top:2px">
          <span class="muted">分流目标 ${num(h.targets.total)} 个</span>
          <span><i class="dotcolor" style="background:var(--ok)"></i>${num(h.targets.counts.ok)}</span>
          <span><i class="dotcolor" style="background:var(--warn)"></i>${num(h.targets.counts.warn)}</span>
          <span><i class="dotcolor" style="background:var(--err)"></i>${num(h.targets.counts.dead)}</span>
          <span><i class="dotcolor" style="background:rgba(139,152,214,.45)"></i>${num(h.targets.counts.unknown)}</span>
        </div>` : ''}
      </div>
      <div class="card-body feed" style="padding-top:0">${brokenRows}</div>
    </section>
  </div>
  <div class="split" style="margin-top:18px">
    <section class="card">
      <div class="card-head"><h2>分组分布</h2><a class="btn btn-ghost btn-sm" href="#/groups">管理分组</a></div>
      <div class="card-body stack" style="gap:10px">${groupBars}</div>
    </section>
    <section class="card">
      <div class="card-head"><h2>最近操作</h2><a class="btn btn-ghost btn-sm" href="#/audit">全部记录</a></div>
      <div class="card-body feed">${activity}</div>
    </section>
  </div>
  <section class="card" style="margin-top:18px">
    <div class="card-head"><h2>访问时段</h2><span class="tag">星期 × 小时 · 累计</span></div>
    <div class="card-body">${hourHeat(result.hours)}</div>
  </section>`;

  mountLiveFeed(result.visits || []);

  $('#flush-btn').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const { result: r } = await api('/admin/api/flush', { method: 'POST' });
      toast(`已落库 ${r.flushed} 次点击`, 'ok');
      render();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      e.target.disabled = false;
    }
  });
}

/* ---------- 视图：短链列表 ---------- */
async function viewLinks(root) {
  const { page, q, status, sort, tag, group, health, heat, expiring } = state.links;
  const params = new URLSearchParams({ page, q, status, sort, perPage: 20 });
  if (tag) params.set('tag', tag);
  if (group) params.set('group', group);
  if (health) params.set('health', health);
  if (heat) params.set('heat', heat);
  if (expiring) params.set('expiring', expiring);
  const { result } = await api(`/admin/api/links?${params}`);
  state.links.page = result.page;
  // 页码越界（删完最后一页）时回退一页重来
  if (result.page > result.pages) {
    state.links.page = result.pages;
    return viewLinks(root);
  }

  const groupChips = `<div class="tagbar"><span class="muted">分组</span>
      <button class="chip ${group ? '' : 'on'}" data-group="">全部</button>
      ${(result.groups || [])
        .map(
          (g) => `<button class="chip ${String(group) === String(g.id) ? 'on' : ''}" data-group="${g.id}">
            <i class="dotcolor" style="background:${esc(g.color || 'rgba(139,152,214,.5)')}"></i>${esc(g.name)}<i>${g.links}</i>
          </button>`,
        )
        .join('')}
      <button class="chip ${group === 'none' ? 'on' : ''}" data-group="none">未分组<i>${result.ungrouped || 0}</i></button>
    </div>`;

  const tagChips = result.tags.length
    ? `<div class="tagbar"><span class="muted">标签</span>
        <button class="chip ${tag ? '' : 'on'}" data-tag="">全部</button>
        ${result.tags
          .map((t) => `<button class="chip ${tag === t.tag ? 'on' : ''}" data-tag="${esc(t.tag)}">${esc(t.tag)}<i>${t.count}</i></button>`)
          .join('')}
      </div>`
    : '';

  const hs = result.health?.counts || { ok: 0, warn: 0, dead: 0, unknown: 0 };
  // 四种状态都要能筛。以前少了「疑似失效」这一档，巡检完看到徽章却筛不出来
  const healthChips = `<div class="tagbar"><span class="muted">健康</span>
      <button class="chip ${health ? '' : 'on'}" data-health="">全部</button>
      <button class="chip ${health === 'dead' ? 'on' : ''}" data-health="dead"><i class="dotcolor" style="background:var(--err)"></i>死链<i>${hs.dead}</i></button>
      <button class="chip ${health === 'warn' ? 'on' : ''}" data-health="warn"><i class="dotcolor" style="background:var(--warn)"></i>疑似失效<i>${hs.warn}</i></button>
      <button class="chip ${health === 'ok' ? 'on' : ''}" data-health="ok"><i class="dotcolor" style="background:var(--ok)"></i>正常<i>${hs.ok}</i></button>
      <button class="chip ${health === 'unknown' ? 'on' : ''}" data-health="unknown"><i class="dotcolor" style="background:rgba(139,152,214,.45)"></i>未检测<i>${hs.unknown}</i></button>
    </div>`;

  // 热度筛选：和健康一样是一眼要能读过筛的条件，但基准是「全库最高点击数」而不是绝对值
  const heatChips = `<div class="tagbar"><span class="muted">热度</span>
      <button class="chip ${heat ? '' : 'on'}" data-heat="">全部</button>
      <button class="chip ${heat === 'hot' ? 'on' : ''}" data-heat="hot"><i class="dotcolor" style="background:var(--err)"></i>热门</button>
      <button class="chip ${heat === 'warm' ? 'on' : ''}" data-heat="warm"><i class="dotcolor" style="background:var(--warn)"></i>有热度</button>
    </div>`;

  // 到期：链接失效是「事后才知道」的典型，所以这一行要在链路上主动摆出来，
  // 而不是等人自己想起来去翻有效期
  const expiryChips = `<div class="tagbar"><span class="muted">到期</span>
      <button class="chip ${expiring ? '' : 'on'}" data-expiring="">全部</button>
      <button class="chip ${expiring === '7' ? 'on' : ''}" data-expiring="7">7 天内到期</button>
      <button class="chip ${expiring === '30' ? 'on' : ''}" data-expiring="30">30 天内到期</button>
      <button class="chip ${status === 'expired' ? 'on' : ''}" data-expired="1">已过期</button>
    </div>`;

  const rows = result.items.length
    ? result.items
        .map(
          (l) => `<tr data-code="${esc(l.code)}" class="${selected.has(l.code) ? 'picked' : ''}">
      <td style="width:1%"><input type="checkbox" class="pick" ${selected.has(l.code) ? 'checked' : ''} aria-label="选择 /${esc(l.code)}"></td>
      <td style="width:40%">
        <div class="cell-title">
          <b class="truncate">${esc(l.title || '(无标题)')}</b>
          <span class="cell-url mono">${esc(l.url)}</span>
        </div>
      </td>
      <td>
        <button class="btn btn-ghost btn-sm copy-btn" data-copy="${esc(l.shortUrl)}" title="点击复制">/${esc(l.code)}</button>
        ${l.targetCount > 1 ? `<span class="tag tag-brand" style="margin-left:4px" title="有 ${l.targetCount} 个分流目标">A/B ${l.targetCount}</span>` : ''}
        ${l.group ? `<span class="tag tag-brand" style="margin-left:4px">${esc(l.group.name)}</span>` : ''}
        ${l.tags.map((t) => `<span class="tag" style="margin-left:4px">${esc(t)}</span>`).join('')}
      </td>
      <td class="mono" style="text-align:right">${num(l.clicks)}</td>
      <td>
        ${statusBadge(l)}
        ${l.protected ? '<span class="tag tag-warn">密码</span>' : ''}
        ${healthBadge(l)}
      </td>
      <td class="muted" style="white-space:nowrap">${timeAgo(l.createdAt)}</td>
      <td style="width:1%">
        <div class="row">
          <button class="btn btn-ghost btn-sm btn-icon" data-act="health" title="检测目标链接" aria-label="检测目标链接">${ic('pulse')}</button>
          <button class="btn btn-ghost btn-sm btn-icon" data-act="stats" title="统计" aria-label="统计">${ic('chart')}</button>
          <button class="btn btn-ghost btn-sm btn-icon" data-act="qr" title="二维码" aria-label="二维码">${ic('qr')}</button>
          <button class="btn btn-ghost btn-sm btn-icon" data-act="history" title="变更历史" aria-label="变更历史">${ic('history')}</button>
          <button class="btn btn-ghost btn-sm btn-icon" data-act="renew" data-writes title="续期" aria-label="续期">${ic('clock')}</button>
          <button class="btn btn-ghost btn-sm btn-icon" data-act="edit" data-writes title="编辑" aria-label="编辑">${ic('edit')}</button>
          <button class="btn btn-ghost btn-sm btn-icon" data-act="del" data-writes title="删除" aria-label="删除">${ic('trash')}</button>
        </div>
      </td>
    </tr>`,
        )
        .join('')
    : `<tr><td colspan="7"><div class="empty"><img src="/img/logo.svg" width="40" height="40" alt=""><b>没有匹配的短链</b><span class="muted">换个搜索词，或新建一条</span></div></td></tr>`;

  const allPicked = result.items.length > 0 && result.items.every((l) => selected.has(l.code));

  root.innerHTML = `
  <div class="topbar"><div><h1>短链</h1><div class="sub">共 ${num(result.total)} 条</div></div><span class="spacer"></span>
    <a class="btn btn-primary btn-sm" href="#/create" data-writes>${ic('plus')} 新建</a>
  </div>
  <div class="toolbar">
    <input type="search" id="search" placeholder="搜索短码 / 链接 / 标题 / 备注" value="${esc(q)}">
    <select id="status-filter">
      ${[
        ['', '全部状态'],
        ['active', '生效中'],
        ['disabled', '已停用'],
        ['expired', '已过期'],
      ]
        .map(([v, t]) => `<option value="${v}" ${status === v ? 'selected' : ''}>${t}</option>`)
        .join('')}
    </select>
    <select id="sort-filter">
      ${[
        ['created_desc', '最新创建'],
        ['created_asc', '最早创建'],
        ['clicks_desc', '点击最多'],
        ['clicks_asc', '点击最少'],
        ['updated_desc', '最近更新'],
        ['code_asc', '短码 A→Z'],
        ['health_asc', '健康度优先'],
        ['health_at_asc', '最久未检测'],
        ['recent_desc', '最近 24 小时热度'],
      ]
        .map(([v, t]) => `<option value="${v}" ${sort === v ? 'selected' : ''}>${t}</option>`)
        .join('')}
    </select>
    <span class="spacer"></span>
    <button class="btn btn-ghost btn-sm" id="health-btn" data-writes title="立刻检查目标链接是否还能打开">${ic('pulse')} 巡检目标链接</button>
    <button class="btn btn-ghost btn-sm" id="sweep-btn" data-writes title="按设置里的策略处理已过期短链">回收过期</button>
    <button class="btn btn-ghost btn-sm" id="qr-all-btn" title="把当前筛选结果全部打包成 ZIP">${ic('qr')} 批量二维码</button>
    <button class="btn btn-ghost btn-sm" id="qr-sheet-btn" title="排成可打印的 A4 拼版 PDF">${ic('sheet')} 拼版打印</button>
    <a class="btn btn-ghost btn-sm" href="/admin/api/export.csv">导出 CSV</a>
  </div>
  ${groupChips}
  ${tagChips}
  ${healthChips}
  ${heatChips}
  ${expiryChips}
  <div id="batchbar"></div>
  <div class="card">
    <div class="table-wrap">
      <table class="tbl-links">
        <thead><tr>
          <th><input type="checkbox" id="pick-all" ${allPicked ? 'checked' : ''} aria-label="全选本页"></th>
          <th>标题 / 目标链接</th><th>短码</th><th style="text-align:right">点击</th><th>状态</th><th>创建</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="pager">
      <span>第 ${result.page} / ${result.pages} 页 · 共 ${num(result.total)} 条</span>
      <button class="btn btn-ghost btn-sm" data-page="prev" ${result.page <= 1 ? 'disabled' : ''}>上一页</button>
      <button class="btn btn-ghost btn-sm" data-page="next" ${result.page >= result.pages ? 'disabled' : ''}>下一页</button>
    </div>
  </div>`;

  const renderBatch = () => {
    const bar = $('#batchbar');
    if (!bar) return;
    if (!selected.size) {
      bar.innerHTML = '';
      return;
    }
    bar.innerHTML = `<div class="batchbar">
      <b>已选 ${selected.size} 条</b>
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-sm" data-batch="qr">${ic('qr')} 二维码</button>
      <button class="btn btn-ghost btn-sm" data-batch="sheet">${ic('sheet')} 拼版打印</button>
      <button class="btn btn-ghost btn-sm" data-batch="group">${ic('folder')} 改分组</button>
      <button class="btn btn-ghost btn-sm" data-batch="tags">改标签</button>
      <button class="btn btn-ghost btn-sm" data-batch="renew">${ic('clock')} 续期</button>
      <button class="btn btn-ghost btn-sm" data-batch="enable">启用</button>
      <button class="btn btn-ghost btn-sm" data-batch="disable">停用</button>
      <button class="btn btn-danger btn-sm" data-batch="delete">移入回收站</button>
      <button class="btn btn-ghost btn-sm" data-batch="clear">取消选择</button>
    </div>`;
    $$('[data-batch]', bar).forEach((btn) =>
      btn.addEventListener('click', async () => {
        const action = btn.dataset.batch;
        if (action === 'clear') {
          selected.clear();
          render();
          return;
        }
        if (action === 'qr') {
          download(`/admin/api/qr.zip?scope=codes&codes=${encodeURIComponent([...selected].join(','))}&${qrStyleQuery(currentQrStyle())}`);
          toast(`正在打包 ${selected.size} 张二维码…`);
          return;
        }
        if (action === 'sheet') {
          showQrSheet({ scope: 'codes', codes: [...selected], label: `已选 ${selected.size} 条` });
          return;
        }
        if (action === 'group') {
          showBatchGroup();
          return;
        }
        if (action === 'tags') {
          showBatchTags();
          return;
        }
        if (action === 'renew') {
          showBatchRenew();
          return;
        }
        if (action === 'delete') {
          confirmDialog('批量移入回收站', `确定把选中的 ${selected.size} 条短链移入回收站吗？之后可以逐条恢复。`, () => runBatch(action), { confirmText: '确认删除' });
          return;
        }
        runBatch(action);
      }),
    );
  };

  /** 批量改分组：一次把选中的短链挪进同一个分组，或者移出分组 */
  const showBatchGroup = async () => {
    const options = await groupOptionsHtml();
    modal({
      title: `改分组（${selected.size} 条）`,
      bodyHtml: `<div class="field"><label>目标分组</label><select id="bg-group">${options}</select>
          <p class="hint">选「不分组」会把它们移出当前分组；分组本身不会被删除</p></div>`,
      confirmText: '应用',
      onConfirm: async (mask) => {
        const value = $('#bg-group', mask).value;
        const { result: r } = await api('/admin/api/links/batch', {
          method: 'POST',
          body: { action: 'group', codes: [...selected], group: value || null },
        });
        toast(`已把 ${r.affected} 条移到${value ? '目标分组' : '未分组'}`, 'ok');
        selected.clear();
        render();
      },
    });
  };

  /** 批量改标签：追加 / 覆盖 / 清空，三个动作都常用 */
  const showBatchTags = () => {
    modal({
      title: `改标签（${selected.size} 条）`,
      bodyHtml: `<div class="field"><label>方式</label>
          <select id="bt-mode">
            <option value="merge">追加（保留原有标签）</option>
            <option value="replace">覆盖（换成这组标签）</option>
            <option value="clear">清空（去掉全部标签）</option>
          </select></div>
        <div class="field"><label>标签</label><input id="bt-tags" placeholder="推广, 活动" maxlength="200">
          <p class="hint">逗号分隔，最多 10 个；单条最多 24 字</p></div>`,
      confirmText: '应用',
      onConfirm: async (mask) => {
        const mode = $('#bt-mode', mask).value;
        const tags = $('#bt-tags', mask).value;
        if (mode !== 'clear' && !tags.trim()) throw new Error('请填写标签，或把方式改成「清空」');
        const { result: r } = await api('/admin/api/links/batch', {
          method: 'POST',
          body: { action: 'tags', codes: [...selected], tags, mode },
        });
        toast(`已更新 ${r.affected} 条的标签`, 'ok');
        selected.clear();
        render();
      },
    });
  };

  /**
   * 批量续期：往后推 N 天 / 指定日期 / 永久。
   *
   * 只让选「从现在起多久」，不让填「在原来的基础上加多久」——
   * 一批里有的链已经过期三天、有的还有二十天，同一种加法在它们身上
   * 是完全不同的结果，界面上说不清，事后也查不明白。
   */
  const showBatchRenew = () => {
    const today = new Date();
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    modal({
      title: `续期（${selected.size} 条）`,
      bodyHtml: `<div class="field"><label>怎么续</label>
          <select id="br-mode">
            <option value="days">从现在起再加一段时间</option>
            <option value="until">统一改到一个日期</option>
            <option value="forever">设为永久有效</option>
          </select></div>
        <div class="field"><label>时长</label>
          <select id="br-days">
            <option value="7">7 天</option>
            <option value="30" selected>30 天</option>
            <option value="90">90 天</option>
            <option value="180">180 天</option>
            <option value="365">1 年</option>
          </select></div>
        <div class="field"><label>到期日</label>
          <input type="date" id="br-until" value="${iso(new Date(today.getTime() + 30 * 86400000))}">
          <p class="hint">选中的短链到期后会立刻失效；这里只改有效期，目标地址、标题、标签都不动。
            若其中有的链原本是过期后被自动停用的，续期会自动恢复成启用。</p></div>`,
      confirmText: '续期',
      onConfirm: async (mask) => {
        const mode = $('#br-mode', mask).value;
        const body = { action: 'renew', codes: [...selected] };
        if (mode === 'days') body.days = Number($('#br-days', mask).value);
        else if (mode === 'until') body.expireAt = $('#br-until', mask).value;
        else body.expireAt = null;
        const { result: r } = await api('/admin/api/links/batch', { method: 'POST', body });
        toast(
          `已为 ${r.affected} 条续期${r.forever ? '（永久有效）' : r.days ? `（+${r.days} 天）` : ''}${r.missing.length ? `，${r.missing.length} 条不存在` : ''}`,
          'ok',
        );
        selected.clear();
        render();
      },
    });
    // 三块控件互斥着显示：摆在一起会让人以为「时长」和「到期日」要一起填
    const sync = () => {
      const mask = $('.modal-mask:last-of-type');
      if (!mask) return;
      const mode = $('#br-mode', mask)?.value;
      const days = $('#br-days', mask)?.closest('.field');
      const until = $('#br-until', mask)?.closest('.field');
      if (days) days.style.display = mode === 'days' ? '' : 'none';
      if (until) until.style.display = mode === 'until' ? '' : 'none';
    };
    requestAnimationFrame(() => {
      const mask = $('.modal-mask:last-of-type');
      $('#br-mode', mask)?.addEventListener('change', sync);
      sync();
    });
  };

  const runBatch = async (action) => {
    try {
      const { result: r } = await api('/admin/api/links/batch', {
        method: 'POST',
        body: { action, codes: [...selected] },
      });
      toast(`已处理 ${r.affected} 条${r.missing.length ? `，${r.missing.length} 条不存在` : ''}`, 'ok');
      selected.clear();
      render();
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  renderBatch();

  $$('[data-group]', root).forEach((chip) =>
    chip.addEventListener('click', () => {
      state.links.group = chip.dataset.group;
      state.links.page = 1;
      selected.clear();
      render();
    }),
  );

  $$('[data-health]', root).forEach((chip) =>
    chip.addEventListener('click', () => {
      state.links.health = chip.dataset.health;
      state.links.page = 1;
      // 从概览点「查看死链」进来时地址栏还带着参数，切换筛选后清掉，
      // 否则刷新页面又跳回死链筛选，看着像筛选坏了
      if (location.hash.includes('?')) location.hash = '#/links';
      render();
    }),
  );

  $$('[data-heat]', root).forEach((chip) =>
    chip.addEventListener('click', () => {
      state.links.heat = chip.dataset.heat;
      state.links.page = 1;
      render();
    }),
  );

  $$('[data-expiring]', root).forEach((chip) =>
    chip.addEventListener('click', () => {
      state.links.expiring = chip.dataset.expiring;
      // 「即将到期」与「已过期」互斥：一个是还没坏，一个是已经坏了
      if (chip.dataset.expiring) state.links.status = '';
      state.links.page = 1;
      render();
    }),
  );

  $$('[data-expired]', root).forEach((chip) =>
    chip.addEventListener('click', () => {
      state.links.status = 'expired';
      state.links.expiring = '';
      state.links.page = 1;
      render();
    }),
  );

  $$('[data-tag]', root).forEach((chip) =>
    chip.addEventListener('click', () => {
      state.links.tag = chip.dataset.tag;
      state.links.page = 1;
      render();
    }),
  );

  $('#pick-all').addEventListener('change', (e) => {
    for (const l of result.items) {
      if (e.target.checked) selected.add(l.code);
      else selected.delete(l.code);
    }
    render();
  });

  let timer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.links.q = e.target.value.trim();
      state.links.page = 1;
      render();
      const el = $('#search');
      if (el) {
        el.focus();
        el.selectionStart = el.value.length;
      }
    }, 300);
  });
  $('#status-filter').addEventListener('change', (e) => {
    state.links.status = e.target.value;
    state.links.page = 1;
    render();
  });
  $('#sort-filter').addEventListener('change', (e) => {
    state.links.sort = e.target.value;
    // 参数已经用过了，之后以用户的选择为准，否则一改排序就被地址栏里的旧值顶回去
    state.linksFromHash = false;
    render();
  });
  $$('[data-page]', root).forEach((btn) =>
    btn.addEventListener('click', () => {
      state.links.page += btn.dataset.page === 'next' ? 1 : -1;
      render();
    }),
  );
  const filterParams = () => {
    const params = new URLSearchParams({ scope: 'filter', q, status, sort });
    if (tag) params.set('tag', tag);
    if (group) params.set('group', group);
    if (health) params.set('health', health);
    return params;
  };

  $('#qr-all-btn')?.addEventListener('click', () => {
    download(`/admin/api/qr.zip?${filterParams()}&${qrStyleQuery(currentQrStyle())}`);
    toast('正在打包二维码…');
  });

  $('#qr-sheet-btn')?.addEventListener('click', () => {
    showQrSheet({ scope: 'filter', params: filterParams(), label: '当前筛选结果' });
  });

  $('#health-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const original = btn.innerHTML;
    btn.innerHTML = `${ic('pulse')} 检测中…`;
    try {
      const { result: r } = await api('/admin/api/health/check', { method: 'POST', body: { limit: 200 } });
      if (!r.checked) {
        toast('没有需要检测的短链', '');
      } else {
        toast(`已检测 ${r.checked} 条：正常 ${r.ok} · 死链 ${r.dead} · 疑似 ${r.warn}`, r.dead ? 'err' : 'ok');
      }
      render();
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
      btn.innerHTML = original;
    }
  });

  $('#sweep-btn')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const { result: r } = await api('/admin/api/links/sweep', { method: 'POST' });
      const acted = (r.archived || 0) + (r.removed || 0);
      toast(acted ? `已处理 ${acted} 条过期短链（停用 ${r.archived} / 删除 ${r.removed}）` : '没有需要处理的过期短链', acted ? 'ok' : '');
      if (acted) render();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      e.target.disabled = false;
    }
  });

  $$('[data-copy]', root).forEach((btn) => btn.addEventListener('click', () => copy(btn.dataset.copy)));
  $$('tbody tr[data-code]', root).forEach((tr) => {
    const code = tr.dataset.code;
    const link = result.items.find((l) => l.code === code);
    $('.pick', tr)?.addEventListener('change', (e) => {
      if (e.target.checked) selected.add(code);
      else selected.delete(code);
      render();
    });
    $('[data-act="health"]', tr)?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const { result: r } = await api('/admin/api/health/check', { method: 'POST', body: { codes: [code] } });
        const dead = r.dead > 0;
        toast(dead ? `/${code} 的目标地址打不开了` : `/${code} 目标地址正常`, dead ? 'err' : 'ok');
        render();
      } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false;
      }
    });
    $('[data-act="stats"]', tr)?.addEventListener('click', () => showStats(link));
    $('[data-act="qr"]', tr)?.addEventListener('click', () => showQr(link));
    $('[data-act="history"]', tr)?.addEventListener('click', () => showHistory(link));
    $('[data-act="renew"]', tr)?.addEventListener('click', () => showRenew(link));
    $('[data-act="edit"]', tr)?.addEventListener('click', () => showEdit(link));
    $('[data-act="del"]', tr)?.addEventListener('click', () =>
      confirmDialog('移入回收站', `确定把 /${code} 移入回收站吗？短码会继续占位，之后可以在回收站恢复。`, async () => {
        await api(`/admin/api/links/${encodeURIComponent(code)}`, { method: 'DELETE' });
        selected.delete(code);
        toast('已移入回收站', 'ok');
        render();
      }),
    );
  });
}

/**
 * 单条短链的二维码弹窗。
 *
 * 样式参数全都拼在 querystring 上，服务端直接按参数出图——预览和下载
 * 走的是同一个地址，所以「预览里看到的那张」就是「下载下来的那张」，
 * 不会出现前端画一套、后端画另一套的偏差。
 */
const QR_STYLE_KEY = 'highurl.qrstyle';

function loadQrStyle() {
  try {
    const raw = JSON.parse(localStorage.getItem(QR_STYLE_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveQrStyle(style) {
  try {
    localStorage.setItem(QR_STYLE_KEY, JSON.stringify(style));
  } catch {
    /* 隐私模式下写不了，样式不记住而已，不影响功能 */
  }
}

/**
 * 服务端存的样式 → 弹窗里那套字段。
 * 两边字段名不一样（服务端是 QR 库的 dotStyle / gradient，前端控件是 dot / from / to），
 * 在这里一次性对上，别让转换逻辑散到每个调用点。
 */
function fromServerStyle(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  if (raw.preset) out.preset = raw.preset;
  if (raw.dotStyle) out.dot = raw.dotStyle;
  if (raw.ecc) out.ecc = raw.ecc;
  if (Array.isArray(raw.gradient) && raw.gradient.length === 2) {
    out.mode = 'gradient';
    [out.from, out.to] = raw.gradient;
  } else if (raw.dark) {
    out.mode = 'solid';
    out.dark = raw.dark;
  }
  if (raw.light) out.light = raw.light;
  return out;
}

/** 前端这套字段 → 存到短链上的那份 */
function toServerStyle(style) {
  const out = {};
  if (style.preset) out.preset = style.preset;
  if (style.dot) out.dotStyle = style.dot;
  if (style.ecc) out.ecc = style.ecc;
  if (style.mode === 'gradient' && style.from && style.to) out.gradient = [style.from, style.to];
  else if (style.dark) out.dark = style.dark;
  if (style.light) out.light = style.light;
  return out;
}

/** 当前生效的样式：单条弹窗里调过的会记在本机，批量导出与拼版沿用同一套 */
function currentQrStyle() {
  return {
    preset: 'classic', dot: 'square', ecc: 'M', mode: 'solid',
    dark: '#111827', light: '#ffffff', from: '#8b5cf6', to: '#22d3ee',
    ...loadQrStyle(),
  };
}

function qrStyleQuery(style) {
  const p = new URLSearchParams();
  if (style.preset) p.set('preset', style.preset);
  if (style.dot) p.set('dot', style.dot);
  if (style.ecc) p.set('ecc', style.ecc);
  if (style.mode === 'gradient') {
    if (style.from && style.to) p.set('gradient', `${style.from},${style.to}`);
  } else {
    if (style.dark) p.set('dark', style.dark);
  }
  if (style.light) p.set('light', style.light);
  return p;
}

function showQr(link) {
  // 优先级：这条短链自己记住的 > 本机上次用的 > 默认
  const style = {
    preset: 'classic', dot: 'square', ecc: 'M', mode: 'solid',
    dark: '#111827', light: '#ffffff', from: '#8b5cf6', to: '#22d3ee',
    ...loadQrStyle(),
    ...fromServerStyle(link.qrStyle),
  };
  const svgUrl = () => `/admin/api/qr.svg?text=${encodeURIComponent(link.shortUrl)}&${qrStyleQuery(style)}`;
  const pngUrl = (scale) =>
    `/admin/api/qr.png?text=${encodeURIComponent(link.shortUrl)}&scale=${scale}&${qrStyleQuery(style)}`;

  const m = modal({
    title: `/${link.code} 二维码`,
    wide: true,
    bodyHtml: `<div class="row" style="gap:22px;align-items:flex-start;flex-wrap:wrap">
      <div class="stack" style="gap:10px;align-items:center;width:240px;flex:none">
        <div class="qr-preview" id="qr-preview-box"><img class="qr" id="qr-preview" src="${esc(svgUrl())}" alt="二维码" width="220" height="220"></div>
        <div class="row" style="flex-wrap:wrap;justify-content:center">
          <button class="btn btn-ghost btn-sm" data-qr="copy">复制短链接</button>
          <a class="btn btn-ghost btn-sm" id="qr-svg" href="${esc(svgUrl())}" download="${esc(link.code)}.svg">SVG</a>
          <button class="btn btn-primary btn-sm" data-qr="png">PNG</button>
        </div>
        <p class="hint" style="text-align:center;margin:0">PNG 由服务端直出，无灰边；SVG 是矢量，印刷放大不糊。</p>
      </div>
      <div class="stack" style="gap:12px;flex:1;min-width:250px">
        <div>
          <label>样式预设</label>
          <div class="row" style="flex-wrap:wrap;gap:6px" id="qr-presets">
            ${Object.entries(QR_PRESET_META).map(([key, p]) =>
              `<button class="btn btn-ghost btn-sm ${style.preset === key ? 'active' : ''}" data-preset="${key}">${esc(p.label)}</button>`).join('')}
          </div>
        </div>
        <div class="field-row">
          <div class="field"><label for="qr-dot">码点形状</label>
            <select id="qr-dot">
              <option value="square">方块（规范）</option>
              <option value="rounded">圆角块</option>
              <option value="dots">圆点</option>
            </select>
          </div>
          <div class="field"><label for="qr-ecc">纠错等级</label>
            <select id="qr-ecc">
              <option value="L">L · 7%（码最小）</option>
              <option value="M">M · 15%（推荐）</option>
              <option value="Q">Q · 25%</option>
              <option value="H">H · 30%（最耐污损）</option>
            </select>
            <p class="hint">等级越高越耐污损，但码点更密、也更容易扫不出来</p>
          </div>
        </div>
        <div class="field">
          <label>填充</label>
          <div class="row" style="gap:8px">
            <label class="switch" style="margin:0"><input type="checkbox" id="qr-grad-toggle" ${style.mode === 'gradient' ? 'checked' : ''}><span>渐变</span></label>
          </div>
        </div>
        <div class="field-row" id="qr-solid-row">
          <div class="field"><label for="qr-dark">码点颜色</label>
            <div class="row"><input id="qr-dark" type="color" value="${esc(style.dark)}" style="width:52px;padding:3px;flex:none">
              <input id="qr-dark-hex" class="mono" value="${esc(style.dark)}" style="flex:1" maxlength="9"></div>
          </div>
        </div>
        <div class="field-row" id="qr-grad-row" style="display:none">
          <div class="field"><label for="qr-from">渐变起始</label>
            <input id="qr-from" type="color" value="${esc(style.from)}">
          </div>
          <div class="field"><label for="qr-to">渐变结束</label>
            <input id="qr-to" type="color" value="${esc(style.to)}">
          </div>
        </div>
        <div class="field-row">
          <div class="field"><label for="qr-light">背景</label>
            <div class="row"><input id="qr-light" type="color" value="${esc(style.light === 'transparent' ? '#ffffff' : style.light)}" style="width:52px;padding:3px;flex:none">
              <label class="switch" style="margin:0;flex:1"><input type="checkbox" id="qr-transparent" ${style.light === 'transparent' ? 'checked' : ''}><span>透明底</span></label></div>
          </div>
        </div>
        <p class="hint" id="qr-warn" style="color:var(--warn);display:none"></p>
        <div class="row" style="gap:8px;align-items:center">
          <button class="btn btn-ghost btn-sm" id="qr-save-style">记住这套（随短链）</button>
          <span class="qr-saved-hint" id="qr-save-state">${link.qrStyle ? '当前显示的是这条短链记住的样式' : '当前用的是本机偏好'}</span>
        </div>
        <p class="hint">「记住」会把这套样式存到这条短链上：换台电脑打开还是这套，批量导出与拼版打印也沿用它。本机偏好只影响你自己这个浏览器。</p>
      </div>
    </div>`,
    confirmText: '完成',
    cancelText: null,
    onConfirm: async () => true,
  });

  const $m = (sel) => $(sel, m.el);
  $('#qr-dot', m.el).value = style.dot;
  $('#qr-ecc', m.el).value = style.ecc;

  /**
   * 刷新预览。
   *
   * 这里要拦一种「看起来能用、其实扫不出来」的组合：深色背景 + 浅色码点。
   * 反色二维码在规范里是允许的，但扫描器实现参差不齐；作为默认值不可接受，
   * 既然用户自己选了，就提示一句，别帮他改。
   */
  const refresh = () => {
    const transparent = $('#qr-transparent', m.el).checked;
    style.dot = $('#qr-dot', m.el).value;
    style.ecc = $('#qr-ecc', m.el).value;
    style.mode = $('#qr-grad-toggle', m.el).checked ? 'gradient' : 'solid';
    style.dark = $('#qr-dark', m.el).value || style.dark;
    style.from = $('#qr-from', m.el).value || style.from;
    style.to = $('#qr-to', m.el).value || style.to;
    style.light = transparent ? 'transparent' : ($('#qr-light', m.el).value || '#ffffff');
    $('#qr-dark-hex', m.el).value = style.dark;
    $('#qr-solid-row', m.el).style.display = style.mode === 'gradient' ? 'none' : '';
    $('#qr-grad-row', m.el).style.display = style.mode === 'gradient' ? '' : 'none';
    $('#qr-light', m.el).disabled = transparent;

    const url = `${svgUrl()}&t=${Date.now()}`;
    $('#qr-preview', m.el).src = url;
    $('#qr-svg', m.el).href = svgUrl();
    $('#qr-preview-box', m.el).classList.toggle('on-light', style.light !== 'transparent');

    const darkLum = luminance(style.mode === 'gradient' ? style.from : style.dark);
    const lightLum = transparent ? 255 : luminance(style.light);
    const warn = $('#qr-warn', m.el);
    // 先判反色再判对比度：反色时「浅色 - 深色」是个负数，
    // 按差值判会一律报成「对比度偏低」，而真正该说的是「这是反色码」
    if (darkLum > lightLum) {
      warn.textContent = transparent
        ? '透明底 + 浅色码点：贴到浅色物料上会看不见，务必垫一层深底。'
        : '这是反色二维码（浅码点 + 深底）：多数相机能扫，部分老设备不行。';
      warn.style.display = '';
    } else if (lightLum - darkLum < 90) {
      warn.textContent = '码点与背景对比度偏低，手机可能扫不出来，换个颜色试试。';
      warn.style.display = '';
    } else {
      warn.style.display = 'none';
    }
    saveQrStyle(style);
  };

  $$('[data-preset]', m.el).forEach((btn) =>
    btn.addEventListener('click', () => {
      const p = QR_PRESET_META[btn.dataset.preset];
      if (!p) return;
      style.preset = btn.dataset.preset;
      style.dot = p.dotStyle || 'square';
      style.mode = p.gradient ? 'gradient' : 'solid';
      if (p.dark) style.dark = p.dark;
      if (p.gradient) [style.from, style.to] = p.gradient;
      style.light = p.light || '#ffffff';
      $('#qr-dot', m.el).value = style.dot;
      $('#qr-grad-toggle', m.el).checked = style.mode === 'gradient';
      $('#qr-dark', m.el).value = style.dark;
      if (p.gradient) { $('#qr-from', m.el).value = style.from; $('#qr-to', m.el).value = style.to; }
      $('#qr-transparent', m.el).checked = style.light === 'transparent';
      if (style.light !== 'transparent') $('#qr-light', m.el).value = style.light;
      $$('[data-preset]', m.el).forEach((b) => b.classList.toggle('active', b === btn));
      refresh();
    }),
  );

  ['qr-dot', 'qr-ecc', 'qr-grad-toggle', 'qr-dark', 'qr-from', 'qr-to', 'qr-light', 'qr-transparent'].forEach((id) => {
    $('#' + id, m.el).addEventListener('input', refresh);
    $('#' + id, m.el).addEventListener('change', refresh);
  });
  $('#qr-dark-hex', m.el).addEventListener('change', () => {
    const v = $('#qr-dark-hex', m.el).value.trim();
    if (/^#?[0-9a-f]{6}$/i.test(v)) {
      style.dark = v.startsWith('#') ? v : `#${v}`;
      $('#qr-dark', m.el).value = style.dark;
      refresh();
    } else {
      $('#qr-dark-hex', m.el).value = style.dark;
      toast('颜色要写成 #rrggbb', 'err');
    }
  });

  m.el.querySelector('#qr-save-style').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api(`/admin/api/links/${encodeURIComponent(link.code)}/qr-style`, {
        method: 'PUT',
        body: { qrStyle: toServerStyle(style) },
      });
      link.qrStyle = toServerStyle(style);
      $('#qr-save-state', m.el).textContent = '已记住，换台设备打开也是这套';
      toast('这套样式已记住', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      e.target.disabled = false;
    }
  });

  m.el.querySelector('[data-qr="copy"]').addEventListener('click', () => copy(link.shortUrl));
  // PNG 由服务端直接出，不用再把 SVG 画到 canvas 上——那样在 Safari 上会因为
  // 没有显式宽高的 SVG 拿到空白图，且导出尺寸受设备像素比影响
  m.el.querySelector('[data-qr="png"]').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = pngUrl(16);
    a.download = `${link.code}.png`;
    a.click();
    toast('PNG 已导出', 'ok');
  });

  refresh();
}

/**
 * 变更历史弹窗。
 *
 * 每个版本给两件东西：一句人话摘要（改了之后长什么样），和回滚按钮。
 * 不展示完整 diff 不是偷懒——短链的字段就那几个，管理员真正想确认的是
 * 「这版的目标地址是不是我要的那个」，把 url 摆出来就够了。
 */
const HISTORY_ACTION_LABEL = {
  create: '创建',
  update: '编辑',
  password: '改密码',
  delete: '删除',
  targets: '改分流',
  title: '重抓标题',
  rollback: '回滚',
  rollback_before: '回滚前快照',
  batch_enable: '批量启用',
  batch_disable: '批量停用',
  batch_delete: '批量删除',
  batch_group: '批量改分组',
  batch_tags: '批量改标签',
};

/**
 * 变更对比表。左边是那一版，右边是现在——顺序固定，
 * 不按时间正反来回切，免得看两行就分不清哪边是「改之前」。
 */
function renderDiff(changes, targetLabel) {
  if (!changes.length) return '<p class="muted" style="margin:0">这一版和现在一模一样，中间没有改动。</p>';
  const cell = (v) => (v === '' || v === undefined || v === null
    ? '<span class="dim">（空）</span>'
    : `<span class="mono" style="word-break:break-all">${esc(v)}</span>`);
  const rows = changes.map((c) => {
    if (c.kind === 'targets') {
      const added = (c.added || []).map((u) => `<div class="diff-add">+ ${esc(u)}</div>`).join('');
      const removed = (c.removed || []).map((u) => `<div class="diff-del">- ${esc(u)}</div>`).join('');
      return `<tr><td class="diff-key">分流目标</td><td colspan="2">${removed}${added}</td></tr>`;
    }
    return `<tr><td class="diff-key">${esc(c.label)}</td><td class="diff-from">${cell(c.from)}</td><td class="diff-to">${cell(c.to)}</td></tr>`;
  }).join('');
  return `<table class="diff-table">
    <thead><tr><th>字段</th><th>这一版</th><th>${esc(targetLabel)}</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

async function showHistory(link) {
  const bodyHtml = `<div id="history-list"><p class="muted">加载中…</p></div>`;
  const m = modal({ title: `/${link.code} 变更历史`, bodyHtml, wide: true, confirmText: '完成', cancelText: null, onConfirm: async () => true });

  const load = async () => {
    const box = $('#history-list', m.el);
    let data;
    try {
      const { result } = await api(`/admin/api/links/${encodeURIComponent(link.code)}/history?perPage=30`);
      data = result;
    } catch (err) {
      box.innerHTML = `<p class="muted">读取失败：${esc(err.message)}</p>`;
      return;
    }
    if (!data.items.length) {
      box.innerHTML = `<div class="empty"><b>还没有历史版本</b><span class="muted">改动一次就会出现一版，可以随时回滚</span></div>`;
      return;
    }
    box.innerHTML = `<p class="hint" style="margin-top:0">共 ${data.total} 版，每版是那一刻的状态快照。回滚本身也会记一版，所以滚错了还能滚回来。</p>
      ${data.items
        .map((h) => {
          return `<div class="history-row">
        <div class="history-meta">
          <span class="tag ${h.action.startsWith('batch_delete') || h.action === 'delete' ? 'tag-err' : 'tag-brand'}">${esc(HISTORY_ACTION_LABEL[h.action] || h.action)}</span>
          <span class="muted">${fmtDate(h.at)}</span>
          <span class="dim">· ${esc(h.actor || '—')}</span>
        </div>
        <div class="history-body">
          <span class="mono dim" style="word-break:break-all">${esc(h.summary)}</span>
          <span class="row" style="gap:6px;flex:none">
            <button class="btn btn-ghost btn-sm" data-diff="${h.id}">和现在比</button>
            <button class="btn btn-ghost btn-sm" data-rollback="${h.id}">回滚到这一版</button>
          </span>
        </div>
        <div class="history-diff" id="hist-diff-${h.id}" hidden></div>
      </div>`;
        })
        .join('')}`;

    $$('[data-diff]', box).forEach((btn) =>
      btn.addEventListener('click', async () => {
        const slot = $(`#hist-diff-${btn.dataset.diff}`, box);
        if (!slot.hidden) {
          slot.hidden = true;
          btn.classList.remove('active');
          return;
        }
        slot.hidden = false;
        slot.innerHTML = '<p class="muted" style="margin:0">对比中…</p>';
        btn.classList.add('active');
        const { result } = await api(
          `/admin/api/links/${encodeURIComponent(link.code)}/history/diff?from=${btn.dataset.diff}&to=0`,
        );
        slot.innerHTML = renderDiff(result.changes, '当前');
      }),
    );

    $$('[data-rollback]', box).forEach((btn) =>
      btn.addEventListener('click', () =>
        confirmDialog(
          '回滚版本',
          `把 /${link.code} 恢复到这一版（目标地址、标题、备注、标签、状态、有效期、分组、分流目标都会还原）。当前状态会先存一版，随时可以再滚回来。`,
          async () => {
            const { result } = await api(`/admin/api/links/${encodeURIComponent(link.code)}/history/${btn.dataset.rollback}/rollback`, { method: 'POST' });
            toast(`已回滚到 /${result.code} 的那一版`, 'ok');
            await load();
            render();
          },
          { confirmText: '回滚', danger: false },
        ),
      ),
    );
  };

  await load();
}

/** 预设表与后端 QR_PRESETS 一一对应；这里只放界面需要的标签与形状 */
const QR_PRESET_META = {
  classic: { label: '经典黑白', dotStyle: 'square', dark: '#111827', light: '#ffffff' },
  brand: { label: '品牌渐变', dotStyle: 'rounded', gradient: ['#8b5cf6', '#22d3ee'], light: '#ffffff' },
  soft: { label: '柔和圆点', dotStyle: 'dots', dark: '#3b2f63', light: '#f8f7ff' },
  light: { label: '深色底反白', dotStyle: 'rounded', dark: '#ffffff', light: '#0f1023' },
  sticker: { label: '透明底贴纸', dotStyle: 'dots', dark: '#111827', light: 'transparent' },
};

/** 相对亮度（sRGB 简化版），只用来判断对比度是否够扫 */
function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return 128;
  const n = Number.parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * 拼版打印弹窗：纸张、列数、是否带标题与裁切线，右上角直接预览。
 * PDF 由服务端现拼，这里只负责把参数拼成 URL 与给个 live 预览。
 */
function showQrSheet({ scope, codes = null, params = null, label = '' }) {
  const style = currentQrStyle();

  const buildUrl = (ext, opts = {}) => {
    const p = params ? new URLSearchParams(params) : new URLSearchParams({ scope: 'codes', codes: codes.join(',') });
    p.set('paper', opts.paper || 'a4');
    if (opts.cols) p.set('cols', String(opts.cols));
    if (opts.showTitle === false) p.set('title', '0');
    if (opts.showCut === false) p.set('cut', '0');
    for (const [k, v] of qrStyleQuery({ ...style, preset: opts.preset || style.preset })) p.set(k, v);
    if (ext === 'zip') p.set('scope', params ? 'filter' : 'codes');
    return `/admin/api/qr.${ext}?${p}`;
  };

  const m = modal({
    title: '拼版打印',
    wide: true,
    bodyHtml: `<div class="row" style="gap:20px;align-items:flex-start;flex-wrap:wrap">
      <div class="stack" style="gap:12px;flex:1;min-width:240px">
        <div class="field-row">
          <div class="field"><label for="qs-paper">纸张</label>
            <select id="qs-paper"><option value="a4">A4</option><option value="letter">Letter</option></select>
          </div>
          <div class="field"><label for="qs-cols">每行几列</label>
            <select id="qs-cols">
              <option value="0">自动</option><option value="2">2 列</option>
              <option value="3">3 列</option><option value="4">4 列</option>
              <option value="5">5 列</option><option value="6">6 列</option>
            </select>
          </div>
        </div>
        <div class="field">
          <label>二维码样式</label>
          <div class="row" style="flex-wrap:wrap;gap:6px" id="qs-presets">
            ${Object.entries(QR_PRESET_META).map(([key, p]) =>
              `<button class="btn btn-ghost btn-sm ${style.preset === key ? 'active' : ''}" data-preset="${key}">${esc(p.label)}</button>`).join('')}
          </div>
          <p class="hint">和单条二维码用同一套样式，默认沿用上次在二维码弹窗里选的那套。</p>
        </div>
        <label class="switch"><input type="checkbox" id="qs-title" checked><span>格子下方打印标题</span></label>
        <label class="switch"><input type="checkbox" id="qs-cut" checked><span>加浅色裁切线</span></label>
        <p class="hint">范围：${esc(label)}。二维码是矢量绘制，放大或印刷都不会糊；标题含中文时退回显示域名，内置字体画不了中文。</p>
        <div class="row" style="flex-wrap:wrap">
          <button class="btn btn-primary btn-sm" id="qs-download">下载 PDF</button>
          <button class="btn btn-ghost btn-sm" id="qs-open">新窗口打开</button>
          <button class="btn btn-ghost btn-sm" id="qs-zip">改成下载 ZIP 图片</button>
        </div>
      </div>
      <div style="flex:1;min-width:240px">
        <label>预览</label>
        <iframe id="qs-preview" title="拼版预览" style="width:100%;height:340px;border:1px solid var(--line);border-radius:10px;background:#fff"></iframe>
      </div>
    </div>`,
    confirmText: '完成',
    cancelText: null,
    onConfirm: async () => true,
  });

  let pickedPreset = style.preset;
  const opts = () => ({
    paper: $('#qs-paper', m.el).value,
    cols: Number($('#qs-cols', m.el).value) || 0,
    showTitle: $('#qs-title', m.el).checked,
    showCut: $('#qs-cut', m.el).checked,
    preset: pickedPreset,
  });
  const refresh = () => {
    const url = buildUrl('pdf', opts());
    $('#qs-preview', m.el).src = url;
    $('#qs-open', m.el).dataset.href = url;
  };

  $$('[data-preset]', m.el).forEach((btn) =>
    btn.addEventListener('click', () => {
      pickedPreset = btn.dataset.preset;
      const p = QR_PRESET_META[pickedPreset] || {};
      // 换预设时把码点形状与配色一起切过去，只切半套会出现「圆点 + 经典黑白」这种拧巴组合
      style.dot = p.dotStyle || style.dot;
      style.mode = p.gradient ? 'gradient' : 'solid';
      if (p.dark) style.dark = p.dark;
      if (p.gradient) [style.from, style.to] = p.gradient;
      if (p.light) style.light = p.light;
      $$('[data-preset]', m.el).forEach((b) => b.classList.toggle('active', b === btn));
      refresh();
    }),
  );

  $('#qs-paper', m.el).addEventListener('change', refresh);
  $('#qs-cols', m.el).addEventListener('change', refresh);
  $('#qs-title', m.el).addEventListener('change', refresh);
  $('#qs-cut', m.el).addEventListener('change', refresh);
  $('#qs-download', m.el).addEventListener('click', () => {
    download(buildUrl('pdf', opts()));
    toast('PDF 开始生成', 'ok');
  });
  $('#qs-open', m.el).addEventListener('click', (e) => window.open(e.target.dataset.href, '_blank', 'noopener'));
  $('#qs-zip', m.el).addEventListener('click', () => {
    download(buildUrl('zip', opts()));
    toast('正在打包二维码…');
  });
  refresh();
}

/**
 * 健康徽章。`unknown` 不显示——满屏的「未检测」只是噪音，
 * 真正需要一眼看见的是「这条已经死了」。
 */
function healthBadge(l) {
  const h = l.health || {};
  if (h.status === 'dead') return `<span class="tag tag-err" title="${esc(h.error || '')}">死链</span>`;
  if (h.status === 'warn') return `<span class="tag tag-warn" title="${esc(h.error || '')}">疑似失效</span>`;
  return '';
}

function statusBadge(l) {
  const now = Date.now();
  if (l.expireAt && l.expireAt < now) return '<span class="tag tag-warn">已过期</span>';
  if (l.status === 'disabled') return '<span class="tag tag-err">已停用</span>';
  // 到期是个渐变的过程，不是某天突然发生的事。三天内到期的给一枚提醒，
  // 免得到时候又变成「怎么突然打不开了」
  if (l.expireAt && l.expireAt - now < 3 * 86400000) {
    const days = Math.max(1, Math.ceil((l.expireAt - now) / 86400000));
    return `<span class="tag tag-ok">生效中</span><span class="tag tag-warn" title="${esc(new Date(l.expireAt).toLocaleString())}">${days} 天后到期</span>`;
  }
  return '<span class="tag tag-ok">生效中</span>';
}

/**
 * 分组下拉选项。value 为空表示不分组，接口那边 '' 会被当成 null。
 */
async function groupOptionsHtml(selected = null) {
  let items = [];
  try {
    const { result } = await api('/admin/api/groups');
    items = result.items || [];
  } catch {
    items = [];
  }
  const pick = (id) => (String(id) === String(selected) ? 'selected' : '');
  return `<option value="">不分组</option>${items
    .map((g) => `<option value="${g.id}" ${pick(g.id)}>${esc(g.name)}（${g.links}）</option>`)
    .join('')}`;
}

/* ---------- 视图：新建 ---------- */
async function viewCreate(root) {
  const groupOptions = await groupOptionsHtml();
  root.innerHTML = `
  <div class="topbar"><div><h1>新建短链</h1><div class="sub">粘贴长链接，其余交给系统</div></div><span class="spacer"></span>
    <a class="btn btn-ghost btn-sm" href="#/links">返回列表</a>
  </div>
  <div class="split">
    <section class="card"><div class="card-body">
      <form id="create-form">
        <div class="field"><label for="f-url">目标链接 *</label>
          <input id="f-url" name="url" placeholder="https://example.com/very/long/path" required inputmode="url">
        </div>
        <div class="field-row">
          <div class="field"><label for="f-code">自定义短码</label>
            <input id="f-code" name="code" placeholder="留空自动生成" maxlength="64">
            <p class="hint">字母、数字、- 和 _</p>
          </div>
          <div class="field"><label for="f-expire">有效期</label>
            <input id="f-expire" name="expireAt" type="date">
            <p class="hint">留空永久有效</p>
          </div>
        </div>
        <div class="field"><label for="f-title">标题</label>
          <input id="f-title" name="title" placeholder="留空自动抓取目标页标题" maxlength="300">
        </div>
        <div class="field-row">
          <div class="field"><label for="f-group">分组</label>
            <select id="f-group" name="group">${groupOptions}</select>
          </div>
          <div class="field"><label for="f-tags">标签</label>
            <input id="f-tags" name="tags" placeholder="推广, 文档, 活动">
          </div>
        </div>
        <div class="field"><label for="f-note">备注</label>
          <textarea id="f-note" name="note" placeholder="给未来的自己留个说明" maxlength="500"></textarea>
        </div>
        <button class="btn btn-primary" type="submit" id="create-btn" data-writes>创建短链</button>
      </form>
    </div></section>
    <section class="card" id="result-panel"><div class="card-body">
      <h2 style="font-size:15px;margin-bottom:12px">创建结果</h2>
      <p class="muted">创建后会显示短链接、二维码与复制按钮。</p>
    </div></section>
  </div>`;

  const form = $('#create-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#create-btn');
    btn.disabled = true;
    btn.textContent = '创建中…';
    const fd = new FormData(form);
    const payload = {
      url: fd.get('url'),
      code: fd.get('code') || undefined,
      title: fd.get('title') || undefined,
      tags: fd.get('tags') || undefined,
      note: fd.get('note') || undefined,
      expireAt: fd.get('expireAt') || undefined,
      group: fd.get('group') || undefined,
    };
    try {
      const { result } = await api('/admin/api/links', { method: 'POST', body: payload });
      form.reset();
      toast('创建成功', 'ok');
      showResult(result);
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '创建短链';
    }
  });
}

function showResult(link) {
  const panel = $('#result-panel');
  panel.innerHTML = `<div class="card-body stack">
    <div class="row"><span class="tag tag-ok">已创建</span><span class="mono dim">/${esc(link.code)}</span></div>
    <div>
      <label>短链接</label>
      <div class="row"><input readonly value="${esc(link.shortUrl)}" id="short-val"><button class="btn btn-ghost btn-sm" id="copy-link">复制</button></div>
    </div>
    <div class="row" style="align-items:flex-start;gap:16px">
      <img class="qr" src="/admin/api/qr.svg?text=${encodeURIComponent(link.shortUrl)}" alt="二维码" width="180" height="180">
      <div class="stack" style="gap:8px">
        <div><label>目标链接</label><div class="mono dim truncate" style="max-width:280px">${esc(link.url)}</div></div>
        <div><label>标题</label><div class="dim">${esc(link.title || '—')}</div></div>
        <a class="btn btn-ghost btn-sm" href="${esc(link.shortUrl)}" target="_blank" rel="noopener">打开测试</a>
      </div>
    </div>
  </div>`;
  $('#copy-link').addEventListener('click', () => copy(link.shortUrl));
}

/* ---------- 编辑 / 统计 ---------- */

/**
 * 分流目标编辑器。
 *
 * 整组提交：改完点「保存」时一次性 PUT 全量，后端语义是「提交后就是这样」。
 * 之所以不在每行做增删接口：目标最多 8 条，一次提交省掉一堆中间状态
 * （加到一半关掉弹窗，库里该是什么样？）。
 */
function mountTargetEditor(link, root) {
  const box = $('#e-targets', root);
  if (!box) return;
  const rows = (link.targets || []).map((t) => ({ ...t }));

  const rowHtml = (t, i) => `<div class="target-row" data-i="${i}">
    <div class="tr-row">
      <input class="t-url" placeholder="https://example.com/b" value="${esc(t.url || '')}" inputmode="url">
      <button class="btn btn-ghost btn-sm btn-icon" type="button" data-del="${i}" title="删除这个目标" aria-label="删除这个目标">${ic('trash')}</button>
    </div>
    <div class="tr-row tr-sub">
      <input class="t-label" placeholder="备注，如「B 版落地页」" value="${esc(t.label || '')}" maxlength="40">
      <input class="t-weight" type="number" min="0" max="10000" step="1" value="${t.weight ?? 100}" title="权重" aria-label="权重">
      <input class="t-regions" placeholder="如 CN,US" title="地区码，逗号分隔；留空表示全球" value="${esc((t.regions || []).join(','))}" aria-label="地区">
    </div>
  </div>`;

  const paint = () => {
    box.innerHTML = rows.length
      ? rows.map(rowHtml).join('')
      : '<p class="muted" style="margin:0 0 8px">还没有分流目标，所有访客都会跳到上面的目标链接。</p>';
    $$('[data-del]', box).forEach((btn) =>
      btn.addEventListener('click', () => {
        sync();
        rows.splice(Number(btn.dataset.del), 1);
        paint();
      }),
    );
  };

  const sync = () => {
    $$('.target-row', box).forEach((el, i) => {
      if (!rows[i]) return;
      rows[i].url = $('.t-url', el).value.trim();
      rows[i].label = $('.t-label', el).value.trim();
      rows[i].weight = Number($('.t-weight', el).value) || 0;
      rows[i].regions = $('.t-regions', el).value.split(/[,，\s]+/).map((r) => r.trim().toUpperCase()).filter(Boolean);
    });
  };

  paint();
  $('#e-target-add', root).addEventListener('click', () => {
    sync();
    if (rows.length >= 8) {
      toast('最多 8 个分流目标', 'err');
      return;
    }
    rows.push({ url: '', label: '', weight: 100, regions: [] });
    paint();
    $$('.t-url', box).at(-1)?.focus();
  });

  box.dataset.sync = '1';
  box.addEventListener('input', sync);
}

/** 提交时取当前编辑器的内容；空 url 的行直接忽略（用户点了添加又没填） */
async function saveTargets(link, root) {
  const box = $('#e-targets', root);
  if (!box) return;
  const rows = $$('.target-row', box)
    .map((el) => ({
      id: link.targets?.[Number(el.dataset.i)]?.id,
      url: $('.t-url', el).value.trim(),
      label: $('.t-label', el).value.trim(),
      weight: Number($('.t-weight', el).value) || 0,
      regions: $('.t-regions', el).value,
    }))
    .filter((t) => t.url);
  const before = (link.targets || []).map((t) => `${t.url}|${t.weight}|${t.regions.join(',')}`).join(';');
  const after = rows.map((t) => `${t.url}|${t.weight}|${String(t.regions).toUpperCase().split(/[,，\s]+/).filter(Boolean).join(',')}`).join(';');
  if (before === after) return;
  await api(`/admin/api/links/${encodeURIComponent(link.code)}/targets`, { method: 'PUT', body: { targets: rows } });
}

async function showEdit(link) {
  const groupOptions = await groupOptionsHtml(link.group ? link.group.id : null);
  // 列表接口不带目标明细（每条都带等于给每页加 20 段无关数据），
  // 打开弹窗时再取一次，只有编辑时才需要
  try {
    const { result } = await api(`/admin/api/links/${encodeURIComponent(link.code)}/targets`);
    link = { ...link, targets: result.targets };
  } catch {
    link = { ...link, targets: [] };
  }
  const m = modal({
    title: `编辑 /${link.code}`,
    wide: true,
    bodyHtml: `<div class="field"><label>目标链接</label><input id="e-url" value="${esc(link.url)}"></div>
      <div class="field"><label>标题</label>
        <div class="row"><input id="e-title" value="${esc(link.title)}"><button class="btn btn-ghost btn-sm" type="button" id="e-fetch">抓取</button></div>
      </div>
      <div class="field-row">
        <div class="field"><label>标签</label><input id="e-tags" value="${esc(link.tags.join(','))}"></div>
        <div class="field"><label>状态</label>
          <select id="e-status">
            <option value="active" ${link.status === 'active' ? 'selected' : ''}>生效中</option>
            <option value="disabled" ${link.status === 'disabled' ? 'selected' : ''}>已停用</option>
          </select>
        </div>
        <div class="field"><label>有效期</label><input id="e-expire" type="date" value="${link.expireAt ? new Date(link.expireAt).toISOString().slice(0, 10) : ''}"></div>
      </div>
      <div class="field"><label>分组</label><select id="e-group">${groupOptions}</select>
        <p class="hint">分组只影响归堆，不影响跳转</p></div>
      <div class="field"><label>备注</label><textarea id="e-note">${esc(link.note)}</textarea></div>
      <div class="field"><label>跳转前建页</label>
        <div class="landing-grid">
          <label class="switch" style="margin:0"><input type="checkbox" id="e-landing" ${link.landing?.enabled ? 'checked' : ''}><span>先给访问者一个介绍页</span></label>
          <div class="seg" id="e-landing-theme">
            ${[['auto', '跟随系统'], ['dark', '暗色'], ['light', '亮色']]
              .map(([v, t]) => `<button type="button" data-theme="${v}" class="${(link.landing?.theme || 'auto') === v ? 'on' : ''}">${t}</button>`)
              .join('')}
          </div>
          <input id="e-landing-note" placeholder="一句话说明（可留空）" maxlength="200" value="${esc(link.landing?.note || '')}">
        </div>
        <p class="landing-hint">开启后访问 /${esc(link.code)} 先落在介绍页，看得到目标域名与标题，点「继续访问」才跳。介绍页本身不计点击。</p>
      </div>
      <div class="field"><label>访问密码</label>
        <div class="row"><input id="e-pwd" type="text" placeholder="${link.protected ? '已设置，留空则清除' : '留空表示不加密'}"><button class="btn btn-ghost btn-sm" type="button" id="e-pwd-btn">保存密码</button></div>
        <p class="hint">设置后访问该短链需要先输入密码</p>
      </div>
      <div class="field"><label>分流目标</label>
        <div id="e-targets" class="targets"></div>
        <button class="btn btn-ghost btn-sm" type="button" id="e-target-add">${ic('plus')} 添加目标</button>
        <p class="hint">留空则跳到上面那个目标。多个目标按权重随机命中；填了地区的目标优先给对应地区的访客</p>
      </div>`,
    onConfirm: async (mask) => {
      await api(`/admin/api/links/${encodeURIComponent(link.code)}`, {
        method: 'PATCH',
        body: {
          url: $('#e-url', mask).value,
          title: $('#e-title', mask).value,
          tags: $('#e-tags', mask).value,
          status: $('#e-status', mask).value,
          note: $('#e-note', mask).value,
          expireAt: $('#e-expire', mask).value || null,
          group: $('#e-group', mask).value || null,
        },
      });
      await saveTargets(link, mask);
      await api(`/admin/api/links/${encodeURIComponent(link.code)}/landing`, {
        method: 'PATCH',
        body: {
          enabled: $('#e-landing', mask).checked,
          theme: $('#e-landing-theme .on', mask)?.dataset.theme || 'auto',
          note: $('#e-landing-note', mask).value,
        },
      });
      toast('已保存', 'ok');
      render();
    },
  });

  // 主题三选一：用分段按钮而不是下拉，选了立刻能看出是哪一个
  $$('#e-landing-theme [data-theme]', m.el).forEach((btn) =>
    btn.addEventListener('click', () => {
      $$('#e-landing-theme [data-theme]', m.el).forEach((b) => b.classList.toggle('on', b === btn));
    }),
  );

  mountTargetEditor(link, m.el);

  $('#e-fetch', m.el).addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const { result } = await api(`/admin/api/links/${encodeURIComponent(link.code)}/title`, { method: 'POST' });
      $('#e-title', m.el).value = result.title;
      toast('已抓取标题', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      e.target.disabled = false;
    }
  });

  $('#e-pwd-btn', m.el).addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api(`/admin/api/links/${encodeURIComponent(link.code)}/password`, {
        method: 'POST',
        body: { password: $('#e-pwd', m.el).value },
      });
      toast('密码已更新', 'ok');
      render();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      e.target.disabled = false;
    }
  });
}

/**
 * 分流目标的命中分布。
 * 权重是「打算怎么分」，这里是「实际分成了什么样」——两者不一致时
 * 通常意味着某条目标被地区规则吃掉了大部分流量。
 */
function targetHitRows(targets) {
  const total = targets.reduce((s, t) => s + t.clicks, 0) || 1;
  return targets
    .slice()
    .sort((a, b) => b.clicks - a.clicks)
    .map((t) => `<div class="row" style="justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--line);gap:10px">
      <span class="truncate"><span class="mono dim">${t.weight}</span> ${esc(t.label || t.url)}${t.regions.length ? ` <span class="tag">${esc(t.regions.join(' '))}</span>` : ''}</span>
      <span class="mono muted nowrap">${num(t.clicks)} · ${((t.clicks / total) * 100).toFixed(0)}%</span>
    </div>`)
    .join('');
}

/**
 * 单条续期。默认值取「原来的期限长度」——运营者把一条 30 天的链续上，
 * 想要的通常是再来 30 天，而不是随手点一个默认的 7 天。
 */
function showRenew(link) {
  const now = Date.now();
  const originalSpan = link.expireAt && link.createdAt ? Math.max(1, Math.round((link.expireAt - link.createdAt) / 86400000)) : 30;
  const presets = [...new Set([7, 30, 90, 180, 365, originalSpan])].sort((a, b) => a - b);
  const left = link.expireAt ? link.expireAt - now : null;
  const stateText = left === null
    ? '这条短链目前永久有效'
    : left < 0
      ? `已经过期 ${Math.abs(Math.round(left / 86400000))} 天`
      : `还有 ${Math.max(1, Math.round(left / 86400000))} 天到期`;
  modal({
    title: `/${link.code} 续期`,
    bodyHtml: `<div class="field"><label>当前状态</label><p class="hint">${esc(stateText)}${link.expireAt ? `（${fmtExpire(link.expireAt)}）` : ''}</p></div>
      <div class="field"><label>续到</label>
        <select id="rn-days">
          ${presets.map((d) => `<option value="${d}" ${d === 30 ? 'selected' : ''}>从现在起 +${d} 天${d === originalSpan ? '（按原期限）' : ''}</option>`).join('')}
          <option value="forever">永久有效</option>
        </select>
        <p class="hint">从现在起算，不是在原有效期上叠加——一批同类链接的期限长度仍然一致。
          ${link.status === 'disabled' ? '这条现在是停用状态，续期不会自动打开它。' : ''}</p></div>`,
    confirmText: '续期',
    onConfirm: async (mask) => {
      const v = $('#rn-days', mask).value;
      // 天数在提交时才算成具体时刻：弹窗开着不动一会儿，算出来的到期时间不该缩水
      const { result: r } = await api(`/admin/api/links/${encodeURIComponent(link.code)}/renew`, {
        method: 'POST',
        body: v === 'forever' ? { expireAt: null } : { expireAt: Date.now() + Number(v) * 86400000 },
      });
      toast(`/${link.code} 已续到 ${r.expireAt ? fmtExpire(r.expireAt) : '永久'}`, 'ok');
      render();
    },
  });
}

async function showStats(link) {
  const { result } = await api(`/admin/api/links/${encodeURIComponent(link.code)}/stats`);
  const max = Math.max(1, ...result.daily.map((d) => d.clicks));
  const bars = result.daily
    .map((d) => `<div class="bar" style="height:${Math.max(2, (d.clicks / max) * 100)}%" title="${esc(d.day)} · ${d.clicks} 次"></div>`)
    .join('');
  // 曝光与落地放同一张卡里：单独看点击数永远分不清「没人来」和「来了没进来」
  const windowClicks = result.daily.reduce((s, d) => s + d.clicks, 0);
  const rate = result.views ? `${((windowClicks / result.views) * 100).toFixed(0)}%` : '—';
  const list = (items, key) =>
    items.length
      ? items.map((i) => `<div class="row" style="justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--line)"><span class="truncate">${esc(i[key] || '直接访问')}</span><span class="mono muted">${num(i.clicks)}</span></div>`).join('')
      : '<p class="muted">暂无数据</p>';

  modal({
    title: `/${link.code} 统计`,
    wide: true,
    bodyHtml: `<div class="grid-cards" style="margin-bottom:14px">
      <div class="kpi"><div class="label">总点击</div><div class="value">${num(result.clicks)}</div></div>
      <div class="kpi"><div class="label">最近点击</div><div class="value" style="font-size:16px">${timeAgo(result.lastClickAt)}</div></div>
      <div class="kpi"><div class="label">近 30 天点击</div><div class="value">${num(windowClicks)}</div></div>
      <div class="kpi"><div class="label">建页曝光 / 落点率</div><div class="value" style="font-size:19px">${result.views ? `${num(result.views)} · ${rate}` : '未开启'}</div><div class="delta">${result.views ? '曝光不等于点击，两者分开记' : '这条短链没走建页，直接跳转'}</div></div>
    </div>
    <div class="bars-wrap" style="margin-bottom:18px"><div class="bars">${bars}</div>
      <div class="bars-axis"><span>${esc(result.daily[0]?.day.slice(5) || '')}</span><span>${esc(result.daily.at(-1)?.day.slice(5) || '')}</span></div></div>
    <div class="split">
      <div><label>来源站点</label>${list(result.referrers, 'host')}</div>
      <div><label>访问平台</label>${list(result.platforms, 'platform')}</div>
    </div>
    ${result.countries?.length ? `<div style="margin-top:16px"><label>访客地区</label>${list(result.countries.map((c) => ({ ...c, country: countryName(c.country) })), 'country')}</div>` : ''}
    <div style="margin-top:16px"><label>访问时段</label>${hourHeat(result.hours, { compact: true })}</div>
    ${result.targets?.length ? `<div style="margin-top:16px"><label>分流目标命中</label>${targetHitRows(result.targets)}</div>` : ''}
    ${expiryLine(result)}`,
  });
  $('#stats-renew')?.addEventListener('click', () => {
    document.querySelector('.modal-mask:last-of-type')?.remove();
    showRenew(result);
  });
}

/**
 * 统计弹窗里的有效期一行。
 *
 * 放在这里是因为「这条还能用多久」本来就和「这条被点了多少次」是同一个问题：
 * 数据好看、但明晚就到期，是两件必须一起看的事。快到期的直接给续期按钮，
 * 别让人再去列表里翻那一行。
 */
function expiryLine(link) {
  const now = Date.now();
  if (!link.expireAt) {
    return `<div class="row" style="margin-top:16px;gap:10px;align-items:center"><span class="tag tag-ok">永久有效</span><span class="muted">这条短链不会自己失效</span></div>`;
  }
  const left = link.expireAt - now;
  const days = Math.ceil(Math.abs(left) / 86400000);
  const text = left < 0 ? `已过期 ${days} 天` : days <= 1 ? '今天到期' : `还有 ${days} 天到期`;
  const cls = left < 0 ? 'tag-err' : days <= 3 ? 'tag-warn' : '';
  return `<div class="row" style="margin-top:16px;gap:10px;align-items:center">
      <span class="tag ${cls}">${text}</span>
      <span class="muted">${esc(fmtExpire(link.expireAt))}</span>
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-sm" id="stats-renew">${ic('clock')} 续期</button>
    </div>`;
}

/* ---------- 访问时段热力图 ---------- */
const DOW_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 把分组色（可能是 #rrggbb，也可能是 rgba(...)）乘上透明度。
 * 分组色里本来就有 rgba 写法，直接拼 rgba() 会拼出无效值，格子变全透明。
 */
function colorWithAlpha(color, alpha) {
  const text = String(color || '').trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha.toFixed(3)})`;
  }
  const rgb = /^rgba?\(([^)]+)\)/i.exec(text);
  if (rgb) {
    const parts = rgb[1].split(',').map((v) => v.trim()).slice(0, 3).join(',');
    return `rgba(${parts},${alpha.toFixed(3)})`;
  }
  return `rgba(139,92,246,${alpha.toFixed(3)})`;
}

/**
 * 7×24 热力图。cells 是扁平数组，下标 dow*24+hour。
 *
 * 峰值只按本次数据算，不做跨页面统一：这张图回答的是「这批点击在哪些时段
 * 最密」，不是「和别的页面比谁更热」。拿绝对值画色阶会得到一个只剩几个
 * 深色格子的图，看不出分布。
 */
function hourHeat(hours, { compact = false, color = '', hint = '' } = {}) {
  if (!hours || !hours.total) {
    return `<p class="muted">还没有时段数据。点击进来后，这里会显示一周里哪些小时最忙。${
      hours && hours.code ? '（升级前的历史点击没有记录时段，补不回来）' : ''
    }</p>`;
  }
  const peak = Math.max(1, hours.peak);
  // 找最忙的那一格，直接写出来——热力图看得出形状，说不出「几点」
  let bestIdx = 0;
  hours.cells.forEach((v, i) => {
    if (v > hours.cells[bestIdx]) bestIdx = i;
  });
  const bestDow = Math.floor(bestIdx / 24);
  const bestHour = bestIdx % 24;

  const head = ['', ...Array.from({ length: 24 }, (_, h) => `<i>${h % 6 === 0 ? h : ''}</i>`)].join('');
  const rows = DOW_LABEL.map((label, dow) => {
    const cells = Array.from({ length: 24 }, (_, hour) => {
      const n = hours.cells[dow * 24 + hour] || 0;
      const alpha = n ? 0.16 + (n / peak) * 0.84 : 0;
      // 分组视图按分组色着色，一眼对得上左边的色点；全站视图仍是品牌紫
      const style = n ? (color ? `background:${colorWithAlpha(color, alpha)}` : `background:rgba(139,92,246,${alpha.toFixed(3)})`) : '';
      return `<i class="${n ? 'on' : ''}" style="${style}" title="${label} ${String(hour).padStart(2, '0')}:00 · ${n} 次"></i>`;
    }).join('');
    return `<div class="heat-row"><span class="heat-dow">${label}</span><span class="heat-cells">${cells}</span></div>`;
  }).join('');

  return `<div class="heat ${compact ? 'heat-compact' : ''}">
    <div class="heat-grid">
      <div class="heat-row heat-head"><span class="heat-dow"></span><span class="heat-cells">${head}</span></div>
      ${rows}
    </div>
    <p class="hint">最忙的是 ${DOW_LABEL[bestDow]} ${String(bestHour).padStart(2, '0')}:00–${String((bestHour + 1) % 24).padStart(2, '0')}:00，共 ${num(hours.cells[bestIdx])} 次 · 按服务器本地时间统计${hint ? ` · ${hint}` : ''}</p>
  </div>`;
}

/**
 * 备份里各类明细统计的合计。新增一类统计时只改这一处——
 * 原先这个求和式在备份列表和预检里各写一遍，加 click_slots 时两处都漏了，
 * 界面上会显示成「统计比实际少」而不报错。
 */
function statTotal(counts) {
  if (!counts) return 0;
  return ['click_daily', 'click_refs', 'click_agents', 'click_countries', 'click_slots']
    .reduce((sum, key) => sum + (Number(counts[key]) || 0), 0);
}

/* ---------- 视图：来源分析 ---------- */
function barChart(daily, max) {
  const bars = daily
    .map((d) => `<div class="bar" style="height:${Math.max(3, (d.clicks / max) * 100)}%" title="${esc(d.day)} · ${d.clicks} 次"></div>`)
    .join('');
  const axis = daily.length
    ? `<div class="bars-axis"><span>${esc(daily[0].day.slice(5))}</span><span>${esc(daily.at(-1).day.slice(5))}</span></div>`
    : '';
  return `<div class="bars-wrap"><div class="bars">${bars}</div>${axis}</div>`;
}

async function viewSources(root) {
  const { result } = await api('/admin/api/sources?days=30');
  const total = result.totalClicks || 1;
  const share = (n) => ((n / total) * 100).toFixed(1);
  const max = Math.max(1, ...result.daily.map((d) => d.clicks));

  const refRows = result.refs.length
    ? result.refs
        .map((r) => `<div class="rank">
      <span class="rank-name truncate">${esc(r.host || '直接访问')}</span>
      <span class="rank-bar"><i style="width:${Math.max(2, (r.clicks / result.refs[0].clicks) * 100)}%"></i></span>
      <span class="rank-num mono">${num(r.clicks)}</span>
      <span class="rank-pct muted">${share(r.clicks)}%</span>
    </div>`)
        .join('')
    : '<p class="muted">还没有来源数据，短链被访问后这里会有内容。</p>';

  const agentRows = result.agents.length
    ? result.agents
        .map((a) => `<div class="rank">
      <span class="rank-name truncate">${esc(PLATFORM_LABEL[a.platform] || a.platform || '未知')}</span>
      <span class="rank-bar"><i style="width:${Math.max(2, (a.clicks / result.agents[0].clicks) * 100)}%"></i></span>
      <span class="rank-num mono">${num(a.clicks)}</span>
      <span class="rank-pct muted">${share(a.clicks)}%</span>
    </div>`)
        .join('')
    : '<p class="muted">还没有平台数据。</p>';

  // 「直接访问 / 无来源」单独一条：它没有域名，挂在站点榜里既点不开也没法比，
  // 但它往往真的是最大的一块，所以给一条和其他站点同一视觉重量的行
  const directRow = result.direct
    ? `<div class="rank">
      <span class="rank-name truncate"><i class="dotcolor" style="background:rgba(139,152,214,.45)"></i>直接访问 / 无来源</span>
      <span class="rank-bar"><i style="width:${Math.max(2, (result.direct / Math.max(1, result.refs[0]?.clicks || 1)) * 100)}%"></i></span>
      <span class="rank-num mono">${num(result.direct)}</span>
      <span class="rank-pct muted">${share(result.direct)}%</span>
    </div>`
    : '';

  const countryRows = (result.countries || []).length
    ? result.countries
        .map((c) => `<div class="rank">
      <span class="rank-name truncate">${esc(countryName(c.country))}</span>
      <span class="rank-bar"><i style="width:${Math.max(2, (c.clicks / result.countries[0].clicks) * 100)}%"></i></span>
      <span class="rank-num mono">${num(c.clicks)}</span>
      <span class="rank-pct muted">${share(c.clicks)}%</span>
    </div>`)
        .join('')
    : '<p class="muted">还没有地区数据。地区来自反向代理写入的国家码，直连访问不会有。</p>';

  root.innerHTML = `
  <div class="topbar"><div><h1>来源分析</h1><div class="sub">最近 30 天，按 referrer、访问平台与地区拆分</div></div><span class="spacer"></span>
    <a class="btn btn-ghost btn-sm" href="/admin/api/export.csv">导出 CSV</a>
  </div>
  <div class="grid-cards">
    <div class="kpi"><div class="label">已记录来源的点击</div><div class="value">${num(result.known)}</div><div class="delta">占全部点击 ${share(result.known)}%</div></div>
    <div class="kpi"><div class="label">直接访问 / 无来源</div><div class="value">${num(result.unknown)}</div><div class="delta">浏览器未上报 referrer</div></div>
    <div class="kpi"><div class="label">来源站点</div><div class="value">${num(result.refs.length)}</div><div class="delta">出现的不同域名</div></div>
    <div class="kpi"><div class="label">访问平台</div><div class="value">${num(result.agents.length)}</div><div class="delta">按 UA 粗分</div></div>
  </div>
  <section class="card" style="margin-bottom:18px">
    <div class="card-head"><h2>点击趋势</h2><span class="tag">近 30 天 ${num(result.daily.reduce((s, d) => s + d.clicks, 0))} 次</span></div>
    <div class="card-body">${barChart(result.daily, max)}</div>
  </section>
  <div class="split">
    <section class="card">
      <div class="card-head"><h2>来源站点 Top 30</h2></div>
      <div class="card-body stack" style="gap:10px">${refRows}${directRow}</div>
    </section>
    <section class="card">
      <div class="card-head"><h2>访问平台</h2></div>
      <div class="card-body stack" style="gap:10px">${agentRows}</div>
    </section>
  </div>
  <section class="card" style="margin-top:18px">
    <div class="card-head"><h2>访客地区</h2><span class="tag">来自代理写入的国家码</span></div>
    <div class="card-body stack" style="gap:10px">${countryRows}</div>
  </section>
  <section class="card" style="margin-top:18px">
    <div class="card-head"><h2>访问时段</h2><span class="tag">星期 × 小时 · 累计</span></div>
    <div class="card-body">${hourHeat(result.hours)}</div>
  </section>`;
}

/** 国家码显示成中文名，只覆盖常见的几十个；其余直接显示代码，不猜 */
const COUNTRY_NAMES = {
  CN: '中国', HK: '中国香港', TW: '中国台湾', MO: '中国澳门', JP: '日本', KR: '韩国', SG: '新加坡',
  US: '美国', CA: '加拿大', GB: '英国', DE: '德国', FR: '法国', NL: '荷兰', RU: '俄罗斯',
  AU: '澳大利亚', IN: '印度', BR: '巴西', IT: '意大利', ES: '西班牙', SE: '瑞典', CH: '瑞士',
  AE: '阿联酋', TH: '泰国', VN: '越南', MY: '马来西亚', ID: '印尼', PH: '菲律宾', TR: '土耳其',
};

function countryName(code) {
  const cc = String(code || '').toUpperCase();
  return COUNTRY_NAMES[cc] ? `${COUNTRY_NAMES[cc]} ${cc}` : cc || '未知';
}

const PLATFORM_LABEL = {
  ios: 'iOS',
  android: 'Android',
  windows: 'Windows',
  mac: 'macOS',
  linux: 'Linux',
  bot: '机器人',
  other: '其它',
  unknown: '未知',
};

/* ---------- 视图：UA 屏蔽 ---------- */
async function viewRules(root) {
  const { result } = await api('/admin/api/rules');
  const rows = result.items.length
    ? result.items
        .map(
          (r) => `<tr data-id="${r.id}">
      <td><span class="tag ${r.kind === 'ip' ? 'tag-brand' : ''}">${r.kind === 'ip' ? 'IP' : 'UA'}</span></td>
      <td class="mono">${esc(r.pattern)}</td>
      <td class="dim">${esc(r.note || '—')}</td>
      <td class="mono" style="text-align:right">${num(r.hits)}</td>
      <td><label class="switch"><input type="checkbox" data-toggle ${r.enabled ? 'checked' : ''}><span></span></label></td>
      <td style="width:1%"><button class="btn btn-ghost btn-sm btn-icon" data-del title="删除" aria-label="删除">${ic('trash')}</button></td>
    </tr>`,
        )
        .join('')
    : '<tr><td colspan="6"><div class="empty"><b>还没有屏蔽规则</b><span class="muted">添加一条试试，比如 *SemrushBot*</span></div></td></tr>';

  root.innerHTML = `
  <div class="topbar"><div><h1>UA 屏蔽</h1><div class="sub">拦截恶意爬虫与异常流量，命中不计入点击</div></div></div>
  ${result.skipped.length ? `<div class="banner warn">有 ${result.skipped.length} 条规则无法编译：${esc(result.skipped.map((s) => s.pattern).join('、'))}</div>` : ''}
  <div class="split">
    <section class="card">
      <div class="card-head"><h2>规则列表</h2><span class="tag">${result.uaRules} 条 UA · ${result.ipRules} 条 IP</span></div>
      <div class="table-wrap"><table class="tbl-rules">
        <thead><tr><th>类型</th><th>匹配规则</th><th>备注</th><th style="text-align:right">命中</th><th>启用</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </section>
    <section class="card">
      <div class="card-head"><h2>添加规则</h2></div>
      <div class="card-body">
        <form id="rule-form">
          <div class="field-row">
            <div class="field"><label>类型</label><select id="r-kind"><option value="ua">User-Agent</option><option value="ip">IP</option></select></div>
            <div class="field"><label>备注</label><input id="r-note" placeholder="例如：屏蔽 Semrush 爬虫" maxlength="120"></div>
          </div>
          <div class="field"><label>匹配规则</label>
            <input id="r-pattern" placeholder="*SemrushBot* 或 /bot|crawl/i" required>
            <p class="hint">支持三种写法：<br>1. 关键字（不区分大小写）<br>2. 通配符：<span class="mono">*bot*</span><br>3. 正则：<span class="mono">/googlebot|bingbot/i</span></p>
          </div>
          <button class="btn btn-primary" type="submit" data-writes>添加规则</button>
        </form>
      </div>
    </section>
  </div>`;

  $('#rule-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/admin/api/rules', {
        method: 'POST',
        body: { kind: $('#r-kind').value, pattern: $('#r-pattern').value, note: $('#r-note').value },
      });
      toast('规则已添加', 'ok');
      render();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  $$('tr[data-id]', root).forEach((tr) => {
    const id = tr.dataset.id;
    $('[data-del]', tr).addEventListener('click', () =>
      confirmDialog('删除规则', '确定删除这条屏蔽规则吗？', async () => {
        await api(`/admin/api/rules/${id}`, { method: 'DELETE' });
        toast('已删除', 'ok');
        render();
      }),
    );
    $('[data-toggle]', tr).addEventListener('change', async (e) => {
      await api(`/admin/api/rules/${id}`, { method: 'PATCH', body: { enabled: e.target.checked } }).catch((err) => toast(err.message, 'err'));
      toast(e.target.checked ? '已启用' : '已停用', 'ok');
    });
  });
}

/* ---------- 视图：迁移 ---------- */
async function viewMigrate(root) {
  root.innerHTML = `
  <div class="topbar"><div><h1>数据迁移</h1><div class="sub">从 YOURLS 或其它 HighURL 实例导入</div></div></div>
  <div class="split">
    <section class="card">
      <div class="card-head"><h2>导入数据</h2></div>
      <div class="card-body stack">
        <div>
          <label>选择文件</label>
          <label class="file-field" id="m-file-wrap">
            <input type="file" id="m-file" accept=".sql,.json,.csv,.txt">
            <span class="file-btn">选择文件</span>
            <span class="file-name">未选择任何文件</span>
          </label>
          <p class="hint">支持 YOURLS 的 MySQL dump（.sql）、HighURL 导出的 .json，以及在「备份恢复」页导出的 .csv</p>
        </div>
        <div>
          <label>或直接粘贴内容</label>
          <textarea id="m-text" placeholder="-- MySQL dump / JSON 内容" style="min-height:120px;font-family:var(--mono);font-size:12.5px"></textarea>
        </div>
        <label class="switch"><input type="checkbox" id="m-overwrite"><span>覆盖已存在的短码（默认跳过冲突项）</span></label>
        <div class="row">
          <button class="btn btn-ghost" id="m-preview">预检</button>
          <button class="btn btn-primary" id="m-apply" data-writes disabled>开始导入</button>
        </div>
      </div>
    </section>
    <section class="card"><div class="card-head"><h2>预检结果</h2></div><div class="card-body" id="m-result"><p class="muted">先选择文件或粘贴内容，然后点「预检」。</p></div></section>
  </div>`;

  let payload = null;
  const fileInput = $('#m-file');
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    bindFileName(fileInput);
    const text = await file.text();
    $('#m-text').value = text.length > 2000000 ? text.slice(0, 2000000) : '';
    payload = { content: text, filename: file.name };
    $('#m-result').innerHTML = `<p class="dim">已读取 <b>${esc(file.name)}</b>（${(file.size / 1024).toFixed(1)} KB）</p><p class="hint">点「预检」查看导入计划。</p>`;
  });

  $('#m-preview').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const content = payload?.content ?? $('#m-text').value;
      if (!content.trim()) throw new Error('请先选择文件或粘贴内容');
      const { result } = await api('/admin/api/migrate/preview', {
        method: 'POST',
        body: { content, filename: payload?.filename, overwrite: $('#m-overwrite').checked },
      });
      window.__migratePayload = content;
      window.__migrateFilename = payload?.filename;
      $('#m-apply').disabled = result.willImport === 0;
      $('#m-result').innerHTML = `<div class="grid-cards" style="margin-bottom:12px">
        <div class="kpi"><div class="label">识别为</div><div class="value" style="font-size:18px">${result.format === 'yourls' ? 'YOURLS' : result.format === 'csv' ? 'CSV' : 'HighURL'}</div></div>
        <div class="kpi"><div class="label">可导入</div><div class="value">${num(result.willImport)}</div></div>
        <div class="kpi"><div class="label">短码冲突</div><div class="value">${num(result.conflicts)}</div></div>
        <div class="kpi"><div class="label">无效条目</div><div class="value">${num(result.invalid)}</div></div>
      </div>
      ${result.samples.length ? `<label>导入样例</label><div class="code-block">${esc(result.samples.map((s) => `/${s.code} → ${s.url}${s.title ? '  · ' + s.title : ''}`).join('\n'))}</div>` : ''}
      ${result.conflictSamples.length ? `<p class="hint" style="margin-top:10px">冲突示例：${esc(result.conflictSamples.map((s) => s.code).join('、'))}</p>` : ''}
      ${result.invalidSamples.length ? `<p class="hint">无效示例：${esc(result.invalidSamples.map((s) => `${s.code}(${s.reason})`).join('、'))}</p>` : ''}`;
    } catch (err) {
      $('#m-result').innerHTML = `<div class="banner err">${esc(err.message)}</div>`;
    } finally {
      e.target.disabled = false;
    }
  });

  $('#m-apply').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const { result } = await api('/admin/api/migrate/apply', {
        method: 'POST',
        body: { content: window.__migratePayload, filename: window.__migrateFilename, overwrite: $('#m-overwrite').checked },
      });
      toast(`导入完成：新增 ${result.created}，更新 ${result.updated}`, 'ok');
      $('#m-result').innerHTML = `<div class="banner">导入完成：新增 <b>${result.created}</b> 条，更新 <b>${result.updated}</b> 条，跳过冲突 ${result.conflicts} 条${result.groups ? `，顺带新建 <b>${result.groups}</b> 个分组` : ''}。</div>
        <a class="btn btn-primary btn-sm" href="#/links">查看短链</a>`;
    } catch (err) {
      toast(err.message, 'err');
      e.target.disabled = false;
    }
  });
}

/* ---------- 视图：API 密钥 ---------- */
async function viewApi(root) {
  const { result } = await api('/admin/api/keys');
  const rows = result.length
    ? result
        .map(
          (k) => `<tr data-id="${k.id}">
      <td><b>${esc(k.name)}</b></td>
      <td class="mono dim">${esc(k.prefix)}…</td>
      <td><span class="tag">${esc(k.scope)}</span></td>
      <td>${k.enabled ? '<span class="tag tag-ok">启用</span>' : '<span class="tag tag-err">停用</span>'}</td>
      <td class="muted">${timeAgo(k.last_used_at)}</td>
      <td style="width:1%"><div class="row">
        <button class="btn btn-ghost btn-sm" data-toggle>${k.enabled ? '停用' : '启用'}</button>
        <button class="btn btn-ghost btn-sm btn-icon" data-del title="删除" aria-label="删除">${ic('trash')}</button>
      </div></td>
    </tr>`,
        )
        .join('')
    : '<tr><td colspan="6"><div class="empty"><b>还没有 API 密钥</b><span class="muted">创建一个用于脚本调用</span></div></td></tr>';

  root.innerHTML = `
  <div class="topbar"><div><h1>API 密钥</h1><div class="sub">用 Bearer Token 调用 /api/v1/* 接口</div></div><span class="spacer"></span>
    <a class="btn btn-ghost btn-sm" href="/docs" target="_blank">API 文档</a>
  </div>
  <div class="split">
    <section class="card">
      <div class="card-head"><h2>密钥列表</h2></div>
      <div class="table-wrap"><table class="tbl-keys">
        <thead><tr><th>名称</th><th>前缀</th><th>权限</th><th>状态</th><th>最近使用</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </section>
    <section class="card">
      <div class="card-head"><h2>创建密钥</h2></div>
      <div class="card-body">
        <form id="key-form">
          <div class="field"><label>名称</label><input id="k-name" placeholder="例如：CI 部署脚本" maxlength="60"></div>
          <div class="field"><label>权限</label>
            <select id="k-scope"><option value="read,write">读写（创建/修改/删除）</option><option value="read">只读（查询）</option></select>
          </div>
          <button class="btn btn-primary" type="submit" data-writes>生成密钥</button>
        </form>
      </div>
    </section>
  </div>
  <div id="new-key"></div>`;

  $('#key-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { result: key } = await api('/admin/api/keys', {
        method: 'POST',
        body: { name: $('#k-name').value, scope: $('#k-scope').value },
      });
      $('#new-key').innerHTML = `<div class="banner" style="margin-top:18px">
        <b>新密钥（只显示这一次）</b>
        <div class="row" style="margin-top:8px"><input readonly value="${esc(key.key)}" id="new-key-val">
        <button class="btn btn-primary btn-sm" id="new-key-copy">复制</button></div>
      </div>`;
      $('#new-key-copy').addEventListener('click', () => copy(key.key));
      $('#k-name').value = '';
      render();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  $$('tr[data-id]', root).forEach((tr) => {
    const id = tr.dataset.id;
    const key = result.find((k) => String(k.id) === id);
    $('[data-toggle]', tr).addEventListener('click', async () => {
      await api(`/admin/api/keys/${id}`, { method: 'PATCH', body: { enabled: !key.enabled } });
      render();
    });
    $('[data-del]', tr).addEventListener('click', () =>
      confirmDialog('删除密钥', '删除后使用该密钥的脚本将立即失效。', async () => {
        await api(`/admin/api/keys/${id}`, { method: 'DELETE' });
        toast('已删除', 'ok');
        render();
      }),
    );
  });
}

/* ---------- 视图：备份恢复 ---------- */
async function viewBackup(root) {
  root.innerHTML = `
  <div class="topbar"><div><h1>备份恢复</h1><div class="sub">整库导出、导入与自动备份</div></div></div>
  <div class="split">
    <section class="card">
      <div class="card-head"><h2>导出</h2></div>
      <div class="card-body stack">
        <p class="dim">JSON 便于跨版本迁移与恢复，SQL 便于用 sqlite3 直接接管。</p>
        <div class="row" style="flex-wrap:wrap">
          <a class="btn btn-primary btn-sm" href="/admin/api/backup" download>下载 JSON 备份</a>
          <a class="btn btn-ghost btn-sm" href="/admin/api/backup/sql" download>下载 SQL 备份 (.sql.gz)</a>
          <a class="btn btn-ghost btn-sm" href="/admin/api/export.csv" download>导出 CSV</a>
        </div>
        <p class="hint">数据目录中的 <span class="mono">backups/</span> 每天自动生成一份 JSON 备份，保留最近 14 份。</p>
      </div>
    </section>
    <section class="card">
      <div class="card-head"><h2>恢复</h2></div>
      <div class="card-body stack">
        <div>
          <label>选择备份文件</label>
          <label class="file-field" id="b-file-wrap">
            <input type="file" id="b-file" accept=".json">
            <span class="file-btn">选择文件</span>
            <span class="file-name">未选择任何文件</span>
          </label>
        </div>
        <div><label>恢复方式</label>
          <select id="b-mode"><option value="merge">合并（同短码覆盖）</option><option value="replace">替换（清空后导入）</option></select>
        </div>
        <label class="switch"><input type="checkbox" id="b-settings"><span>同时恢复站点设置（baseUrl 等）</span></label>
        <button class="btn btn-primary" id="b-apply" data-writes disabled>开始恢复</button>
        <p class="hint">选文件后先点「预检」看清会变成什么样，再决定是否替换。替换模式会清空现有短链、分组与统计。</p>
      </div>
    </section>
  </div>
  <section class="card" style="margin-top:18px">
    <div class="card-head"><h2>自动备份</h2><span class="tag" id="b-auto-tag">读取中…</span></div>
    <div class="card-body" id="b-auto">
      <p class="muted">正在读取数据目录…</p>
    </div>
  </section>
  <div id="b-report"></div>`;

  loadAutoBackups();

  /**
   * 自动备份列表。文件在不在是一眼能看的事，「文件在但已经坏了」不行——
   * 所以每个 JSON 都当场算校验和，坏了直接标出来，别等真要用的时候才发现。
   */
  async function loadAutoBackups() {
    const box = $('#b-auto');
    try {
      const { result } = await api('/admin/api/backups');
      const items = result.items || [];
      $('#b-auto-tag').textContent = `${items.length} 份 · 保留 ${result.retention} 份 · ${result.dir}`;
      if (!items.length) {
        box.innerHTML = '<div class="empty"><b>还没有自动备份</b><span class="muted">服务每天第一次维护时会生成一份 JSON 备份</span></div>';
        return;
      }
      const label = {
        ok: '<span class="tag tag-ok">完整</span>',
        mismatch: '<span class="tag tag-err">校验不通过</span>',
        legacy: '<span class="tag tag-warn">无校验和</span>',
        invalid: '<span class="tag tag-err">文件损坏</span>',
        unchecked: '<span class="tag">未校验</span>',
      };
      box.innerHTML = `<div class="table-wrap"><table class="tbl-backups">
        <thead><tr><th>文件</th><th>大小</th><th>短链 / 统计</th><th>状态</th><th></th></tr></thead>
        <tbody>${items
          .map((b) => {
            const stat = b.counts ? statTotal(b.counts) : 0;
            return `<tr data-name="${esc(b.name)}">
              <td><div class="cell-title"><b class="truncate mono">${esc(b.name)}</b>
                <span class="cell-url">${esc(b.hostname || '未知主机')}${b.appVersion ? ` · v${esc(b.appVersion)}` : ''}</span></div></td>
              <td class="muted">${fmtBytes(b.size)}</td>
              <td class="mono" style="text-align:right">${b.counts ? `${num(b.counts.links)} / ${num(stat)}` : '—'}</td>
              <td>${label[b.integrity] || '<span class="tag">—</span>'}</td>
              <td style="width:1%"><div class="row">
                <button class="btn btn-ghost btn-sm" data-check>复核</button>
                <button class="btn btn-ghost btn-sm" data-restore-file>用于恢复</button>
                <a class="btn btn-ghost btn-sm" href="/admin/api/backups/${encodeURIComponent(b.name)}" download>下载</a>
              </div></td>
            </tr>`;
          })
          .join('')}</tbody>
      </table></div>
      <p class="hint" style="margin-top:10px">「用于恢复」会把这份文件读进来走一遍预检，恢复前仍然先看账再动手。</p>`;

      $$('#b-auto tr[data-name]').forEach((tr) => {
        const name = tr.dataset.name;
        $('[data-check]', tr).addEventListener('click', async (e) => {
          // 先取住按钮再 await：事件派发结束后 e.currentTarget 会被置空，
          // 拿它去改 disabled 会直接抛 "Cannot set properties of null"
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            const { result: v } = await api(`/admin/api/backups/${encodeURIComponent(name)}/verify`);
            if (v.status === 'ok') toast('校验通过：文件与导出时一致', 'ok');
            else if (v.status === 'legacy') toast('这份备份没有校验和，只能确认结构完整', '');
            else if (v.status === 'unchecked') toast(v.reason, '');
            else toast(`校验不通过：${v.reason}`, 'err');
          } catch (err) {
            toast(err.message, 'err');
          } finally {
            btn.disabled = false;
          }
        });
        $('[data-restore-file]', tr).addEventListener('click', async () => {
          if (!name.endsWith('.json')) return toast('SQL 备份请用 sqlite3 接管，这里只能恢复 JSON', 'err');
          try {
            const res = await fetch(`/admin/api/backups/${encodeURIComponent(name)}`);
            if (!res.ok) throw new Error('下载失败');
            const text = await res.text();
            const file = new File([text], name, { type: 'application/json' });
            const dt = new DataTransfer();
            dt.items.add(file);
            const el = $('#b-file');
            el.files = dt.files;
            bindFileName(el);
            $('#b-apply').disabled = true;
            await previewBackup(file);
            $('#b-report').scrollIntoView({ behavior: 'smooth', block: 'start' });
          } catch (err) {
            toast(err.message, 'err');
          }
        });
      });
    } catch (err) {
      box.innerHTML = `<div class="banner err">${esc(err.message)}</div>`;
    }
  }

  const input = $('#b-file');
  input.addEventListener('change', () => {
    bindFileName(input);
    $('#b-apply').disabled = true;
    $('#b-report').innerHTML = '';
    const file = input.files?.[0];
    if (file) previewBackup(file);
  });

  /** 预检：把「这份备份会带来什么」摆出来，恢复是不可逆操作，先看清再点 */
  async function previewBackup(file) {
    const box = $('#b-report');
    box.innerHTML = '<section class="card"><div class="card-body"><p class="muted">正在解析备份…</p></div></section>';
    try {
      const content = await file.text();
      const { result: p } = await api('/admin/api/restore/preview', { method: 'POST', body: { content } });
      const stat = statTotal(p.counts);
      const integ = p.integrity || { status: 'legacy' };
      const badge = {
        ok: '<span class="tag tag-ok">完整性通过</span>',
        mismatch: '<span class="tag tag-err">校验不通过</span>',
        legacy: '<span class="tag tag-warn">无校验和</span>',
      }[integ.status] || '';
      const integRow = `<div class="integrity ${integ.status}">
        <div class="row" style="flex-wrap:wrap;gap:8px;align-items:center">${badge}
          <span class="muted">来源 ${esc(p.manifest?.hostname || '未知主机')} · HighURL ${esc(p.manifest?.appVersion || '?')}</span>
          ${integ.actual ? `<span class="mono dim" style="font-size:12px">sha256 ${esc(String(integ.actual).slice(0, 16))}…</span>` : ''}
        </div>
        <p class="hint" style="margin:8px 0 0">${
          integ.status === 'ok'
            ? '校验和与导出时一致，这份文件没被改动过。'
            : integ.status === 'mismatch'
              ? `${esc(integ.reason)}。合并恢复会把缺的那部分当成「不需要恢复」，所以默认拦下——确认真要用这份文件，勾选下面的「忽略校验」。`
              : '这份备份早于校验和功能，只能确认结构完整，无法确认内容一致。'
        }</p>
      </div>`;
      box.innerHTML = `<section class="card" style="margin-top:18px">
        <div class="card-head"><h2>预检</h2><span class="tag">备份 v${p.version ?? '?'}${p.exportedAt ? ' · ' + p.exportedAt.slice(0, 10) : ''}</span></div>
        <div class="card-body">
          ${integRow}
          <div class="grid-cards" style="margin-bottom:14px">
            <div class="kpi"><div class="label">新增短链</div><div class="value">${num(p.links.create)}</div><div class="delta">备份共 ${num(p.links.total)} 条</div></div>
            <div class="kpi"><div class="label">覆盖已有</div><div class="value">${num(p.links.overwrite)}</div><div class="delta">短码相同</div></div>
            <div class="kpi"><div class="label">分组 / 分流目标</div><div class="value" style="font-size:20px">${num(p.counts.groups)} / ${num(p.counts.link_targets)}</div><div class="delta">按名字重建分组</div></div>
            <div class="kpi"><div class="label">明细统计</div><div class="value">${num(stat)}</div><div class="delta">点击/来源/平台/地区/时段</div></div>
          </div>
          ${p.links.skipped ? `<div class="banner warn">有 ${p.links.skipped} 条记录短码或链接不合法，将被跳过。</div>` : ''}
          <p class="hint">屏蔽规则 ${num(p.rules)} 条，站点设置 ${num(p.settings)} 项（勾选上面的开关才会写入）。</p>
          ${integ.status === 'mismatch' ? '<label class="switch" style="margin-top:10px"><input type="checkbox" id="b-force"><span>忽略校验，仍然用这份文件恢复</span></label>' : ''}
        </div>
      </section>`;
      box.dataset.content = content;
      box.dataset.checksum = integ.status === 'mismatch' ? 'bad' : 'ok';
      $('#b-apply').disabled = p.links.total === 0;
    } catch (err) {
      box.innerHTML = `<div class="banner err" style="margin-top:18px">${esc(err.message)}</div>`;
    }
  }

  $('#b-apply').addEventListener('click', async (e) => {
    const applyBtn = e.currentTarget;
    const content = $('#b-report').dataset.content;
    if (!content) return toast('请先选择备份文件', 'err');
    const mode = $('#b-mode').value;
    const withSettings = $('#b-settings').checked;
    const force = Boolean($('#b-force')?.checked);
    confirmDialog(
      '确认恢复',
      mode === 'replace'
        ? '替换模式将清空现有短链、分组与统计，再全量导入备份。确定继续？'
        : '合并模式会用备份中的同短码覆盖现有记录。确定继续？',
      async () => {
        applyBtn.disabled = true;
        try {
          const { result: r } = await api('/admin/api/restore', { method: 'POST', body: { content, mode, withSettings, force } });
          toast(`恢复完成：短链 ${r.restored}，分组 ${r.groups}，分流目标 ${r.targets}`, 'ok');
          render();
        } catch (err) {
          toast(err.message, 'err');
        } finally {
          applyBtn.disabled = false;
        }
      },
      // 恢复不是删除，按钮就别写「确认删除」；替换模式才提示危险色
      { confirmText: mode === 'replace' ? '替换并恢复' : '开始恢复', danger: mode === 'replace' },
    );
  });
}

/* ---------- 视图：审计日志 ---------- */
const ACTION_LABEL = {
  'link.create': '新建短链',
  'link.update': '修改短链',
  'link.delete': '移入回收站',
  'link.purge': '彻底删除',
  'link.purge_all': '清空回收站',
  'link.purge_expired': '回收站自动清理',
  'link.restore': '恢复短链',
  'group.create': '新建分组',
  'group.update': '修改分组',
  'group.delete': '删除分组',
  'link.password': '访问密码',
  'link.batch_enable': '批量启用',
  'link.batch_disable': '批量停用',
  'link.batch_delete': '批量删除',
  'link.qr_export': '二维码 ZIP',
  'link.batch_group': '批量改分组',
  'link.batch_tags': '批量改标签',
  'link.renew': '续期',
  'link.batch_renew': '批量续期',
  'stats.collect_orphans': '清理孤儿统计',
  'link.qr_sheet': '拼版打印',
  'link.expire_sweep': '过期回收',
  'link.health_check': '链接巡检',
  'link.code_dedupe': '短码去重',
  'link.rollback': '回滚版本',
  'settings.update': '修改设置',
  'key.create': '创建密钥',
  'key.delete': '删除密钥',
  'rule.create': '新增屏蔽规则',
  'rule.delete': '删除屏蔽规则',
  'migrate.apply': '导入数据',
  'migrate.import': '导入数据',
  restore: '恢复备份',
  install: '初始化系统',
  'auth.login': '登录',
  'auth.login_failed': '登录失败',
  'auth.password_change': '修改密码',
  'digest.push': '手动推送摘要',
  'notify.channel_create': '新建通知渠道',
  'notify.channel_update': '修改通知渠道',
  'notify.channel_delete': '删除通知渠道',
  'notify.retry': '重发通知',
};

async function viewAudit(root) {
  const { page, filter } = state.audit;
  const params = new URLSearchParams({ page, perPage: 50 });
  if (filter) params.set('filter', filter);
  const { result } = await api(`/admin/api/audit?${params}`);
  state.audit.page = result.page;

  const rows = result.items.length
    ? result.items
        .map(
          (a) => `<tr>
      <td class="muted" style="white-space:nowrap">${fmtDate(a.at)}</td>
      <td><span class="tag ${a.action.includes('delete') || a.action.includes('failed') ? 'tag-err' : 'tag-brand'}">${esc(ACTION_LABEL[a.action] || a.action)}</span></td>
      <td><b>${esc(a.actor || '—')}</b></td>
      <td class="dim mono" style="word-break:break-all">${esc(a.detail || '—')}</td>
    </tr>`,
        )
        .join('')
    : '<tr><td colspan="4"><div class="empty"><b>还没有记录</b><span class="muted">新建一条短链就会出现</span></div></td></tr>';

  root.innerHTML = `
  <div class="topbar"><div><h1>审计日志</h1><div class="sub">谁在什么时候动了什么，共 ${num(result.total)} 条</div></div><span class="spacer"></span>
    <select id="audit-filter">
      <option value="">全部动作</option>
      ${result.actions
        .map((a) => `<option value="${esc(a.action)}" ${filter === a.action ? 'selected' : ''}>${esc(ACTION_LABEL[a.action] || a.action)} (${a.n})</option>`)
        .join('')}
    </select>
  </div>
  <div class="card">
    <div class="table-wrap"><table class="tbl-audit">
      <thead><tr><th>时间</th><th>动作</th><th>操作者</th><th>详情</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="pager">
      <span>第 ${result.page} / ${result.pages} 页</span>
      <button class="btn btn-ghost btn-sm" data-page="prev" ${result.page <= 1 ? 'disabled' : ''}>上一页</button>
      <button class="btn btn-ghost btn-sm" data-page="next" ${result.page >= result.pages ? 'disabled' : ''}>下一页</button>
    </div>
  </div>`;

  $('#audit-filter').addEventListener('change', (e) => {
    state.audit.filter = e.target.value;
    state.audit.page = 1;
    render();
  });
  $$('[data-page]', root).forEach((btn) =>
    btn.addEventListener('click', () => {
      state.audit.page += btn.dataset.page === 'next' ? 1 : -1;
      render();
    }),
  );
}

/* ---------- 视图：设置 ---------- */
async function viewSettings(root) {
  const { result } = await api('/admin/api/settings');
  const v = result.values;
  const bool = (key, label, hint) => `
    <label class="switch" style="margin-bottom:14px"><input type="checkbox" data-key="${key}" ${v[key] ? 'checked' : ''}><span>${label}</span></label>
    ${hint ? `<p class="hint" style="margin:-8px 0 16px 52px">${hint}</p>` : ''}`;

  root.innerHTML = `
  <div class="topbar"><div><h1>系统设置</h1><div class="sub">改动即时生效，无需重启</div></div></div>
  <div class="split">
    <section class="card">
      <div class="card-head"><h2>站点</h2></div>
      <div class="card-body">
        <div class="field"><label>站点名称</label><input data-key="siteName" value="${esc(v.siteName)}"></div>
        <div class="field"><label>站点描述</label><input data-key="siteDescription" value="${esc(v.siteDescription)}"></div>
        <div class="field"><label>站点地址</label><input data-key="baseUrl" value="${esc(v.baseUrl)}" placeholder="https://s.example.com">
          <p class="hint">用于生成完整短链接与校验来源，反代后建议填写</p></div>
        <div class="field"><label>短码长度</label><input data-key="codeLength" type="number" min="3" max="32" value="${v.codeLength}"></div>
        <div class="field"><label>跳转状态码</label>
          <select data-key="redirectStatus">
            ${[301, 302, 307, 308].map((s) => `<option value="${s}" ${Number(v.redirectStatus) === s ? 'selected' : ''}>${s}${s === 301 ? '（永久，会被浏览器缓存）' : ''}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>404 跳转地址</label><input data-key="notFoundUrl" value="${esc(v.notFoundUrl)}" placeholder="留空显示站内提示页">
          <p class="hint">可用占位符 {code} 与 {url}</p></div>
      </div>
    </section>
    <section class="card">
      <div class="card-head"><h2>行为</h2></div>
      <div class="card-body">
        ${bool('publicCreate', '允许游客创建短链', '关闭后只有登录管理员可以创建')}
        ${bool('titleFetch', '自动抓取标题', '创建时读取目标网页的标题')}
        ${bool('blockBots', '屏蔽爬虫访问', '对所有已知爬虫返回 403，并加上 noindex')}
        ${bool('interstitialDefault', '新短链默认开启跳转前建页', '只在新建时生效，不会改到已有短链；单条也可以在编辑里单独开关')}
        ${bool('allowReport', '名片页显示举报入口', '收到的人可以在 /<短码>+ 上反馈垃圾、钓鱼等问题，举报只进队列，不会自动停链')}
        <div class="field"><label>点击去重窗口（秒）</label><input data-key="dedupeWindowSec" type="number" min="0" value="${v.dedupeWindowSec}">
          <p class="hint">同一 IP 对同一条短链，窗口内重复点击只计一次；0 表示不去重。跳转本身不受影响</p></div>
        ${bool('trustProxy', '信任反向代理头', '在 Nginx / Caddy 后面部署时打开，用于获取真实 IP 与访客地区（X-Country-Code / X-Geo-Country）')}
        <div class="field-row">
          <div class="field"><label>抓取超时（ms）</label><input data-key="titleTimeout" type="number" value="${v.titleTimeout}"></div>
          <div class="field"><label>保留明细天数</label><input data-key="retentionDays" type="number" value="${v.retentionDays}">
            <p class="hint">0 表示永久保留</p></div>
        </div>
        <div class="field-row">
          <div class="field"><label>过期链接处理</label>
            <select data-key="expiredPolicy">
              ${[
                ['none', '不处理（访问返回 410）'],
                ['disable', '自动停用（保留记录）'],
                ['delete', '自动删除（连同统计）'],
              ].map(([val, label]) => `<option value="${val}" ${v.expiredPolicy === val ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>过期宽限期（天）</label><input data-key="expiredGraceDays" type="number" min="0" value="${v.expiredGraceDays}">
            <p class="hint">过期后再等这么多天才处理，留出补救时间</p></div>
        </div>
        <div class="field-row">
          <div class="field"><label>回收站保留天数</label><input data-key="trashRetentionDays" type="number" min="0" value="${v.trashRetentionDays}">
            <p class="hint">0 表示一直保留，等你在回收站里手动处理</p></div>
          <div class="field"><label>每条短链保留历史版本</label><input data-key="historyKeep" type="number" min="0" max="200" value="${v.historyKeep}">
            <p class="hint">0 表示不留历史，也就不能回滚</p></div>
        </div>
        <div class="field-row">
          <div class="field"><label>目标链接巡检间隔（分钟）</label><input data-key="healthCheckIntervalMin" type="number" min="0" value="${v.healthCheckIntervalMin}">
            <p class="hint">0 表示不自动巡检，仍可在短链页手动点一次。这是唯一会主动外发请求的功能</p></div>
          <div class="field"><label>巡检单次超时（ms）</label><input data-key="healthCheckTimeout" type="number" min="1000" max="30000" value="${v.healthCheckTimeout}"></div>
        </div>
      </div>
    </section>
    <section class="card">
      <div class="card-head"><h2>跳转前建页</h2><span class="tag">组织级配置，全站建页共用</span></div>
      <div class="card-body">
        <div class="field"><label>组织名称</label><input data-key="landingOrgName" value="${esc(v.landingOrgName || '')}" placeholder="留空则显示站点名称">
          <p class="hint">显示在建页页头，替代「HighURL」这类站点名，让人知道是谁给的链接</p></div>
        <div class="field"><label>组织 Logo 地址</label><input data-key="landingLogoUrl" value="${esc(v.landingLogoUrl || '')}" placeholder="/img/logo.svg 或 https://...">
          <p class="hint">只接受站内绝对路径或 http(s) 地址；留空用站点图标</p></div>
        <div class="field"><label>免责声明</label><textarea data-key="landingDisclaimer" rows="3" maxlength="500" placeholder="例如：本站仅提供链接跳转，目标页面内容与本组织无关。">${esc(v.landingDisclaimer || '')}</textarea>
          <p class="hint">最多 500 字，换行会分段显示在建页底部</p></div>
        <div class="field"><label>倒数提示（秒）</label><input data-key="landingCountdown" type="number" min="0" max="30" value="${v.landingCountdown ?? 0}">
          <p class="hint">0 表示不显示。这里只加一句提醒，**不会自动跳转**——那个「看清楚域名」的窗口不能靠倒计时消失</p></div>
      </div>
    </section>
    <section class="card">
      <div class="card-head"><h2>事件通知</h2><a class="btn btn-ghost btn-sm" href="#/notify">推送渠道</a></div>
      <div class="card-body">
        <div class="field-row">
          <div class="field"><label>提前多少天提醒到期</label><input data-key="notifyExpireDays" type="number" min="1" max="90" value="${v.notifyExpireDays}">
            <p class="hint">每天最多推一条，把这一批快到期的一起说明。这个设置只影响通知，不影响列表里的到期筛选</p></div>
          <div class="field"><label>同一事件去重窗口（小时）</label><input data-key="notifyDedupeHours" type="number" min="0" max="720" value="${v.notifyDedupeHours}">
            <p class="hint">死链每轮巡检都会被再判一次，同一渠道同一主体在窗口内只推一次；0 表示不去重</p></div>
        </div>
        ${bool('notifyAllowPrivate', '允许推送到内网地址', '默认关。接收端地址是管理员填的，但一个填错的地址不该让本站变成探测内网的跳板；自建接收端再打开')}
      </div>
    </section>
    <section class="card">
      <div class="card-head"><h2>性能</h2></div>
      <div class="card-body">
        <div class="field-row">
          <div class="field"><label>计数落库间隔（ms）</label><input data-key="countFlushMs" type="number" value="${v.countFlushMs}">
            <p class="hint">越大越省 IO，异常退出时最多丢失该时长的点击</p></div>
          <div class="field"><label>计数缓冲上限</label><input data-key="countCacheMax" type="number" value="${v.countCacheMax}"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>全局限流（次/分钟/IP）</label><input data-key="rateLimitPerMinute" type="number" value="${v.rateLimitPerMinute}"></div>
          <div class="field"><label>创建限流（次/分钟/IP）</label><input data-key="createRateLimitPerMinute" type="number" value="${v.createRateLimitPerMinute}"></div>
        </div>
        <div class="field"><label>保留路径（逗号分隔）</label><input data-key="reservedCodes" value="${esc(v.reservedCodes)}"></div>
      </div>
    </section>
    <section class="card">
      <div class="card-head"><h2>账号与运行环境</h2></div>
      <div class="card-body stack">
        <div class="row"><button class="btn btn-ghost btn-sm" id="pwd-btn">修改我的密码</button><span class="spacer"></span>
          <span class="tag mono">${esc(result.meta.dataDir)}</span></div>
        <dl class="kv">
          <dt>版本</dt><dd>${esc(result.meta.version)}</dd>
          <dt>主机名</dt><dd>${esc(result.meta.hostname)}</dd>
          <dt>数据库</dt><dd class="mono">SQLite (WAL)</dd>
        </dl>
        <button class="btn btn-primary" id="save-btn" data-writes>保存设置</button>
      </div>
    </section>
    <section class="card">
      <div class="card-head"><h2>数据自检</h2><button class="btn btn-ghost btn-sm" id="doctor-btn">重新检查</button></div>
      <div class="card-body" id="doctor-body"><p class="muted">检查中…</p></div>
    </section>
  </div>`;

  const loadDoctor = async () => {
    const body = $('#doctor-body');
    if (!body) return;
    try {
      const { result: d } = await api('/admin/api/doctor');
      const total = d.orphans.total;
      body.innerHTML = `<dl class="kv">
          <dt>统计孤儿行</dt><dd>${total ? `<span class="tag tag-warn">${num(total)} 行</span>` : '<span class="tag tag-ok">无</span>'}</dd>
          <dt>短码冲突</dt><dd>${d.duplicateCodes ? `<span class="tag tag-err">${d.duplicateCodes} 组</span>` : '<span class="tag tag-ok">无</span>'}</dd>
          <dt>数据库版本</dt><dd class="mono">v${d.schemaVersion}</dd>
          <dt>待落库点击</dt><dd>${num(d.counters.pendingClicks)}</dd>
          <dt>去重跳过</dt><dd>${num(d.dedupe?.skipped || 0)}</dd>
        </dl>
        ${total ? `<p class="hint">孤儿行是短链被彻底删除后残留的点击明细，不影响访问，只是白占空间。</p>
          <button class="btn btn-ghost btn-sm" id="collect-btn">清理孤儿统计</button>` : ''}`;
      $('#collect-btn')?.addEventListener('click', async (e) => {
        e.target.disabled = true;
        try {
          const { result: r } = await api('/admin/api/doctor/collect', { method: 'POST' });
          toast(`已清理 ${num(r.removed)} 行`, 'ok');
          loadDoctor();
        } catch (err) {
          toast(err.message, 'err');
          e.target.disabled = false;
        }
      });
    } catch (err) {
      body.innerHTML = `<p class="muted">检查失败：${esc(err.message)}</p>`;
    }
  };
  loadDoctor();

  $('#save-btn').addEventListener('click', async (e) => {
    e.target.disabled = true;
    const patch = {};
    $$('[data-key]', root).forEach((el) => {
      // textarea 没有 type 属性，必须先按标签名拦掉，否则多行免责声明会被 Number() 变成 NaN
      if (el.tagName === 'TEXTAREA') patch[el.dataset.key] = el.value;
      else if (el.tagName === 'SELECT' || el.type === 'number') patch[el.dataset.key] = Number(el.value);
      else if (el.type === 'checkbox') patch[el.dataset.key] = el.checked;
      else patch[el.dataset.key] = el.value;
    });
    try {
      const { rejected } = await api('/admin/api/settings', { method: 'PATCH', body: patch });
      toast(rejected?.length ? `已保存，忽略无效项：${rejected.join(',')}` : '设置已保存', 'ok');
      render();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      e.target.disabled = false;
    }
  });

  $('#pwd-btn').addEventListener('click', () => {
    modal({
      title: '修改密码',
      bodyHtml: `<div class="field"><label>原密码</label><input id="p-old" type="password" autocomplete="current-password"></div>
        <div class="field"><label>新密码</label><input id="p-new" type="password" autocomplete="new-password"><p class="hint">至少 8 位</p></div>`,
      onConfirm: async (mask) => {
        await api('/admin/api/password', {
          method: 'POST',
          body: { oldPassword: $('#p-old', mask).value, newPassword: $('#p-new', mask).value },
        });
        toast('密码已更新', 'ok');
      },
    });
  });
}

/* ---------- 视图：分组 ---------- */
const GROUP_COLORS = ['#8b5cf6', '#5b8bff', '#22d3ee', '#34d399', '#fbbf24', '#f87171', '#f472b6'];

async function viewGroups(root) {
  const [{ result }, trend, hours] = await Promise.all([
    api('/admin/api/groups'),
    api('/admin/api/groups/trend?days=14'),
    api('/admin/api/groups/hours'),
  ]);
  const items = result.items || [];
  const total = items.reduce((s, g) => s + g.links, 0) + (result.ungrouped || 0);

  // 分组趋势：每组一条迷你柱状，按近 14 天点击降序，多出来的归到一张「其它」
  const trendEach = [...trend.result.groups, { ...trend.result.ungrouped, color: '' }]
    .map((g) => ({ ...g, sum: g.daily.reduce((s, d) => s + d.clicks, 0) }))
    .sort((a, b) => b.sum - a.sum);
  const trendShown = trendEach.slice(0, 6);
  // 已删除的分组还会剩下没清掉的点击。不画出来，条形高度就会比总点击数矮一截，
  // 而图上看不出「矮了」，只像是这段日子本来就这么点量
  if (trend.result.orphanGroup) {
    const g = trend.result.orphanGroup;
    trendEach.push({
      name: g.name,
      color: 'rgba(139,152,214,.3)',
      sum: g.daily.reduce((s, d) => s + d.clicks, 0),
      daily: g.daily,
    });
  }
  const trendRest = trendEach.slice(6);
  if (trendRest.length) {
    trendShown.push({
      name: `其它 ${trendRest.length} 个分组`,
      color: 'rgba(139,152,214,.45)',
      sum: trendRest.reduce((s, g) => s + g.sum, 0),
      daily: trendRest[0].daily.map((d, i) => ({ day: d.day, clicks: trendRest.reduce((s, g) => s + g.daily[i].clicks, 0) })),
    });
  }
  const trendMax = Math.max(1, ...trendShown.flatMap((g) => g.daily.map((d) => d.clicks)));
  const trendRows = trendShown.some((g) => g.sum)
    ? trendShown
        .map((g) => {
          const bars = g.daily
            .map(
              (d) =>
                `<i style="height:${Math.max(2, (d.clicks / trendMax) * 100)}%;background:${esc(g.color || 'var(--grad)')}" title="${esc(d.day)} · ${d.clicks} 次"></i>`,
            )
            .join('');
          return `<div class="spark-row">
            <span class="spark-name truncate"><i class="dotcolor" style="background:${esc(g.color || 'rgba(139,152,214,.45)')}"></i>${esc(g.name)}</span>
            <span class="spark">${bars}</span>
            <span class="mono spark-num">${num(g.sum)}</span>
          </div>`;
        })
        .join('')
    : '<p class="muted">最近 14 天还没有点击。短链被访问后这里会出现分组对比。</p>';

  const cards = items.length
    ? items
        .map(
          (g) => `<tr data-id="${g.id}">
      <td>
        <div class="row">
          <button class="dotcolor dotcolor-btn" data-color="${g.id}" style="background:${esc(g.color || 'rgba(139,152,214,.45)')}" title="换颜色" aria-label="换颜色"></button>
          <b class="truncate">${esc(g.name)}</b>
        </div>
      </td>
      <td class="dim"><span class="truncate cell-note" title="${esc(g.note || '')}">${esc(g.note || '—')}</span></td>
      <td class="mono" style="text-align:right">${num(g.links)}</td>
      <td class="mono" style="text-align:right">${num(g.clicks)}</td>
      <td class="muted" style="white-space:nowrap">${timeAgo(g.created_at)}</td>
      <td style="width:1%"><div class="row">
        <a class="btn btn-ghost btn-sm" href="#/links" data-open="${g.id}">查看</a>
        <button class="btn btn-ghost btn-sm btn-icon" data-edit title="重命名" aria-label="重命名">${ic('edit')}</button>
        <button class="btn btn-ghost btn-sm btn-icon" data-del title="删除" aria-label="删除">${ic('trash')}</button>
      </div></td>
    </tr>`,
        )
        .join('')
    : `<tr><td colspan="6"><div class="empty"><img src="/img/logo.svg" width="40" height="40" alt="">
        <b>还没有分组</b><span class="muted">右边新建一个，比如「官网」「活动页」「外部合作」</span></div></td></tr>`;

  const groupHours = (hours.result.items || []).filter((g) => g.total > 0).slice(0, 6);
  const hoursCards = groupHours.length
    ? groupHours
        .map(
          (g) => `<div class="gh-item">
        <div class="gh-head">
          <i class="dotcolor" style="background:${esc(g.color || 'rgba(139,152,214,.45)')}"></i>
          <b class="truncate">${esc(g.name)}</b>
          <span class="mono dim">${num(g.total)} 次</span>
        </div>
        ${hourHeat({ cells: g.cells, peak: g.peak, total: g.total }, { compact: true, color: g.color || '' })}
      </div>`,
        )
        .join('')
    : '<p class="muted">还没有时段数据。短链被访问后，这里会显示每个分组在一周里哪个时段最忙。（升级前的历史点击没有记录时段，补不回来）</p>';

  root.innerHTML = `
  <div class="topbar"><div><h1>分组</h1><div class="sub">${num(items.length)} 个分组 · ${num(total)} 条短链</div></div></div>
  <section class="card" style="margin-bottom:18px">
    <div class="card-head"><h2>分组点击趋势</h2><span class="tag">近 14 天 · 每日点击</span></div>
    <div class="card-body stack" style="gap:8px">${trendRows}</div>
  </section>
  <section class="card" style="margin-bottom:18px">
    <div class="card-head"><h2>各分组的活跃时段</h2><span class="tag">累计 · 星期 × 小时</span></div>
    <div class="card-body gh-grid">${hoursCards}</div>
  </section>
  <div class="split split-groups">
    <section class="card">
      <div class="card-head"><h2>分组列表</h2><span class="tag">未分组 ${num(result.ungrouped || 0)} 条</span></div>
      <div class="table-wrap"><table class="tbl-groups">
        <thead><tr><th>名称</th><th>备注</th><th style="text-align:right">短链</th><th style="text-align:right">点击</th><th>创建</th><th></th></tr></thead>
        <tbody>${cards}</tbody>
      </table></div>
    </section>
    <section class="card">
      <div class="card-head"><h2>新建分组</h2></div>
      <div class="card-body">
        <form id="group-form">
          <div class="field"><label>名称</label><input id="g-name" placeholder="例如：官网入口" maxlength="40" required>
            <p class="hint">不超过 40 个字符，名称不能重复（不区分大小写）</p></div>
          <div class="field"><label>颜色</label>
            <div class="swatches" id="g-colors">
              ${GROUP_COLORS.map((c, i) => `<button type="button" class="swatch ${i === 0 ? 'on' : ''}" data-color="${c}" style="background:${c}" aria-label="颜色 ${c}"></button>`).join('')}
            </div>
          </div>
          <div class="field"><label>备注</label><input id="g-note" placeholder="可选，说明这个分组装什么" maxlength="200"></div>
          <button class="btn btn-primary" type="submit" data-writes>创建分组</button>
        </form>
        <p class="hint" style="margin-top:14px">删除分组不会删掉里面的短链，它们会回到「未分组」。</p>
      </div>
    </section>
  </div>`;

  let pickedColor = GROUP_COLORS[0];
  $$('#g-colors .swatch').forEach((btn) =>
    btn.addEventListener('click', () => {
      pickedColor = btn.dataset.color;
      $$('#g-colors .swatch').forEach((b) => b.classList.toggle('on', b === btn));
    }),
  );

  $('#group-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/admin/api/groups', {
        method: 'POST',
        body: { name: $('#g-name').value, color: pickedColor, note: $('#g-note').value },
      });
      toast('分组已创建', 'ok');
      render();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  $$('tr[data-id]', root).forEach((tr) => {
    const id = tr.dataset.id;
    const group = items.find((g) => String(g.id) === id);
    $('[data-open]', tr)?.addEventListener('click', (e) => {
      e.preventDefault();
      state.links.group = id;
      state.links.page = 1;
      location.hash = '#/links';
      render();
    });
    $('[data-edit]', tr).addEventListener('click', () => {
      modal({
        title: '重命名分组',
        bodyHtml: `<div class="field"><label>名称</label><input id="ge-name" value="${esc(group.name)}" maxlength="40"></div>
          <div class="field"><label>备注</label><input id="ge-note" value="${esc(group.note || '')}" maxlength="200"></div>`,
        onConfirm: async (mask) => {
          await api(`/admin/api/groups/${id}`, {
            method: 'PATCH',
            body: { name: $('#ge-name', mask).value, note: $('#ge-note', mask).value },
          });
          toast('已保存', 'ok');
          render();
        },
      });
    });
    $('[data-del]', tr).addEventListener('click', () =>
      confirmDialog('删除分组', `删除「${group.name}」后，其中 ${group.links} 条短链会回到未分组，短链本身不会被删除。`, async () => {
        const { result: r } = await api(`/admin/api/groups/${id}`, { method: 'DELETE' });
        if (String(state.links.group) === id) state.links.group = '';
        toast(`已删除，${r.ungrouped} 条短链回到未分组`, 'ok');
        render();
      }),
    );
    $('[data-color]', tr)?.addEventListener('click', () => {
      const next = GROUP_COLORS[(GROUP_COLORS.indexOf(group.color) + 1) % GROUP_COLORS.length];
      api(`/admin/api/groups/${id}`, { method: 'PATCH', body: { color: next } })
        .then(() => render())
        .catch((err) => toast(err.message, 'err'));
    });
  });
}

/* ---------- 视图：回收站 ---------- */
async function viewTrash(root) {
  const { page } = state.trash;
  const { result } = await api(`/admin/api/trash?page=${page}&perPage=20`);
  state.trash.page = result.page;
  if (result.page > result.pages) {
    state.trash.page = result.pages;
    return viewTrash(root);
  }

  const rows = result.items.length
    ? result.items
        .map(
          (l) => `<tr data-code="${esc(l.code)}">
      <td><div class="cell-title"><b class="truncate">${esc(l.title || '(无标题)')}</b>
        <span class="cell-url mono">${esc(l.url)}</span></div></td>
      <td class="mono">/${esc(l.code)}</td>
      <td>${l.group ? `<span class="tag tag-brand">${esc(l.group.name)}</span>` : '<span class="muted">—</span>'}</td>
      <td class="mono" style="text-align:right">${num(l.clicks)}</td>
      <td class="muted" style="white-space:nowrap">${timeAgo(l.deletedAt)}</td>
      <td style="width:1%"><div class="row">
        <button class="btn btn-ghost btn-sm" data-restore>${ic('restore')} 恢复</button>
        <button class="btn btn-danger btn-sm" data-purge>彻底删除</button>
      </div></td>
    </tr>`,
        )
        .join('')
    : `<tr><td colspan="6"><div class="empty"><img src="/img/logo.svg" width="40" height="40" alt="">
        <b>回收站是空的</b><span class="muted">删除短链后会先到这里，随时能恢复</span></div></td></tr>`;

  root.innerHTML = `
  <div class="topbar"><div><h1>回收站</h1><div class="sub">共 ${num(result.total)} 条 · 删除的短码仍占位，不会被别人抢注</div></div><span class="spacer"></span>
    ${result.total ? `<button class="btn btn-danger btn-sm" id="empty-btn">清空回收站</button>` : ''}
  </div>
  <div class="banner">回收站里的短链访问时返回 404，恢复后立刻生效。彻底删除会连点击统计一起清掉，不可撤销。</div>
  <div class="card">
    <div class="table-wrap"><table class="tbl-trash">
      <thead><tr><th>标题 / 目标链接</th><th>短码</th><th>分组</th><th style="text-align:right">点击</th><th>删除时间</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="pager">
      <span>第 ${result.page} / ${result.pages} 页 · 共 ${num(result.total)} 条</span>
      <button class="btn btn-ghost btn-sm" data-page="prev" ${result.page <= 1 ? 'disabled' : ''}>上一页</button>
      <button class="btn btn-ghost btn-sm" data-page="next" ${result.page >= result.pages ? 'disabled' : ''}>下一页</button>
    </div>
  </div>`;

  $$('[data-page]', root).forEach((btn) =>
    btn.addEventListener('click', () => {
      state.trash.page += btn.dataset.page === 'next' ? 1 : -1;
      render();
    }),
  );

  $$('tr[data-code]', root).forEach((tr) => {
    const code = tr.dataset.code;
    $('[data-restore]', tr).addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        await api(`/admin/api/trash/${encodeURIComponent(code)}/restore`, { method: 'POST' });
        toast(`/${code} 已恢复`, 'ok');
        render();
      } catch (err) {
        toast(err.message, 'err');
        e.target.disabled = false;
      }
    });
    $('[data-purge]', tr).addEventListener('click', () =>
      confirmDialog('彻底删除', `/${code} 会被永久删除，点击统计一并清除，无法恢复。`, async () => {
        await api(`/admin/api/trash/${encodeURIComponent(code)}`, { method: 'DELETE' });
        toast('已彻底删除', 'ok');
        render();
      }, { confirmText: '彻底删除' }),
    );
  });

  $('#empty-btn')?.addEventListener('click', () =>
    confirmDialog('清空回收站', `将永久删除回收站中的 ${result.total} 条短链及其统计，无法恢复。`, async () => {
      const { result: r } = await api('/admin/api/trash/empty', { method: 'POST' });
      toast(`已清空，删除 ${r.removed} 条`, 'ok');
      render();
    }, { confirmText: '清空回收站' }),
  );
}

/* ---------- 视图：渠道漏斗 ---------- */
/**
 * 「看了建页但没进去」这件事，只有在建页上线之后才看得见。
 *
 * 页面上刻意把落点率的**分母**写清楚（曝光次数），而不是只给一个百分比：
 * 曝光 3 次、落点 1 次是 33%，和曝光 3000、落点 1000 是 33%，
 * 对投放来说完全是两件事。
 */
async function viewFunnel(root) {
  const { result } = await api('/admin/api/funnel');
  const s = result.summary;
  // 落点率超过 100% 不是「数据错了」，是口径的边界：曝光只从建页打开那天起记，
  // 而 click_refs 里存着建页之前的落地点击。遇到就如实标出来，不悄悄截成 100%
  const pct = (row) => (row.rate === null ? '—' : `${(row.rate * 100).toFixed(1)}%${row.rate > 1 ? ' *' : ''}`);
  const maxViews = Math.max(1, ...result.rows.map((r) => r.views));

  const rows = result.rows.length
    ? result.rows
        .map((r) => {
          const dead = r.views > 0 && r.clicks === 0;
          const label = r.host || '无来源（直接打开）';
          return `<tr data-host="${esc(r.host)}">
        <td class="truncate"><button class="drill-toggle" data-drill="${esc(r.host)}" aria-expanded="false"><span class="drill-caret">▸</span> ${esc(label)}${dead ? ' <span class="tag tag-warn">零落地</span>' : ''}</button></td>
        <td style="text-align:right"><span class="rank-bar" style="display:inline-block;width:90px"><i style="width:${Math.max(2, (r.views / maxViews) * 100)}%"></i></span></td>
        <td class="mono" style="text-align:right">${num(r.views)}</td>
        <td class="mono" style="text-align:right">${num(r.clicks)}</td>
        <td class="mono" style="text-align:right">${pct(r)}</td>
      </tr>`;
        })
        .join('')
    : '<tr><td colspan="5"><div class="empty"><b>还没有曝光数据</b><span class="muted">给短链打开「跳转前建页」后，这里会开始记录</span></div></td></tr>';

  root.innerHTML = `
  <div class="topbar"><div><h1>渠道漏斗</h1><div class="sub">建页被看了多少次，其中多少次真的点了「继续访问」</div></div></div>
  <div class="grid-cards">
    <div class="kpi"><div class="label">建页曝光</div><div class="value">${num(s.views)}</div><div class="delta">累计，不算点击</div></div>
    <div class="kpi"><div class="label">点了继续访问</div><div class="value">${num(s.clicks)}</div><div class="delta">有来源的落地点击</div></div>
    <div class="kpi"><div class="label">整体落点率</div><div class="value">${s.rate === null ? '—' : `${(s.rate * 100).toFixed(1)}%`}</div><div class="delta">分母是曝光，不是总点击</div></div>
    <div class="kpi"><div class="label">零落地渠道</div><div class="value">${num(s.dead)}</div><div class="delta">有曝光、一次都没点进去</div></div>
  </div>
  <section class="card">
    <div class="card-head"><h2>按渠道</h2><span class="tag">点渠道名可展开到短链</span></div>
    <div class="table-wrap"><table class="tbl-funnel">
      <thead><tr><th>渠道</th><th style="text-align:right">曝光</th><th style="text-align:right">曝光次数</th><th style="text-align:right">落地</th><th style="text-align:right">落点率</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>
  <section class="card" style="margin-top:18px">
    <div class="card-head"><h2>怎么看这张表</h2></div>
    <div class="card-body stack" style="gap:8px">
      <p class="muted">曝光是「建页被渲染出来」的次数，落地是「点了继续访问并真的 302 过去」的次数。两者分开记，所以建页上线不会让历史点击数变得不可比。</p>
      <p class="muted">「零落地」多半是话术或按钮出了问题，而不是没人看——这类行最值得先查。</p>
      <p class="muted">展开到短链时，两边的数都按这个渠道过滤。拿全量落地去除渠道曝光算出来的比例是跨渠道混出来的，看着精确、实际不对。</p>
      <p class="muted">没有 referrer 的曝光单独成行。没有 referrer 的落地在来源侧根本不存在，所以两边不会正好配平，这是正常的。</p>
      <p class="muted">带 <b>*</b> 的落点率超过 100%：曝光从建页打开那天才开始记，而落地点击里还含建页之前的历史数据。想得到干净的比例，就从启用建页那天起算。</p>
    </div>
  </section>`;

  /**
   * 下钻：点渠道名就地展开，不跳到别的页面。
   * 复盘时的问题是「这个渠道哪条链没接住」，答案要和渠道在同一屏上，
   * 跳走一次就得记住刚才那个数字再看下一屏，很容易看串。
   */
  $$('[data-drill]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const host = btn.dataset.drill;
      const tr = btn.closest('tr');
      const open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      const existing = tr.nextElementSibling;
      if (open) {
        if (existing?.classList.contains('drill-row')) existing.remove();
        return;
      }
      if (existing?.classList.contains('drill-row')) return;
      const holder = document.createElement('tr');
      holder.className = 'drill-row';
      holder.innerHTML = '<td colspan="5" class="muted">加载中…</td>';
      tr.after(holder);
      try {
        const { result: drill } = await api(`/admin/api/funnel?host=${encodeURIComponent(host)}`);
        const list = drill.drill || [];
        if (!list.length) {
          holder.innerHTML = '<td colspan="5" class="muted">这个渠道下还没有数据</td>';
          return;
        }
        const max = Math.max(1, ...list.map((r) => r.views));
        holder.innerHTML = `<td colspan="5">
          <table class="tbl-funnel" style="margin:0">
            <thead><tr><th>短链</th><th style="text-align:right">曝光</th><th style="text-align:right">落地</th><th style="text-align:right">落点率</th><th style="text-align:right">没进去</th></tr></thead>
            <tbody>${list
              .map((r) => {
                const dead = r.views > 0 && r.clicks === 0;
                return `<tr>
                <td class="truncate drill-code"><a href="#/links?q=${encodeURIComponent(r.code)}" class="hot-title">/${esc(r.code)}</a>
                  <span class="truncate muted">${esc(r.title || (r.gone ? '短链已删除' : '无标题'))}</span>
                  ${dead ? ' <span class="tag tag-warn">零落地</span>' : ''}</td>
                <td style="text-align:right"><span class="rank-bar" style="display:inline-block;width:70px"><i style="width:${Math.max(2, (r.views / max) * 100)}%"></i></span></td>
                <td class="mono" style="text-align:right">${num(r.views)}</td>
                <td class="mono" style="text-align:right">${num(r.clicks)}</td>
                <td class="mono" style="text-align:right">${r.rate === null ? '—' : `${(r.rate * 100).toFixed(0)}%`}</td>
                <td class="mono dim" style="text-align:right">${num(r.lost)}</td>
              </tr>`;
              })
              .join('')}</tbody>
          </table>
          <p class="hint" style="margin:8px 0 0 14px">按「没进去」倒序：人多却没人往下走的排最前。</p>
        </td>`;
      } catch (err) {
        holder.innerHTML = `<td colspan="5" class="banner err">展开失败：${esc(err.message)}</td>`;
      }
    }),
  );
}

/* ---------- 视图：举报箱 ---------- */
const REPORT_LABEL = { spam: '垃圾广告', phishing: '钓鱼诈骗', malware: '恶意软件', illegal: '违法内容', other: '其它问题' };

async function viewReports(root) {
  state.reports = state.reports || { status: '' };
  const q = state.reports.status ? `?status=${encodeURIComponent(state.reports.status)}` : '';
  const { result } = await api(`/admin/api/reports${q}`);

  const tabs = [['', '全部'], ['open', '待处理'], ['handled', '已处理'], ['ignored', '已忽略']]
    .map(([k, label]) => `<button class="btn btn-sm ${state.reports.status === k ? 'btn-primary' : 'btn-ghost'}" data-status="${k}">${label}</button>`)
    .join('');

  const rows = result.items.length
    ? result.items
        .map(
          (r) => `<tr data-id="${r.id}">
      <td><span class="tag ${r.status === 'open' ? 'tag-warn' : ''}">${r.status === 'open' ? '待处理' : r.status === 'handled' ? '已处理' : '已忽略'}</span></td>
      <td class="mono">/${esc(r.code)}</td>
      <td>${esc(REPORT_LABEL[r.reason] || r.reason)}</td>
      <td class="dim truncate" title="${esc(r.note || '')}">${esc(r.note || '—')}</td>
      <td class="mono dim">${esc(r.ip || '—')}</td>
      <td class="dim mono">${fmtDate(r.created_at)}</td>
      <td style="white-space:nowrap">
        ${r.status === 'open' ? `<button class="btn btn-ghost btn-sm" data-handle="handled">标记已处理</button><button class="btn btn-ghost btn-sm" data-handle="ignored">忽略</button>` : ''}
      </td>
    </tr>`,
        )
        .join('')
    : `<tr><td colspan="7"><div class="empty"><b>没有举报</b><span class="muted">名片页 /&lt;短码&gt;+ 底部有举报入口</span></div></td></tr>`;

  root.innerHTML = `
  <div class="topbar"><div><h1>举报箱</h1><div class="sub">来自短链名片页的反馈，需人工核对，不会自动停链</div></div><span class="spacer"></span>
    <span class="tag tag-warn">待处理 ${num(result.open)}</span></div>
  <div class="row" style="gap:8px;margin-bottom:14px">${tabs}</div>
  <section class="card">
    <div class="table-wrap"><table class="tbl-reports">
      <thead><tr><th>状态</th><th>短链</th><th>类型</th><th>说明</th><th>来源 IP</th><th>时间</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>
  <p class="muted" style="margin-top:12px">IP 只显示网段，够定位来源就行。同一 IP 对同一条短链一天只收一条举报。</p>`;

  $$('[data-status]').forEach((b) =>
    b.addEventListener('click', () => {
      state.reports.status = b.dataset.status;
      render();
    }),
  );
  $$('tr[data-id] [data-handle]').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.closest('tr').dataset.id;
      await api(`/admin/api/reports/${id}`, { method: 'POST', body: { status: b.dataset.handle } });
      toast('已记录处理结论', 'ok');
      render();
    }),
  );
}


/* ---------- 视图：事件通知 ---------- */
const EVENT_LABEL = {
  'link.dead': '短链变成死链',
  'link.expiring': '短链即将到期',
  'report.new': '收到新的举报',
  'backup.failed': '自动备份失败',
  'digest.periodic': '运营摘要（定期）',
  // 静默结束时合并出来的摘要，不是可以订阅的事件，但投递记录里会出现
  digest: '静默汇总',
};
const DELIVERY_LABEL = { success: '已送达', failed: '失败', retry: '重试中', pending: '排队中', held: '静默待发', dropped: '静默未发' };
const QUIET_POLICY_LABEL = { digest: '攒着，结束后合并补发', drop: '静默期内不发' };
const DIGEST_KIND_LABEL = { off: '关闭', daily: '每天推一次', weekly: '每周一推一次' };

/**
 * 投递记录的「状态码 × 次数」那一列。
 *
 * 挂起和丢弃的记录没有状态码，显示成「— × 0」等于告诉人「发了一次都没成」，
 * 而事实是它压根还没发。这两种直接把原因写出来：一个说什么时候会发，一个说被吞了。
 */
function deliveryDetail(d) {
  if (d.status === 'held') return `<span class="nowrap">静默中 · 结束后补发</span>`;
  if (d.status === 'dropped') return `<span class="nowrap">按策略未发送</span>`;
  const code = d.code ? esc(String(d.code)) : '—';
  // 只有失败 / 重试中的记录才值得在状态码后面挂个警告号。
  // 成功记录也可能带一句备注（比如「已并入静默摘要」），那不是问题
  const warn = (d.status === 'failed' || d.status === 'retry') && d.note ? ' ⚠' : '';
  return `<span class="mono nowrap">${code} × ${num(d.attempts)}${warn}</span>`;
}

async function viewNotify(root) {
  const { result } = await api('/admin/api/notify/channels');
  const del = await api('/admin/api/notify/deliveries?limit=12');
  const channels = result.items;
  const health = del.result.counts;
  // 定期摘要的配置和预览：预览用的就是真发出去的那段文本，
  // 不然「预览挺好看、收到是另一段」的预览没有意义
  const digest = await api('/admin/api/digest/push').then((r) => r.result).catch(() => null);

  const eventChips = (channel) =>
    channel.events.map((e) => `<span class="tag">${esc(EVENT_LABEL[e] || e)}</span>`).join(' ');

  const channelRows = channels.length
    ? channels
        .map(
          (c) => `<tr data-id="${c.id}" class="${c.enabled ? '' : 'row-dim'}">
      <td>
        <div class="hot-title">${esc(c.name)}${c.hasSecret ? ' <span class="tag tag-brand">已签名</span>' : ''}</div>
        <div class="muted mono truncate" style="font-size:12px">${esc(c.url)}</div>
      </td>
      <td><span class="tag">${esc(result.kinds.find((k) => k.key === c.kind)?.label || c.kind)}</span></td>
      <td>${eventChips(c)}</td>
      <td><div class="tag-row">${c.enabled ? '<span class="tag tag-ok">启用</span>' : '<span class="tag">停用</span>'}
        ${c.quiet?.from && c.quiet?.to ? `<span class="tag ${c.quietActive ? 'tag-warn' : ''}" title="${esc(QUIET_POLICY_LABEL[c.quiet.policy] || '')}">${c.quietActive ? '静默中' : '静默'} ${esc(c.quiet.from)}–${esc(c.quiet.to)}</span>` : ''}</div></td>
      <td style="white-space:nowrap">
        <button class="btn btn-ghost btn-sm" data-test>测试</button>
        <button class="btn btn-ghost btn-sm" data-toggle data-writes>${c.enabled ? '停用' : '启用'}</button>
        <button class="btn btn-ghost btn-sm" data-edit data-writes>编辑</button>
        <button class="btn btn-ghost btn-sm" data-del data-writes>删除</button>
      </td>
    </tr>`,
        )
        .join('')
    : `<tr><td colspan="5"><div class="empty"><b>还没有通知渠道</b><span class="muted">配一个之后，死链、举报、到期、备份失败会主动推给你</span></div></td></tr>`;

  const delRows = del.result.items.length
    ? del.result.items
        .map(
          (d) => `<tr class="del-row st-${esc(d.status)}" data-did="${d.id}">
      <td><span class="tag ${d.status === 'success' ? 'tag-ok' : d.status === 'failed' ? 'tag-err' : d.status === 'held' || d.status === 'retry' ? 'tag-warn' : ''}">${esc(DELIVERY_LABEL[d.status] || d.status)}</span></td>
      <td class="nowrap">${esc(EVENT_LABEL[d.event] || d.event)}</td>
      <td class="mono truncate">${esc(d.subject || '—')}</td>
      <td class="dim">${esc(d.channel || '—')}</td>
      <td class="dim" title="${esc(d.note || '')}">${deliveryDetail(d)}</td>
      <td class="dim mono nowrap">${fmtDate(d.created_at)}</td>
      <td>${d.status === 'failed' ? '<button class="btn btn-ghost btn-sm" data-retry data-writes>重发</button>' : ''}</td>
    </tr>`,
        )
        .join('')
    : `<tr><td colspan="7"><div class="empty"><b>还没有投递记录</b><span class="muted">加上渠道、点一次测试就有了</span></div></td></tr>`;

  const digestCard = digest
    ? `<section class="card">
      <div class="card-head"><h2>定期摘要</h2>
        <span class="tag ${digest.kind === 'off' ? '' : 'tag-ok'}">${digest.kind === 'off' ? '已关闭' : esc(DIGEST_KIND_LABEL[digest.kind] || digest.kind)}</span>
        <span class="spacer"></span>
        <button class="btn btn-ghost btn-sm" id="digest-push" data-writes>立即推送一次</button>
      </div>
      <div class="card-body">
        <div class="field-row">
          <div class="field"><label>频率</label>
            <select id="digest-kind">
              ${Object.entries(DIGEST_KIND_LABEL).map(([k, l]) => `<option value="${k}" ${digest.kind === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}
            </select>
            <p class="hint">订阅了「运营摘要（定期）」的渠道才会收到；静默时段照样生效，不绕过去</p>
          </div>
          <div class="field"><label>推送时间（小时，服务器本地）</label>
            <input id="digest-hour" type="number" min="0" max="23" value="${digest.hour}">
            <p class="hint">${digest.nextRunAt ? `下次推送 ${esc(fmtDate(digest.nextRunAt))}` : '当前已关闭'}</p>
          </div>
          <div class="field"><label>统计窗口（天）</label>
            <input id="digest-days" type="number" min="1" max="30" value="${digest.windowDays}">
            <p class="hint">周报默认 7 天；1 天表示「和昨天比」</p>
          </div>
        </div>
        <div class="field"><label>推送内容预览</label>
          <pre class="code-block digest-text" id="digest-preview">${esc(digest.text)}</pre>
          <p class="hint">这段文本和真正发出去的一字不差，只是把渠道换成了这里</p>
        </div>
      </div>
    </section>`
    : '';

  root.innerHTML = `
  <div class="topbar"><div><h1>事件通知</h1><div class="sub">事情发生时主动推给你，不用一直盯着这一页</div></div>
    <span class="spacer"></span>
    <span class="tag ${health.failed ? 'tag-err' : 'tag-ok'}">失败 ${num(health.failed)}</span>
    <button class="btn btn-primary btn-sm" id="add-channel" data-writes>${ic('plus')} 新建渠道</button>
  </div>

  <div class="stack">
    ${digestCard}
    <section class="card">
      <div class="card-head"><h2>推送渠道</h2><span class="tag">${num(channels.length)} 个</span></div>
      <div class="table-wrap"><table class="tbl-notify channels">
        <thead><tr><th>渠道</th><th>类型</th><th>订阅事件</th><th>状态</th><th></th></tr></thead>
        <tbody>${channelRows}</tbody>
      </table></div>
      <div class="card-body">
        <p class="hint">通用 Webhook 走 POST JSON，带 <code>X-HighURL-Signature: sha256=HMAC(secret, "时间戳.报文")</code>，接收端可据此确认来源并拒绝重放；Slack / 飞书 / 钉钉会自动转换成各自的 text 格式。</p>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h2>投递记录</h2><span class="tag">最近 12 条</span></div>
      <div class="table-wrap"><table class="tbl-notify deliveries">
        <thead><tr><th>结果</th><th>事件</th><th>主体</th><th>渠道</th><th>状态 / 次数</th><th>时间</th><th></th></tr></thead>
        <tbody>${delRows}</tbody>
      </table></div>
      <div class="card-body">
        <dl class="kv">
          <dt>已送达</dt><dd>${num(health.success)}</dd>
          <dt>重试中</dt><dd>${num(health.retry)}</dd>
          <dt>失败</dt><dd>${health.failed ? `<span class="tag tag-err">${num(health.failed)}</span>` : '0'}</dd>
          <dt>静默待发</dt><dd>${health.held ? `<span class="tag tag-warn">${num(health.held)}</span>` : '0'}</dd>
          <dt>静默未发</dt><dd>${health.dropped ? num(health.dropped) : '0'}</dd>
        </dl>
        <p class="hint">失败会退避重试两次（5 秒、30 秒）。三次都没送到就停下，把原因留在这里等人处理——无限重试只会把接收端和我们自己都拖住。标「静默待发」的记录是静默期内攒下的，时段结束后会合成一条摘要发出。</p>
      </div>
    </section>
  </div>`;

  if (digest) {
    // 频率 / 小时 / 窗口三项改动立刻落设置：它们是纯配置，
    // 混在「保存」按钮里反而容易忘存
    const saveDigest = async () => {
      const body = {
        digestPushKind: $('#digest-kind').value,
        digestPushHour: Number($('#digest-hour').value),
        digestPushWindowDays: Number($('#digest-days').value),
      };
      try {
        const out = await api('/admin/api/settings', { method: 'PATCH', body });
        if (out.rejected?.length) toast(`忽略无效项：${out.rejected.join(',')}`, 'err');
        else toast('定期摘要设置已保存', 'ok');
        render();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
    $('#digest-kind').addEventListener('change', saveDigest);
    $('#digest-hour').addEventListener('change', saveDigest);
    $('#digest-days').addEventListener('change', saveDigest);
    $('#digest-push').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const { result: r } = await api('/admin/api/digest/push', { method: 'POST' });
        // pushed 为 0 时要说清为什么没发：渠道没订阅 / 静默中 / 没事件，
        // 这三种「点了没反应」的原因完全不同
        // 「入队」和「真发出去」不是一回事：静默中的渠道会挂起等到点补发，
        // 只说一句「已推送 2 个渠道」会让人以为手机上都收到了
        const d = r.detail || { queued: 0, held: 0 };
        if (d.queued && d.held) toast(`已投递 ${d.queued} 个渠道，${d.held} 个静默中（结束后补发）`, 'ok');
        else if (d.queued) toast(`已投递到 ${d.queued} 个渠道`, 'ok');
        else if (d.held) toast(`${d.held} 个渠道正在静默，已挂起，结束后补发`, 'ok');
        else toast('没有渠道接收：检查渠道是否订阅了「运营摘要（定期）」', 'err');
        render();
      } catch (err) {
        toast(err.message, 'err');
        e.target.disabled = false;
      }
    });
  }

  const channelForm = (channel) => {
    const picked = new Set(channel?.events || []);
    return `
      <div class="field"><label>名称</label><input id="nc-name" value="${esc(channel?.name || '')}" placeholder="例如：运维群"></div>
      <div class="field"><label>地址</label><input id="nc-url" value="${esc(channel?.url || '')}" placeholder="https://hooks.example.com/highurl">
        <p class="hint">只接受 http(s)。指向内网默认会被拦下，自建接收端请在系统设置里打开「允许推送到内网」</p></div>
      <div class="field"><label>类型</label>
        <select id="nc-kind">
          ${result.kinds.map((k) => `<option value="${k.key}" ${channel?.kind === k.key ? 'selected' : ''}>${esc(k.label)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>订阅事件</label>
        <div class="row" style="gap:10px;flex-wrap:wrap">
          ${result.events
            .map(
              (e) => `<label class="switch"><input type="checkbox" data-ev="${e.key}" ${picked.has(e.key) ? 'checked' : ''}><span>${esc(e.label)}</span></label>`,
            )
            .join('')}
        </div>
      </div>
      <div class="field"><label>签名密钥（可选）</label><input id="nc-secret" value="" placeholder="${channel?.hasSecret ? '已设置，留空表示不改' : '留空则不签名'}">
        <p class="hint">配了之后每个请求都会带 HMAC-SHA256 签名头，接收端可以验签</p></div>
      <div class="field"><label>静默时段（可选）</label>
        <div class="row" style="gap:10px;align-items:center;flex-wrap:wrap">
          <input id="nc-quiet-from" value="${esc(channel?.quiet?.from || '')}" placeholder="22:00" style="max-width:110px" inputmode="numeric">
          <span class="muted">到</span>
          <input id="nc-quiet-to" value="${esc(channel?.quiet?.to || '')}" placeholder="08:00" style="max-width:110px" inputmode="numeric">
          <select id="nc-quiet-policy" style="max-width:220px">
            ${Object.entries(QUIET_POLICY_LABEL).map(([k, l]) => `<option value="${k}" ${(channel?.quiet?.policy || 'digest') === k ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
        <p class="hint">服务器本地时间，跨夜直接填（22:00 到 08:00）。留空表示不静默。静默不是丢弃：选「合并补发」时，攒下的通知会在时段结束后合成一条摘要发出来；两格填成一样会被当成没设置，避免手滑变成全天静默</p>
      </div>
      <div class="field"><label>静默期内也照常推的事件</label>
        <div class="row" style="gap:10px;flex-wrap:wrap">
          ${result.events
            .map(
              (e) => `<label class="switch"><input type="checkbox" data-pierce="${e.key}" ${(channel?.quiet?.pierce || []).includes(e.key) ? 'checked' : ''}><span>${esc(e.label)}</span></label>`,
            )
            .join('')}
        </div>
        <p class="hint">备份失败这类「等到早上已经晚了」的事件可以单独放行；不勾就是全部遵守静默</p>
      </div>`;
  };

  const submitChannel = async (mask, id) => {
    const events = $$('[data-ev]', mask).filter((el) => el.checked).map((el) => el.dataset.ev);
    if (!events.length) throw new Error('至少要勾选一个事件');
    const body = {
      name: $('#nc-name', mask).value,
      url: $('#nc-url', mask).value,
      kind: $('#nc-kind', mask).value,
      events,
    };
    const secret = $('#nc-secret', mask).value;
    if (secret) body.secret = secret;
    body.quiet = {
      from: $('#nc-quiet-from', mask).value.trim(),
      to: $('#nc-quiet-to', mask).value.trim(),
      policy: $('#nc-quiet-policy', mask).value,
      pierce: $$('[data-pierce]', mask).filter((el) => el.checked).map((el) => el.dataset.pierce),
    };
    if (id) await api(`/admin/api/notify/channels/${id}`, { method: 'PATCH', body });
    else await api('/admin/api/notify/channels', { method: 'POST', body });
    toast(id ? '渠道已更新' : '渠道已创建', 'ok');
  };

  $('#add-channel').addEventListener('click', () => {
    modal({ title: '新建推送渠道', bodyHtml: channelForm(null), confirmText: '创建', onConfirm: (mask) => submitChannel(mask, null) });
  });

  $$('tr[data-id]').forEach((tr) => {
    const id = tr.dataset.id;
    const channel = channels.find((c) => Number(c.id) === Number(id));
    tr.querySelector('[data-edit]')?.addEventListener('click', () => {
      modal({ title: '编辑推送渠道', bodyHtml: channelForm(channel), onConfirm: (mask) => submitChannel(mask, id) });
    });
    tr.querySelector('[data-toggle]')?.addEventListener('click', async () => {
      await api(`/admin/api/notify/channels/${id}`, { method: 'PATCH', body: { enabled: !channel.enabled } });
      render();
    });
    tr.querySelector('[data-test]')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      const label = e.target.textContent;
      e.target.textContent = '发送中…';
      try {
        const { result: r } = await api(`/admin/api/notify/channels/${id}/test`, { method: 'POST' });
        // 状态码和对方的话都要露出来：只报「已发送」等于把真正的失败藏了
        toast(r.ok ? '测试通知已送达' : `对方拒收：${r.status || '无响应'} ${r.note || ''}`, r.ok ? 'ok' : 'err');
        render();
      } catch (err) {
        toast(err.message, 'err');
        e.target.disabled = false;
        e.target.textContent = label;
      }
    });
    tr.querySelector('[data-del]')?.addEventListener('click', () => {
      confirmDialog('删除渠道', `删除「${channel.name}」后，它订阅的事件不会再推送。已有的投递记录也会一起清掉。`, async () => {
        await api(`/admin/api/notify/channels/${id}`, { method: 'DELETE' });
        toast('渠道已删除', 'ok');
        render();
      }, { confirmText: '删除' });
    });
  });

  $$('tr[data-did] [data-retry]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('tr').dataset.did;
      btn.disabled = true;
      try {
        await api(`/admin/api/notify/deliveries/${id}/retry`, { method: 'POST' });
        toast('已重新入队', 'ok');
        setTimeout(render, 900);
      } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false;
      }
    });
  });
}

/* ---------- 视图：账号管理 ---------- */
const ROLE_LABEL = { owner: '管理员', viewer: '只读' };

async function viewAccounts(root) {
  const { result } = await api('/admin/api/admins');
  const me = result.me;
  const rows = result.items
    .map((a) => {
      const self = a.id === me.id;
      return `<tr data-id="${a.id}" class="${a.disabled ? 'row-dim' : ''}">
      <td><b>${esc(a.username)}</b>${self ? ' <span class="tag">你</span>' : ''}</td>
      <td><span class="tag ${a.role === 'owner' ? 'tag-ok' : ''}">${ROLE_LABEL[a.role] || a.role}</span></td>
      <td>${a.disabled ? '<span class="tag tag-warn">已停用</span>' : '<span class="muted">启用</span>'}</td>
      <td class="dim mono">${a.last_login_at ? esc(fmtDate(a.last_login_at)) : '从未登录'}</td>
      <td class="dim">${esc(a.created_by || '安装时创建')}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-ghost btn-sm" data-role="${a.role === 'owner' ? 'viewer' : 'owner'}" ${self ? 'disabled title="不能改自己的角色"' : ''}>设为${a.role === 'owner' ? '只读' : '管理员'}</button>
        <button class="btn btn-ghost btn-sm" data-reset>重置密码</button>
        <button class="btn btn-ghost btn-sm" data-state="${a.disabled ? '0' : '1'}" ${self ? 'disabled title="不能停用当前登录的账号"' : ''}>${a.disabled ? '启用' : '停用'}</button>
        <button class="btn btn-ghost btn-sm btn-icon" data-del title="删除" ${self ? 'disabled' : ''}>${ic('trash')}</button>
      </td>
    </tr>`;
    })
    .join('');

  root.innerHTML = `
  <div class="topbar"><div><h1>账号</h1><div class="sub">多个人一起维护时，别把所有人的权限都给成一样的</div></div><span class="spacer"></span>
    <button class="btn btn-primary" id="add-admin" data-writes>${ic('plus')} 新增账号</button></div>
  <section class="card">
    <div class="table-wrap"><table class="tbl-admins">
      <thead><tr><th>账号</th><th>角色</th><th>状态</th><th>最近登录</th><th>创建者</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>
  <section class="card" style="margin-top:18px">
    <div class="card-head"><h2>两种角色的区别</h2></div>
    <div class="card-body stack" style="gap:8px">
      <p class="muted"><b>管理员</b>：全部能力，含账号管理、备份恢复、系统设置。</p>
      <p class="muted"><b>只读</b>：能看所有报表、列表、统计和二维码，改不了任何东西。写接口一律拒。</p>
      <p class="muted">最后一个管理员不能被降级、停用或删除——否则没人能再进账号页，只能回来改数据库。命令行留了一条路：<span class="mono">highurl admin reset --username x --password y</span>。</p>
      <p class="muted">停用不是删除：账号还在，历史操作记录还挂得住，随时能再打开。停用后旧会话立刻失效，不用等 Cookie 过期。</p>
    </div>
  </section>`;

  $('#add-admin').addEventListener('click', () => {
    modal({
      title: '新增账号',
      bodyHtml: `<div class="field"><label for="nu">用户名</label><input id="nu" placeholder="3–32 位字母、数字或 _ . @ -"></div>
        <div class="field"><label for="np">初始密码</label><input id="np" type="password" placeholder="至少 8 位"></div>
        <div class="field"><label for="nr">角色</label><select id="nr"><option value="viewer">只读</option><option value="owner">管理员</option></select>
        <p class="hint">默认给只读。需要改数据的再单独提上来。</p></div>`,
      confirmText: '创建',
      onConfirm: async (mask) => {
        const username = $('#nu', mask).value.trim();
        const password = $('#np', mask).value;
        const role = $('#nr', mask).value;
        await api('/admin/api/admins', { method: 'POST', body: { username, password, role } });
        toast('账号已创建', 'ok');
        render();
      },
    });
  });

  $$('tr[data-id]').forEach((tr) => {
    const id = tr.dataset.id;
    const name = tr.querySelector('b').textContent.trim();
    tr.querySelector('[data-role]')?.addEventListener('click', async (e) => {
      const role = e.currentTarget.dataset.role;
      try {
        await api(`/admin/api/admins/${id}/role`, { method: 'POST', body: { role } });
        toast(`${name} 已设为${ROLE_LABEL[role]}`, 'ok');
        render();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
    tr.querySelector('[data-reset]')?.addEventListener('click', () => {
      modal({
        title: `重置 ${name} 的密码`,
        bodyHtml: `<div class="field"><label for="rp">新密码</label><input id="rp" type="password" placeholder="至少 8 位">
          <p class="hint">不需要知道原密码——「忘密码了」正是唯一会用到这个的场景。</p></div>`,
        confirmText: '重置',
        danger: true,
        onConfirm: async (mask) => {
          await api(`/admin/api/admins/${id}/password`, { method: 'POST', body: { password: $('#rp', mask).value } });
          toast('密码已重置', 'ok');
        },
      });
    });
    tr.querySelector('[data-state]')?.addEventListener('click', async (e) => {
      const disabled = e.currentTarget.dataset.state === '1';
      try {
        await api(`/admin/api/admins/${id}/state`, { method: 'POST', body: { disabled } });
        toast(disabled ? `${name} 已停用` : `${name} 已启用`, 'ok');
        render();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
    tr.querySelector('[data-del]')?.addEventListener('click', () => {
      confirmDialog('删除账号', `确定删除 ${name}？账号会被移除，历史操作记录保留。`, async () => {
        await api(`/admin/api/admins/${id}`, { method: 'DELETE' });
        toast('账号已删除', 'ok');
        render();
      }, { confirmText: '删除' });
    });
  });
}

const VIEWS = {
  dashboard: viewDashboard,
  links: viewLinks,
  groups: viewGroups,
  sources: viewSources,
  funnel: viewFunnel,
  reports: viewReports,
  create: viewCreate,
  rules: viewRules,
  migrate: viewMigrate,
  api: viewApi,
  audit: viewAudit,
  backup: viewBackup,
  trash: viewTrash,
  notify: viewNotify,
  settings: viewSettings,
  accounts: viewAccounts,
};

/** 解析 #/links?health=dead 这种带参数的地址 */
function currentRoute() {
  const raw = (location.hash || '#/dashboard').replace(/^#\/?/, '') || 'dashboard';
  const [name, query] = raw.split('?');
  const params = new URLSearchParams(query || '');
  return { name: name || 'dashboard', params };
}

async function render() {
  // 每次切视图先断开上一屏的长连接，否则标签切几次就把浏览器的并发连接吃光了
  closeLiveFeed();
  const { name, params } = currentRoute();
  const view = VIEWS[name] ? name : 'dashboard';
  if (view !== 'links') state.linksFromHash = false;
  // 带参数的链接（比如「查看死链」「按热度看全部」）直接落到对应的筛选条件上
  if (view === 'links' && !state.linksFromHash) {
    let jumped = false;
    const health = params.get('health');
    if (health !== null) {
      state.links.health = health;
      jumped = true;
    }
    // 地址栏里写的是界面上的排序键（recent），接口要的是 recent_desc
    const sortParam = params.get('sort');
    const sort = sortParam === 'recent' ? 'recent_desc' : sortParam;
    if (sort) {
      state.links.sort = sort;
      jumped = true;
    }
    const q = params.get('q');
    if (q !== null) {
      state.links.q = q;
      jumped = true;
    }
    // 「即将到期」也是从日报点进来的入口，落到同一套筛选上
    const expiring = params.get('expiring');
    if (expiring !== null) {
      state.links.expiring = expiring;
      state.links.status = '';
      jumped = true;
    }
    const statusParam = params.get('status');
    if (statusParam !== null) {
      state.links.status = statusParam;
      if (statusParam === 'expired') state.links.expiring = '';
      jumped = true;
    }
    if (jumped) state.links.page = 1;
  }
  state.view = view;
  // 记住这一屏是从地址栏参数跳进来的：用户之后再改筛选，就不能被参数里那套覆盖回去
  if (view === 'links' && (params.get('sort') || params.get('health') || params.get('q') !== null || params.get('expiring') || params.get('status'))) {
    state.linksFromHash = true;
  }
  $$('.navlink').forEach((a) => a.classList.toggle('active', a.dataset.nav === view));
  const root = $('#view');
  try {
    await VIEWS[view](root);
  } catch (err) {
    root.innerHTML = `<div class="banner err">加载失败：${esc(err.message)}</div>`;
  }
}

window.addEventListener('hashchange', render);
document.addEventListener('DOMContentLoaded', async () => {
  if (!location.hash) location.hash = '#/dashboard';
  // 先拿到自己的角色：只读账号的界面要和能写的账号不一样，
  // 让他在点击之前就知道哪些按钮是摆设，而不是点五个然后收五条报错
  try {
    const { result } = await api('/admin/api/me');
    state.me = result;
  } catch {
    state.me = null;
  }
  if (state.me?.readonly) {
    document.body.classList.add('readonly-account');
    // 兜底：漏标 data-writes 的提交按钮，点下去也只给一句人话，别让服务端的 403 弹出来
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('button[type=submit]');
      if (!btn || btn.dataset.writes !== undefined || btn.closest('.side-foot')) return;
      e.preventDefault();
      e.stopPropagation();
      toast('当前账号只读，这一下不会生效');
    }, true);
  }
  render();
});
