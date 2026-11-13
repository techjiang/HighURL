import { pageShell } from './layout.js';
import { escapeHtml } from '../lib/html.js';

const ENDPOINTS = [
  {
    method: 'POST',
    path: '/api/v1/links',
    desc: '创建短链接',
    body: `{
  "url": "https://example.com/very/long/url",
  "code": "mylink",          // 可选，不传自动生成
  "title": "自定义标题",      // 可选，不传自动抓取
  "tags": ["推广", "文档"],   // 可选
  "note": "备注",             // 可选
  "expireAt": "2025-12-31"    // 可选，支持 ISO 时间或时间戳
}`,
    resp: `{
  "ok": true,
  "result": {
    "id": 1, "code": "mylink",
    "shortUrl": "https://s.example.com/mylink",
    "url": "https://example.com/very/long/url",
    "title": "Example Domain",
    "clicks": 0
  }
}`,
  },
  {
    method: 'GET',
    path: '/api/v1/links?q=&status=&sort=created_desc&page=1&perPage=20',
    desc: '分页查询短链，支持搜索、状态过滤与排序',
    resp: `{
  "ok": true,
  "result": { "items": [ ... ], "total": 128, "page": 1, "perPage": 20 }
}`,
  },
  {
    method: 'GET',
    path: '/api/v1/links/:code',
    desc: '按短码查询单条记录',
    resp: `{ "ok": true, "result": { "code": "mylink", "clicks": 42, ... } }`,
  },
  {
    method: 'PATCH',
    path: '/api/v1/links/:code',
    desc: '更新短链（url / title / note / tags / status / expireAt）',
    resp: `{ "ok": true, "result": { ... } }`,
  },
  {
    method: 'DELETE',
    path: '/api/v1/links/:code',
    desc: '删除短链及其统计数据',
    resp: `{ "ok": true, "deleted": "mylink" }`,
  },
  {
    method: 'GET',
    path: '/api/v1/links/:code/stats',
    desc: '单条短链的点击趋势、来源与平台分布',
    resp: `{
  "ok": true,
  "result": {
    "clicks": 42,
    "daily": [{ "day": "2025-01-01", "clicks": 12 }],
    "referrers": [{ "host": "t.co", "clicks": 8 }],
    "platforms": [{ "platform": "ios", "clicks": 20 }]
  }
}`,
  },
  {
    method: 'GET',
    path: '/api/v1/stats',
    desc: '全站概览统计',
    resp: `{ "ok": true, "result": { "total": 128, "clicks": 9401, "daily": [...] } }`,
  },
];

export function renderDocs(ctx) {
  const siteName = ctx.settings.get('siteName');
  const blocks = ENDPOINTS.map(
    (ep) => `<section class="card" style="margin-bottom:16px">
      <div class="card-head">
        <h2><span class="tag tag-brand mono">${ep.method}</span> <span class="mono">${escapeHtml(ep.path)}</span></h2>
      </div>
      <div class="card-body stack">
        <p class="dim">${escapeHtml(ep.desc)}</p>
        ${ep.body ? `<div><label>请求体</label><div class="code-block">${escapeHtml(ep.body)}</div></div>` : ''}
        <div><label>响应</label><div class="code-block">${escapeHtml(ep.resp)}</div></div>
      </div>
    </section>`,
  ).join('');

  const body = `<div class="landing" style="max-width:900px">
  <header class="nav">
    <a class="brand" href="/"><img src="/img/logo.svg" alt="" width="30" height="30">${escapeHtml(siteName)}</a>
    <span class="spacer"></span>
    <a class="btn btn-ghost btn-sm" href="/">首页</a>
    <a class="btn btn-primary btn-sm" href="/admin">管理台</a>
  </header>

  <section class="hero" style="text-align:left;padding:12px 0 30px">
    <h1 style="font-size:clamp(26px,4vw,40px)">API 文档</h1>
    <p class="lead">在管理台「API 密钥」里生成 Token，然后用 <span class="mono">Authorization: Bearer &lt;token&gt;</span> 调用。</p>
  </section>

  <div class="card" style="margin-bottom:20px">
    <div class="card-head"><h2>鉴权</h2></div>
    <div class="card-body stack">
      <div class="code-block">curl -X POST ${escapeHtml(ctx.settings.get('baseUrl') || 'https://your-domain')}/api/v1/links \\
  -H "Authorization: Bearer hu_xxxxxxxxxxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com/really/long/link"}'</div>
      <p class="hint">Token 只在创建时显示一次，请妥善保存。只读密钥可调用查询接口，写入密钥可创建/修改/删除。</p>
    </div>
  </div>

  ${blocks}

  <footer class="footer"><span>${escapeHtml(siteName)} API · v1</span><a href="/">返回首页</a></footer>
</div>`;
  return pageShell({ title: `API 文档 · ${siteName}`, body, version: ctx.version });
}
