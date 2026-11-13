import { createHmac, randomUUID } from 'node:crypto';

import { assertPublicHost } from './titles.js';
import { truncate } from '../lib/util.js';

/**
 * 事件通知：把「有事情需要人处理」推出去。
 *
 * 系统里已经攒了足够多的信号——死链、举报、到期、备份失败——但它们全都只活在
 * 管理台的某个页面里。管理员不会一直开着这个页面，于是这些事真正被发现的时间，
 * 往往是有人来投诉的时候。这一层只做一件事：在事情发生的那一刻，把它推到人手上。
 *
 * 几条刻意的取舍：
 * - **推送失败不能影响主流程**。发通知的代码永远在 try/catch 里，
 *   巡检、举报写入都不该因为一个 webhook 404 而失败
 * - **同一件事不重复推**。死链会在每一轮巡检里被再次判死，没有去重就是每小时一条
 * - **签名而不是裸奔**。带 HMAC 签名与时间戳，接收端能确认「这是我们发的」，
 *   也能拒绝重放的旧请求
 * - **发不出去要留底**。投递记录落库，界面上能看到失败原因，而不是「我明明配了却没收到」
 * - **静默不是丢弃**。夜里三点推一条死链，除了让人第二天关掉通知没有别的结果；
 *   静默期内的事件先挂着，结束时合并成一条摘要补发
 */

export const EVENTS = {
  'link.dead': '短链变成死链',
  'link.expiring': '短链即将到期',
  'report.new': '收到新的举报',
  'backup.failed': '自动备份失败',
  // 定期摘要不是「出事」，是「到点汇报」。区分开是因为订阅时心态不同：
  // 前四个是值班要看的，这一个是想每天看一眼大盘
  'digest.periodic': '运营摘要（定期）',
};

const EVENT_KEYS = Object.keys(EVENTS);

/** 渠道类型决定 payload 形状：通用 JSON 走自己的协议，聊天工具要它们各自的格式 */
export const KINDS = {
  webhook: '通用 Webhook（JSON）',
  slack: 'Slack',
  feishu: '飞书',
  dingtalk: '钉钉',
};

/** 重试间隔：第一次立刻发，之后退避。三次都失败就交给人看，不再无限重试 */
const RETRY_DELAYS = [0, 5000, 30000];
/** 静默期策略：合并补发 / 静默期内直接不发 */
export const QUIET_POLICIES = { digest: '静默期内攒着，结束后合并补发', drop: '静默期内直接不发' };

/** `HH:MM` → 分钟数。非法一律 null，别让一个手滑的输入变成「全天静默」 */
export function parseClock(raw) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!(h >= 0 && h <= 23 && min >= 0 && min <= 59)) return null;
  return h * 60 + min;
}

/**
 * 这个时刻是否落在静默区间里。
 *
 * 用服务器本地时间：自托管站的服务器时区基本就是站点时区，为算「现在几点」
 * 引一套时区库不值得。跨夜（22:00→08:00）用 from > to 表示，
 * 此时区间是 [from, 24:00) ∪ [00:00, to)：
 * - 开始等于结束视为「没设」，否则一填错就把整天的通知都吞了
 * - 离线按分钟闭区间，22:00 与 08:00 都算静默内——
 *   边界差一分钟没人会在意，漏掉 08:00 那一分钟反而可能被当成 bug
 */
export function inQuietHours(from, to, at = new Date()) {
  const a = parseClock(from);
  const b = parseClock(to);
  if (a === null || b === null || a === b) return false;
  const now = at.getHours() * 60 + at.getMinutes();
  // 两端都算静默内：差这一分钟没人会在意，而漏掉结束那一刻反而会被当成 bug
  return a < b ? now >= a && now <= b : now >= a || now <= b;
}

/** 距离静默结束还有多少毫秒，用来算摘要什么时候补发 */
export function msUntilQuietEnd(to, at = new Date()) {
  const b = parseClock(to);
  if (b === null) return 0;
  const target = new Date(at.getTime());
  target.setHours(Math.floor(b / 60), b % 60, 0, 0);
  if (target <= at) target.setDate(target.getDate() + 1);
  return target - at;
}
const MAX_BODY = 4000;
const TIMEOUT = 8000;

export function sign(secret, timestamp, body) {
  return createHmac('sha256', String(secret || '')).update(`${timestamp}.${body}`).digest('hex');
}

/** 把统一的事件结构翻译成目标平台吃得下的形状 */
export function buildBody(kind, payload) {
  const text = payload.text || payload.title || payload.event;
  if (kind === 'slack') return { text };
  if (kind === 'feishu') return { msg_type: 'text', content: { text } };
  if (kind === 'dingtalk') return { msgtype: 'text', text: { content: text } };
  return payload;
}

export class NotifyService {
  constructor({ store, settings, logger = console, fetchImpl = globalThis.fetch } = {}) {
    this.store = store;
    this.settings = settings;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.queue = [];
    this.running = false;
    this.timer = null;
  }

  /* ---------- 渠道 ---------- */

  /**
   * 渠道列表。`withSecret` 只给内部投递用——列表接口跑的是默认值，
   * 明文的签名密钥永远不该出现在浏览器拿到的 JSON 里
   */
  listChannels({ withSecret = false } = {}) {
    return this.store.sql.listChannels.all().map((row) => ({
      id: row.id,
      name: row.name,
      url: row.url,
      kind: row.kind,
      created_at: row.created_at,
      enabled: Boolean(row.enabled),
      events: String(row.events || '').split(',').map((s) => s.trim()).filter(Boolean),
      // 密钥只报「有没有」，不把明文发回浏览器：签名密钥一旦出现在
      // 接口返回里，它就不再是个秘密了
      hasSecret: Boolean(row.secret),
      quiet: {
        from: row.quiet_from || '',
        to: row.quiet_to || '',
        policy: QUIET_POLICIES[row.quiet_policy] ? row.quiet_policy : 'digest',
        pierce: String(row.quiet_pierce || '').split(',').map((s) => s.trim()).filter(Boolean),
      },
      ...(withSecret ? { secret: row.secret } : {}),
    }));
  }

  normalizeEvents(input) {
    const list = Array.isArray(input) ? input : String(input || '').split(',');
    const out = [];
    for (const item of list) {
      const key = String(item).trim();
      if (EVENT_KEYS.includes(key) && !out.includes(key)) out.push(key);
    }
    return out;
  }

  /** 静默配置白名单：填错就当没填，「全天静默」不该是手滑的默认结果 */
  normalizeQuiet(input = {}) {
    const from = String(input.from || '').trim();
    const to = String(input.to || '').trim();
    const valid = parseClock(from) !== null && parseClock(to) !== null && parseClock(from) !== parseClock(to);
    return {
      from: valid ? from : '',
      to: valid ? to : '',
      policy: QUIET_POLICIES[input.policy] ? input.policy : 'digest',
      pierce: this.normalizeEvents(input.pierce || []).join(','),
    };
  }

  validateUrl(raw) {
    let url;
    try {
      url = new URL(String(raw || '').trim());
    } catch {
      return { error: '地址格式不正确' };
    }
    if (!/^https?:$/.test(url.protocol)) return { error: '只支持 http(s) 地址' };
    return { url: url.href };
  }

  createChannel({ name, url, kind, events, secret, enabled, quiet }) {
    const checked = this.validateUrl(url);
    if (checked.error) throw new Error(checked.error);
    const list = this.normalizeEvents(events);
    if (!list.length) throw new Error('至少要勾选一个事件');
    const id = this.store.sql.insertChannel.run(
      String(name || '').trim().slice(0, 60) || '未命名渠道',
      checked.url,
      KINDS[kind] ? kind : 'webhook',
      list.join(','),
      String(secret || '').slice(0, 200),
      enabled === false ? 0 : 1,
      Date.now(),
    ).lastInsertRowid;
    if (quiet) {
      const q = this.normalizeQuiet(quiet);
      this.store.sql.setChannelQuiet.run(q.from, q.to, q.policy, q.pierce, Number(id));
    }
    return this.listChannels().find((c) => Number(c.id) === Number(id));
  }

  updateChannel(id, patch) {
    const current = this.store.sql.getChannel.get(Number(id));
    if (!current) throw new Error('渠道不存在');
    const url = patch.url === undefined ? current.url : this.validateUrl(patch.url).url;
    if (!url) throw new Error('地址格式不正确');
    const events = patch.events === undefined ? current.events : this.normalizeEvents(patch.events).join(',');
    if (!events) throw new Error('至少要勾选一个事件');
    const kind = patch.kind === undefined ? current.kind : (KINDS[patch.kind] ? patch.kind : 'webhook');
    const secret = patch.secret === undefined ? current.secret : String(patch.secret || '').slice(0, 200);
    const enabled = patch.enabled === undefined ? current.enabled : (patch.enabled ? 1 : 0);
    const name = patch.name === undefined ? current.name : String(patch.name).trim().slice(0, 60) || current.name;
    this.store.sql.updateChannel.run(name, url, kind, events, secret, enabled, Number(id));
    if (patch.quiet !== undefined) {
      const q = this.normalizeQuiet(patch.quiet || {});
      this.store.sql.setChannelQuiet.run(q.from, q.to, q.policy, q.pierce, Number(id));
    }
    return this.listChannels().find((c) => Number(c.id) === Number(id));
  }

  deleteChannel(id) {
    this.store.sql.deleteChannelDeliveries.run(Number(id));
    return this.store.sql.deleteChannel.run(Number(id)).changes || 0;
  }

  /* ---------- 事件 ---------- */

  /**
   * 发出一个事件。**永远不抛异常**：调用方是巡检、举报、备份这些主流程，
   * 一个 webhook 挂了不该把它们的活一起带下水，最多是少收到一条通知。
   */
  emit(event, { subject = '', title = '', text = '', link = '', data = {}, dedupe = true } = {}) {
    try {
      if (!EVENT_KEYS.includes(event)) return 0;
      const channels = this.listChannels({ withSecret: true }).filter((c) => c.enabled && c.events.includes(event));
      if (!channels.length) return 0;
      const payload = {
        event,
        // 事件名之外再给一句人话：接收端直接往群里丢也不用自己拼文案
        text: text || `${EVENTS[event]}${subject ? `：${subject}` : ''}`,
        title: title || EVENTS[event],
        subject: String(subject || ''),
        site: this.settings.get('siteName'),
        link: link || '',
        at: Date.now(),
        data,
      };
      let queued = 0;
      for (const channel of channels) {
        // 定期摘要这类「到点汇报」允许跳过去重：手动点一次「立即推送」
        // 却被去重窗口吞掉，人只会以为按钮坏了
        if (dedupe && this.recentlyDelivered(channel, event, subject)) continue;
        const quiet = channel.quiet || {};
        // 静默期内：先判断这条事件是不是允许穿透（备份失败这类等到早上已经晚了）
        if (inQuietHours(quiet.from, quiet.to) && !(quiet.pierce || []).includes(event)) {
          if (quiet.policy === 'drop') {
            // 明确选了「静默期内直接不发」：留一条记录说明它被吞了，
            // 否则事后又是「我明明配了却没收到」
            this.recordDropped(channel, event, subject, payload);
            continue;
          }
          this.hold(channel, event, subject, payload);
          queued += 1;
          continue;
        }
        this.enqueue(channel, event, subject, payload, 0);
        queued += 1;
      }
      return queued;
    } catch (err) {
      this.logger.warn?.('[notify] emit 失败', err?.message || err);
      return 0;
    }
  }

  /**
   * 去重：同一渠道、同一事件、同一主体，窗口内只推一次。
   * 死链在每轮巡检里都会被再次判死，不拦的话它每小时都会来敲一次门。
   */
  recentlyDelivered(channel, event, subject) {
    const windowMs = Math.max(0, Number(this.settings.get('notifyDedupeHours')) || 0) * 3600000;
    if (!windowMs) return false;
    const since = Date.now() - windowMs;
    // 挂起的（held）也算「已经在队列里了」：不算的话，静默期里同一件事
    // 每次发生都会被再挂一条，早上补发时摘要里就全是重复
    const row = this.store.db
      .prepare("SELECT id FROM notify_deliveries WHERE channel_id = ? AND event = ? AND subject = ? AND status IN ('success','held') AND created_at >= ? LIMIT 1")
      .get(Number(channel.id), String(event), String(subject || ''), since);
    return Boolean(row);
  }

  /**
   * 静默期内挂起。**不丢，只推迟**：静默结束由 maintenance 调 releaseHeld()
   * 合并补发。落库而不是放内存里，是因为进程可能在静默期内重启。
   */
  hold(channel, event, subject, payload) {
    const id = Number(
      this.store.sql.insertDelivery.run(
        Number(channel.id), String(event), String(subject || ''), JSON.stringify(payload), 'held', 0, Date.now(),
      ).lastInsertRowid,
    );
    // 留一句话说明它为什么躺在这里：界面上光看「静默待发」不知道什么时候会发
    this.store.db.prepare("UPDATE notify_deliveries SET note = '静默时段，等结束后合并补发' WHERE id = ?").run(id);
  }

  /** 静默期内直接不发：留痕，界面上能看到「被静默吞掉了」，而不是查无此事 */
  recordDropped(channel, event, subject, payload) {
    const id = Number(
      this.store.sql.insertDelivery.run(
        Number(channel.id), String(event), String(subject || ''), JSON.stringify(payload), 'pending', 1, Date.now(),
      ).lastInsertRowid,
    );
    this.store.sql.finishDelivery.run('dropped', 1, null, '静默时段，按渠道策略不发送', Date.now(), id);
  }

  /**
   * 静默结束：把挂起的记录合并成一条摘要补发。
   *
   * 逐条重放等于把夜里攒的 40 条挪到早上一起炸，人一样会关掉通知。
   * 所以按渠道合成一条：说清「夜里攒了几条、分别是哪些事件」，
   * 点进去就是对应的列表。逐条明细照样留在投递记录里。
   *
   * 返回 { released, dropped }，供维护任务记日志。
   */
  releaseHeld({ now = new Date() } = {}) {
    const held = this.store.sql.heldDeliveries.all();
    if (!held.length) return { released: 0, dropped: 0 };
    const byChannel = new Map();
    for (const row of held) {
      if (!byChannel.has(row.channel_id)) byChannel.set(row.channel_id, []);
      byChannel.get(row.channel_id).push(row);
    }
    let released = 0;
    let dropped = 0;
    const channels = new Map(this.listChannels({ withSecret: true }).map((c) => [Number(c.id), c]));
    for (const [channelId, rows] of byChannel) {
      const channel = channels.get(Number(channelId));
      // 渠道被删了或还停在静默里（改了时段）：保持挂起，别凭空补发
      if (!channel || inQuietHours(channel.quiet?.from, channel.quiet?.to, now)) continue;
      if (channel.quiet?.policy === 'drop') {
        // 挂在静默里的时候是 digest，后来改成 drop：按当前策略丢弃，不补发
        const dropIds = new Set(rows.map((r) => r.id));
        for (const r of rows) {
          this.store.sql.finishDelivery.run('dropped', 0, null, '静默时段，按渠道策略不发送', Date.now(), r.id);
        }
        dropped += dropIds.size;
        continue;
      }
      const counts = new Map();
      for (const r of rows) counts.set(r.event, (counts.get(r.event) || 0) + 1);
      const parts = [...counts.entries()].map(([ev, n]) => `${EVENTS[ev] || ev} ${n} 条`);
      const subjects = [...new Set(rows.map((r) => r.subject).filter(Boolean))].slice(0, 5);
      const payload = {
        event: 'digest',
        // 摘要本身也是一条通知，文本要说清「这是夜里攒下的」
        text: `静默时段攒下 ${rows.length} 条通知：${parts.join('，')}${subjects.length ? `（涉及 ${subjects.join('、')}${rows.length > subjects.length ? ' 等' : ''}）` : ''}`,
        title: '静默时段汇总',
        subject: `quiet-digest-${channel.id}`,
        site: this.settings.get('siteName'),
        link: `${String(this.settings.get('baseUrl') || '').replace(/\/+$/, '')}/admin#/notify`,
        at: Date.now(),
        data: { count: rows.length, events: [...counts.entries()].map(([event, n]) => ({ event, count: n })), codes: subjects },
      };
      // 先把挂起的记录结掉再入队：反过来的话这段代码抛异常，
      // 下一次维护又会把它们补发一遍，摘要会重复
      for (const r of rows) {
        this.store.sql.finishDelivery.run('success', 0, null, '已并入静默摘要', Date.now(), r.id);
      }
      this.enqueue(channel, 'digest', payload.subject, payload, 0);
      released += rows.length;
    }
    return { released, dropped };
  }

  enqueue(channel, event, subject, payload, attempt) {
    const id = this.store.sql.insertDelivery.run(
      Number(channel.id), String(event), String(subject || ''), JSON.stringify(payload), 'pending', attempt, Date.now(),
    ).lastInsertRowid;
    this.queue.push({ deliveryId: Number(id), channel, payload, attempt });
    this.kick();
    return id;
  }

  kick() {
    if (this.running) return;
    this.running = true;
    // 用 setImmediate 而不是直接 await：emit 来自请求处理路径，
    // 不该让调用方等一个外部 HTTP 往返
    setImmediate(() => {
      this.drain().catch((err) => this.logger.warn?.('[notify] drain 失败', err?.message || err));
    });
  }

  async drain() {
    try {
      while (this.queue.length) {
        const job = this.queue.shift();
        await this.deliver(job);
      }
    } finally {
      this.running = false;
      if (this.queue.length) this.kick();
    }
  }

  async deliver(job) {
    const { deliveryId, channel, payload, attempt } = job;
    const body = JSON.stringify(buildBody(channel.kind, payload));
    const timestamp = String(Date.now());
    const result = await this.post(channel, body, timestamp, payload.event);
    if (result.ok) {
      this.store.sql.finishDelivery.run('success', attempt + 1, result.status, truncate(result.note || '', 300), Date.now(), deliveryId);
      return;
    }
    const next = attempt + 1;
    if (next < RETRY_DELAYS.length) {
      // 还没到次数：先记一笔「重试中」，把原因留下，
      // 这样界面上看到的是「在重试 / 为什么退回来了」而不是一片空白
      this.store.sql.finishDelivery.run('retry', next, result.status, truncate(result.note || '', 300), null, deliveryId);
      const delay = RETRY_DELAYS[next] || 30000;
      const timer = setTimeout(() => {
        this.queue.push({ deliveryId, channel, payload, attempt: next });
        this.kick();
      }, delay);
      timer.unref?.();
      return;
    }
    this.store.sql.finishDelivery.run('failed', next, result.status, truncate(result.note || '', 300), Date.now(), deliveryId);
    this.logger.warn?.(`[notify] 投递失败 ${channel.name} ${payload.event}: ${result.note || result.status}`);
  }

  async post(channel, body, timestamp, eventName = '') {
    // SSRF：地址是管理员填的，但仍然不该让一个填错的地址把服务器当成内网跳板。
    // 自建的内部接收端可以显式打开 notifyAllowPrivate
    if (!this.settings.get('notifyAllowPrivate')) {
      try {
        await assertPublicHost(new URL(channel.url).hostname);
      } catch (err) {
        return { ok: false, status: 0, note: `目标地址不可访问：${err.message}` };
      }
    }
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'HighURL-Notify/1.0',
      // 签名与事件名放进请求头：接收端不用解析 body 就能路由，
      // 而 fake 成 Slack 格式时 body 里本来就没有事件名
      'X-HighURL-Event': String(eventName || ''),
      'X-HighURL-Delivery': String(randomUUID()),
      'X-HighURL-Timestamp': timestamp,
    };
    if (channel.secret) headers['X-HighURL-Signature'] = `sha256=${sign(channel.secret, timestamp, body)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      const res = await this.fetchImpl(channel.url, { method: 'POST', headers, body, signal: controller.signal });
      const text = await res.text().catch(() => '');
      return { ok: res.ok, status: res.status, note: res.ok ? '' : text || `HTTP ${res.status}` };
    } catch (err) {
      const note = err?.name === 'AbortError' ? `超时（${TIMEOUT}ms）` : err?.message || '请求失败';
      return { ok: false, status: 0, note };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 手动测试：立刻发一次，把结果直接还给界面 */
  async test(channelId) {
    const channel = this.listChannels({ withSecret: true }).find((c) => Number(c.id) === Number(channelId));
    if (!channel) throw new Error('渠道不存在');
    const payload = {
      event: 'test',
      text: `【${this.settings.get('siteName')}】这是一条测试通知`,
      title: '测试通知',
      subject: 'test',
      site: this.settings.get('siteName'),
      link: '',
      at: Date.now(),
      data: { channel: channel.name },
    };
    const body = JSON.stringify(buildBody(channel.kind, payload));
    const timestamp = String(Date.now());
    const result = await this.post(channel, body, timestamp, payload.event);
    const id = Number(this.store.sql.insertDelivery.run(Number(channel.id), 'test', 'test', body, 'pending', 1, Date.now()).lastInsertRowid);
    this.store.sql.finishDelivery.run(result.ok ? 'success' : 'failed', 1, result.status, truncate(result.note || '', 300), Date.now(), id);
    return { ok: result.ok, status: result.status, note: result.note || '' };
  }

  /** 投递记录：失败的排在最前，界面第一眼该看到的是问题 */
  deliveries({ limit = 30, status = '' } = {}) {
    const size = Math.min(200, Math.max(1, Number(limit) || 30));
    // 失败和重试中的排在最前：这页第一眼该看到的是「哪条没送到」，
    // 而不是最近 30 条成功的流水
    const rows = status
      ? this.store.db.prepare('SELECT * FROM notify_deliveries WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, size)
      : this.store.db
          // 失败、重试中、被静默挂住的三类排前面：这页第一眼该看到「哪些没送到」
          .prepare(`SELECT * FROM notify_deliveries ORDER BY (status IN ('failed','retry','held')) DESC, id DESC LIMIT ?`)
          .all(size);
    const counts = { success: 0, failed: 0, retry: 0, pending: 0, held: 0, dropped: 0 };
    for (const row of this.store.db.prepare('SELECT status, COUNT(*) AS n FROM notify_deliveries GROUP BY status').all()) {
      if (row.status in counts) counts[row.status] = row.n;
    }
    return {
      items: rows.map((row) => ({ ...row, channel: this.channelName(row.channel_id) })),
      counts,
    };
  }

  channelName(id) {
    const row = this.store.sql.getChannel.get(Number(id));
    return row ? row.name : '(已删除)';
  }

  retry(id) {
    const row = this.store.db.prepare('SELECT * FROM notify_deliveries WHERE id = ?').get(Number(id));
    if (!row) throw new Error('记录不存在');
    const channel = this.store.sql.getChannel.get(Number(row.channel_id));
    if (!channel) throw new Error('渠道已被删除，无法重试');
    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      throw new Error('这条记录的报文无法解析');
    }
    this.enqueue(
      { ...channel, enabled: Boolean(channel.enabled), events: String(channel.events || '').split(',') },
      row.event,
      row.subject,
      payload,
      0,
    );
    return { queued: true };
  }
}
