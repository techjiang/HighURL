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
 */

export const EVENTS = {
  'link.dead': '短链变成死链',
  'link.expiring': '短链即将到期',
  'report.new': '收到新的举报',
  'backup.failed': '自动备份失败',
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

  createChannel({ name, url, kind, events, secret, enabled }) {
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
  emit(event, { subject = '', title = '', text = '', link = '', data = {} } = {}) {
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
        if (this.recentlyDelivered(channel, event, subject)) continue;
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
    const row = this.store.db
      .prepare('SELECT id FROM notify_deliveries WHERE channel_id = ? AND event = ? AND subject = ? AND status = ? AND created_at >= ? LIMIT 1')
      .get(Number(channel.id), String(event), String(subject || ''), 'success', since);
    return Boolean(row);
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
          .prepare(`SELECT * FROM notify_deliveries ORDER BY (status IN ('failed','retry')) DESC, id DESC LIMIT ?`)
          .all(size);
    const counts = { success: 0, failed: 0, retry: 0, pending: 0 };
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
