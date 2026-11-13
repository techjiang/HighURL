/**
 * 实时访问流：把「刚刚有谁点了哪条短链」推到管理台。
 *
 * 这是唯一一个跳转热路径会碰的展示型结构，所以必须廉价：
 * 只往一个定长环形缓冲里塞一条对象，再挨个写进已连接的 SSE 客户端。
 * 没有客户端连着的时候，写事件这一步直接跳过，代价是一次数组长度为 0 的遍历。
 *
 * IP 在这里就脱敏，不留原文：这条流只是为了看出「有访问、从哪来、什么设备」，
 * 精确到某台机器不是它的用途。
 */
const MAX_EVENTS = 100;

export function maskIp(ip) {
  const raw = String(ip || '').replace(/^::ffff:/, '');
  if (!raw) return '';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(raw)) {
    const parts = raw.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.*`;
  }
  if (raw.includes(':')) {
    // IPv6 一共 8 段，留前两段足够定位到网络
    return `${raw.split(':').slice(0, 2).join(':')}:…`;
  }
  return raw.slice(0, 12);
}

export class VisitStream {
  constructor({ max = MAX_EVENTS } = {}) {
    this.max = max;
    this.events = [];
    this.clients = new Set();
    this.total = 0;
    this.dropped = 0;
  }

  /**
   * 记一条访问。字段全部来自跳转时已经算好的东西，不再额外解析 UA。
   * @param {{code:string, ip?:string, ref?:string, platform?:string, outcome?:string}} visit
   */
  push({ code, ip = '', ref = '', platform = 'unknown', outcome = 'redirect', at = Date.now() }) {
    this.total += 1;
    const event = {
      id: this.total,
      at,
      code,
      ip: maskIp(ip),
      ref: ref || '',
      platform: platform || 'unknown',
      outcome,
    };
    this.events.push(event);
    if (this.events.length > this.max) {
      this.events.shift();
      this.dropped += 1;
    }
    if (this.clients.size) {
      const payload = `data: ${JSON.stringify(event)}\n\n`;
      for (const res of this.clients) {
        try {
          res.write(payload);
        } catch {
          this.clients.delete(res);
        }
      }
    }
    return event;
  }

  /** 近期访问，最新的在前 */
  recent(n = 20) {
    return this.events.slice(-Math.max(1, Math.min(this.max, n))).reverse();
  }

  /** 挂一个 SSE 客户端。返回退订函数 */
  attach(res, { warm = 12 } = {}) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    // 连上先补一段历史，页面不用等到下一次访问才有内容
    for (const event of this.recent(warm).reverse()) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    this.clients.add(res);
    const drop = () => {
      this.clients.delete(res);
    };
    res.on('close', drop);
    res.on('error', drop);
    return drop;
  }

  stats() {
    return { clients: this.clients.size, buffered: this.events.length, total: this.total };
  }

  /** 进程退出时给客户端一个干净的收尾，免得浏览器一直重连 */
  closeAll() {
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }
}
