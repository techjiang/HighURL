import { HttpError, sendHtml, redirect } from '../lib/http.js';
import { clientIp, hostOf, platformOf, hmac, isBotUA, scryptVerify } from '../lib/util.js';
import { renderMessage } from '../pages/message.js';
import { renderLinkPreview } from '../pages/preview.js';
import { renderInterstitial } from '../pages/landing-page.js';
import { accentOfStyle } from '../services/qr-style.js';
import { countryOf, pickTarget } from '../services/targets.js';
import { qrSvg } from '../services/qr.js';
import { REASON_LABEL } from '../services/reports.js';
import { shortUrl } from './public.js';

const SUFFIX_IGNORE = new Set(['favicon.ico', 'robots.txt', 'sitemap.xml']);

export function createRedirectHandler(ctx) {
  const { store, settings, cache, counter, deduper, uaFilter, auth, logger, stream } = ctx;

  return async function handleRedirect(req, res, code, url) {
    if (SUFFIX_IGNORE.has(code)) return false;

    // 名片页 /<code>+ ：让人在跳过去之前先看清这串短链指向哪。
    // 用 `+` 是因为它不在短码字符集 [A-Za-z0-9_-] 里，永远不会和真实短码撞。
    // 这页不计数也不走分流——「想看清楚」不是一次访问，记进去只会让点击数失真。
    if (code.length > 1 && code.endsWith('+')) {
      const base = cache.load(code.slice(0, -1));
      if (!base) return false;
      return showPreview(res, ctx, req, base);
    }

    // 短码判重不分大小写，跳转也一样：用户把 /MiXeD 抄成 /mixed 不能打不开
    const link = cache.load(code);
    if (!link) return false;

    const botUA = isBotUA(req.headers['user-agent'] || '');
    const ip = clientIp(req, settings.get('trustProxy'));
    const ua = String(req.headers['user-agent'] || '');
    const ref = refererHost(req.headers.referer);
    const platform = platformOf(ua);
    // 实时流只服务管理台展示，没有客户端连着时 push 的代价接近零，
    // 所以这里不做「有没有人在看」的判断，直接记
    const record = (outcome) => stream?.push({ code: link.code, ip, ref, platform, outcome });

    if (settings.get('blockBots') && botUA) {
      ctx.stats.blocked += 1;
      record('blocked');
      return deny(res, ctx, req, 'bot', link.code);
    }

    const rule = uaFilter.match({ ua, ip });
    if (rule) {
      ctx.stats.blocked += 1;
      logger.info?.(`[block] ${link.code} rule=${rule.id} ip=${ip}`);
      record('blocked');
      return deny(res, ctx, req, 'rule', link.code);
    }

    // 自动建页：多一步让人看清目标再决定。
    // 放在状态检查之前，是因为「停用 / 过期」本身也该有一个说得清的页面，
    // 而不是一屏冷冰冰的 404 —— 建页在这种情况下会自己换成原因说明。
    const landing = landingMode(link);
    if (landing && !isGo(url)) {
      record('landing');
      // 曝光单独计数，不写进 clicks：混进去会让「点击数」从此不可比。
      // 渠道用 referrer 域名，和 click_refs 同一套取值，两边才对得上
      counter.view(link.code, { host: ref });
      showLanding(res, ctx, req, link, { reason: stateReason(link) });
      return true;
    }

    if (link.status !== 'active') {
      record('disabled');
      return gone(res, ctx, req, 'disabled', link);
    }
    if (link.expire_at && link.expire_at < Date.now()) {
      record('expired');
      return gone(res, ctx, req, 'expired', link);
    }

    if (link.protected) {
      const pass = verifyAccess(auth.secret, link.code, req);
      if (!pass) {
        record('locked');
        return showPassword(res, ctx, link, req);
      }
    }

    /**
     * 分流：有目标就按地域/权重选一个，没有就用默认目标。
     *
     * 抽签放在缓存之后、计数之前——它只读内存里的一份数组，不碰库。
     * 目标选不出来（全关停）时安静地回到 link.url：分流配置出错
     * 不该让印在物料上的短链打不开。
     */
    const targets = cache.loadTargets ? cache.loadTargets(code) : [];
    const country = countryOf(req, { trustProxy: settings.get('trustProxy') });
    const picked = targets.length ? pickTarget(targets, country) : null;
    const target = picked ? picked.url : link.url;

    // 延迟计数：只写内存，定时批量落库。
    // 开了去重窗口时，同一 IP 在窗口内反复点同一条只算一次——跳转照旧
    const duplicate = deduper ? deduper.isDuplicate(link.code, ip, settings.get('dedupeWindowSec')) : false;
    if (!duplicate) {
      counter.hit(link.code, { ref, platform, country, targetId: picked?.target?.id });
      record('redirect');
    } else {
      record('deduped');
    }

    ctx.stats.redirects += 1;
    const status = settings.get('redirectStatus');
    const headers = { 'Cache-Control': 'private, no-store' };
    if (settings.get('blockBots') || botUA) headers['X-Robots-Tag'] = 'noindex, nofollow';
    // 命中分流目标时回一个标记头，排查「为什么跳过去是另一个页面」时不用猜
    if (picked) headers['X-Highurl-Target'] = String(picked.target.id);
    return redirect(res, appendSuffix(target, code, url), status, headers);
  };
}


/** 建页开关：1 开、0 关，创建时已按站点默认值落库，所以这里只看字段本身 */
export function landingMode(link) {
  const raw = link?.interstitial;
  return raw === 1 || raw === true || raw === '1';
}

/** 只有 ?go=1 才算「已经看过建页、请放行」，其余参数照旧透传 */
function isGo(url) {
  return url.searchParams.get('go') === '1';
}

function stateReason(link) {
  if (link.status !== 'active') return 'disabled';
  if (link.expire_at && link.expire_at < Date.now()) return 'expired';
  return '';
}

/** 渲染建页。返回值不用：`return showLanding(...)` 会把 true 当成「再补一个 404」，白送一次 500 */
function showLanding(res, ctx, req, link, { reason = '' } = {}) {
  const host = hostOf(link.url);
  const html = renderInterstitial(ctx, link, {
    org: {
      name: ctx.settings.get('landingOrgName'),
      logoUrl: ctx.settings.get('landingLogoUrl'),
      disclaimer: ctx.settings.get('landingDisclaimer'),
      countdown: ctx.settings.get('landingCountdown'),
    },
    shortUrl: shortUrl(ctx, link.code, req),
    host,
    reason,
    theme: link.landing_theme,
    note: link.interstitial_note,
    accent: accentOfStyle(link.qr_style),
  });
  sendHtml(res, 200, html, { 'Cache-Control': 'no-store' });
  return true;
}

function refererHost(referer) {
  if (!referer) return '';
  try {
    return new URL(referer).hostname.replace(/^www\./, '').slice(0, 80);
  } catch {
    return '';
  }
}

/** /abc/extra/path?q=1 → 目标链接后追加 extra/path?q=1 */
function appendSuffix(target, code, url) {
  const rest = url.pathname.slice(code.length + 1).replace(/^\/+/, '');
  if (!rest && !url.search) return target;
  try {
    const base = new URL(target);
    if (rest) {
      if (base.pathname.endsWith('/')) base.pathname += rest;
      else base.pathname = `${base.pathname}/${rest}`;
    }
    // go 只是「已经看过建页」的放行标记，属于本站的事，
    // 原样透给目标站点会让对方的统计里多出一个看不懂的参数
    for (const [k, v] of url.searchParams) {
      if (k === 'go') continue;
      base.searchParams.append(k, v);
    }
    return base.href;
  } catch {
    return target;
  }
}

function accessToken(secret, code) {
  return hmac(secret, `access:${code}`);
}

export function verifyAccess(secret, code, req) {
  const cookie = req.headers.cookie || '';
  const match = new RegExp(`(?:^|;\\s*)hl_access_${code}=([^;]+)`).exec(cookie);
  if (!match) return false;
  return match[1] === accessToken(secret, code);
}

export function accessCookie(secret, code) {
  return `hl_access_${code}=${accessToken(secret, code)}; Path=/${code}; HttpOnly; SameSite=Lax; Max-Age=3600`;
}

function showPreview(res, ctx, req, link) {
  // 密码保护的链不在这里露出目标地址，名字和二维码也都藏起来：
  // 「要密码才能看」跟「谁都能看到」不能是同一件事
  const safe = link.protected
    ? { code: link.code, url: '受密码保护，需输入密码后才能访问', title: link.title || '', tags: '', group_name: '', clicks: 0, created_at: link.created_at, password: null }
    : link;
  const qr = qrSvg(`${shortUrl(ctx, link.code, req)}`, { margin: 2, dotStyle: 'rounded', gradient: ['#8b5cf6', '#22d3ee'], light: 'transparent' });
  const html = renderLinkPreview(ctx, safe, {
    shortUrl: shortUrl(ctx, link.code, req),
    qr,
    // 名片页不计数、不收录，但它是唯一能让人「先看清楚再决定」的地方，
    // 举报入口也应该落在这里，而不是跳过去之后的目标站点上
    canReport: ctx.settings.get('allowReport') !== false,
    reported: new URL(req.url, 'http://x').searchParams.get('reported') === '1',
  });
  sendHtml(res, 200, html, { 'Cache-Control': 'private, no-store' });
  return true;
}

function deny(res, ctx, req, kind, code) {
  const html = renderMessage(ctx, {
    status: 403,
    title: '访问已被拦截',
    desc: kind === 'bot'
      ? '本站已开启爬虫屏蔽，当前 User-Agent 不被允许访问该链接。'
      : '当前访问特征命中管理员设置的屏蔽规则。',
    code,
  });
  sendHtml(res, 403, html);
  return true;
}

function gone(res, ctx, req, kind, link) {
  const notFound = ctx.settings.get('notFoundUrl');
  if (notFound) {
    redirect(res, notFound.replace('{code}', link.code).replace('{url}', encodeURIComponent(link.url)), 302);
    return true;
  }
  const html = renderMessage(ctx, {
    status: kind === 'expired' ? 410 : 404,
    title: kind === 'expired' ? '链接已过期' : '链接已停用',
    desc: kind === 'expired'
      ? '该短链接已超过有效期，无法继续访问。'
      : '该短链接已被管理员停用，暂时无法访问。',
    code: link.code,
  });
  sendHtml(res, kind === 'expired' ? 410 : 404, html);
  return true;
}

function showPassword(res, ctx, link, req) {
  const html = renderMessage(ctx, {
    status: 401,
    title: '该链接受密码保护',
    desc: `请输入访问密码以继续访问 /${link.code}`,
    code: link.code,
    form: { action: `/${link.code}`, method: 'post', kind: 'password' },
  });
  sendHtml(res, 401, html, { 'Cache-Control': 'no-store' });
  return true;
}

export { HttpError };
export const refererOf = hostOf;

/**
 * 举报提交（POST /<code>，隐藏字段 kind=report）。
 *
 * 和密码提交共用同一个 URL，靠 kind 区分：短码字符集里没有 `/`，
 * 另开一条 /report/<code> 反而会和子路径透传撞上。
 */
export async function handleReportSubmit(ctx, req, res, body) {
  const code = String(body.code || '');
  const link = ctx.cache.load(code) || ctx.store.findLinkByCode(code);
  if (!link) return false;
  if (ctx.settings.get('allowReport') === false) return false;

  const ip = clientIp(req, ctx.settings.get('trustProxy'));
  if (ctx.reports.throttled(link.code, ip)) {
    redirect(res, `/${encodeURIComponent(link.code)}+?reported=1`, 303);
    return true;
  }
  ctx.reports.add({
    code: link.code,
    reason: body.reason,
    note: body.note,
    ip,
    ua: req.headers['user-agent'] || '',
  });
  // 举报是最需要有人立刻知道的一类事件：它的价值全在「被看见」上。
  // 正文不往通知里带——那是匿名访问者写的，原样转发到群里等于替对方发言
  ctx.notify?.emit('report.new', {
    subject: link.code,
    text: `短链 /${link.code} 收到一条举报（${REASON_LABEL[ctx.reports.normalize(body.reason)] || '其它问题'}）`,
    link: `${String(ctx.settings.get('baseUrl') || '').replace(/\/+$/, '')}/admin#/reports`,
    data: { code: link.code, reason: ctx.reports.normalize(body.reason) },
  });
  // 回名片页给一句确认就行，不新开「举报成功」页：这条路径不该比短链本身更显眼
  redirect(res, `/${encodeURIComponent(link.code)}+?reported=1`, 303);
  return true;
}

/** 密码保护链接的表单提交（POST /<code>） */
export async function handlePasswordSubmit(ctx, req, res, body) {
  const code = String(body.code || '');
  const link = ctx.store.findLinkByCode(code);
  if (!link || !link.protected) return false;
  const row = ctx.store.sql.getPasswordHash.get(link.code) || ctx.store.sql.getPasswordHashCI.get(code);
  if (!scryptVerify(body.password || '', row?.password)) {
    const html = renderMessage(ctx, {
      status: 401,
      title: '密码不正确',
      desc: `请重新输入 /${code} 的访问密码`,
      code,
      form: { action: `/${encodeURIComponent(code)}`, method: 'post', kind: 'password' },
    });
    sendHtml(res, 401, html);
    return true;
  }
  // Cookie 名和跳转都用记录里的规范短码：大小写抄错时不能让解锁 Cookie 对不上号
  res.setHeader('Set-Cookie', accessCookie(ctx.secret, link.code));
  redirect(res, `/${encodeURIComponent(link.code)}`, 302);
  return true;
}
