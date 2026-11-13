import { DEFAULTS } from '../config.js';

/** 设置项：DB 覆盖 config 默认值，读写都走这里 */
export const SETTING_KEYS = Object.keys(DEFAULTS);

const CAST = {
  redirectStatus: Number,
  titleFetch: Boolean,
  titleTimeout: Number,
  publicCreate: Boolean,
  interstitialDefault: Boolean,
  landingCountdown: Number,
  allowReport: Boolean,
  codeLength: Number,
  blockBots: Boolean,
  rateLimitPerMinute: Number,
  createRateLimitPerMinute: Number,
  countFlushMs: Number,
  countCacheMax: Number,
  trustProxy: Boolean,
  retentionDays: Number,
  allowRegistration: Boolean,
  expiredGraceDays: Number,
  trashRetentionDays: Number,
  dedupeWindowSec: Number,
  healthCheckIntervalMin: Number,
  healthCheckTimeout: Number,
  historyKeep: Number,
  notifyDedupeHours: Number,
  notifyExpireDays: Number,
  notifyAllowPrivate: Boolean,
  port: Number,
};

export class Settings {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this.data = { ...DEFAULTS };
    this.data.port = config.port;
    this.reload();
  }

  reload() {
    const rows = this.store.sql.listSettings.all();
    const overrides = {};
    for (const { key, value } of rows) {
      if (!(key in DEFAULTS)) continue;
      overrides[key] = this.cast(key, value);
    }
    this.data = { ...DEFAULTS, port: this.config.port, ...overrides };
    this.version = (this.version || 0) + 1;
    return this.data;
  }

  cast(key, value) {
    switch (CAST[key]) {
      case Number: {
        const n = Number(value);
        return Number.isFinite(n) ? n : DEFAULTS[key];
      }
      case Boolean:
        return value === true || value === 'true' || value === 1 || value === '1';
      default:
        return value;
    }
  }

  get(key) {
    return this.data[key];
  }

  all() {
    return { ...this.data };
  }

  /** 设置项白名单校验后落库 */
  update(patch) {
    const applied = {};
    const rejected = [];
    for (const [key, raw] of Object.entries(patch || {})) {
      if (!(key in DEFAULTS) || key === 'port') {
        rejected.push(key);
        continue;
      }
      const value = this.validate(key, raw);
      if (value === undefined) {
        rejected.push(key);
        continue;
      }
      this.store.sql.setSetting.run(key, typeof value === 'boolean' ? String(value) : String(value));
      applied[key] = value;
    }
    this.reload();
    return { applied, rejected };
  }

  validate(key, raw) {
    const str = typeof raw === 'string' ? raw.trim() : raw;
    switch (key) {
      case 'redirectStatus': {
        const n = Number(str);
        return [301, 302, 307, 308].includes(n) ? n : undefined;
      }
      case 'codeLength': {
        const n = Number(str);
        return Number.isInteger(n) && n >= 3 && n <= 32 ? n : undefined;
      }
      case 'titleTimeout': {
        const n = Number(str);
        return Number.isFinite(n) && n >= 500 && n <= 15000 ? n : undefined;
      }
      case 'rateLimitPerMinute':
      case 'createRateLimitPerMinute': {
        const n = Number(str);
        return Number.isFinite(n) && n >= 1 && n <= 100000 ? n : undefined;
      }
      case 'countFlushMs': {
        const n = Number(str);
        return Number.isFinite(n) && n >= 100 && n <= 60000 ? n : undefined;
      }
      case 'countCacheMax': {
        const n = Number(str);
        return Number.isFinite(n) && n >= 1000 && n <= 500000 ? n : undefined;
      }
      case 'expiredPolicy': {
        return ['none', 'disable', 'delete'].includes(str) ? str : undefined;
      }
      case 'expiredGraceDays': {
        const n = Number(str);
        return Number.isFinite(n) && n >= 0 && n <= 3650 ? Math.floor(n) : undefined;
      }
      case 'trashRetentionDays': {
        const n = Number(str);
        return Number.isFinite(n) && n >= 0 && n <= 3650 ? Math.floor(n) : undefined;
      }
      case 'dedupeWindowSec': {
        const n = Number(str);
        return Number.isFinite(n) && n >= 0 && n <= 86400 ? Math.floor(n) : undefined;
      }
      case 'healthCheckIntervalMin': {
        const n = Number(str);
        return Number.isFinite(n) && n >= 0 && n <= 10080 ? Math.floor(n) : undefined;
      }
      case 'healthCheckTimeout': {
        const n = Number(str);
        return Number.isFinite(n) && n >= 1000 && n <= 30000 ? Math.floor(n) : undefined;
      }
      case 'historyKeep': {
        const n = Number(str);
        return Number.isFinite(n) && n >= 0 && n <= 200 ? Math.floor(n) : undefined;
      }
      case 'notifyDedupeHours': {
        const n = Number(str);
        return Number.isFinite(n) && n >= 0 && n <= 720 ? Math.floor(n) : undefined;
      }
      case 'notifyExpireDays': {
        const n = Number(str);
        return Number.isFinite(n) && n >= 1 && n <= 90 ? Math.floor(n) : undefined;
      }
      case 'retentionDays': {
        const n = Number(str);
        return Number.isFinite(n) && n >= 0 && n <= 3650 ? n : undefined;
      }
      case 'baseUrl': {
        const s = String(str || '').replace(/\/+$/, '');
        if (!s) return '';
        try {
          const u = new URL(s);
          if (!/^https?:$/.test(u.protocol)) return undefined;
          return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
        } catch {
          return undefined;
        }
      }
      case 'notFoundUrl': {
        const s = String(str || '');
        if (!s) return '';
        try {
          const u = new URL(s);
          return /^https?:$/.test(u.protocol) ? u.href : undefined;
        } catch {
          return undefined;
        }
      }
      case 'siteName':
      case 'landingOrgName':
      case 'siteDescription': {
        const s = String(str ?? '');
        return s.length <= 120 ? s : s.slice(0, 120);
      }
      case 'landingDisclaimer': {
        // 免责声明是给人看的正文，放宽到 500 字；换行保留，渲染时按行分段
        const s = String(str ?? '');
        return s.length <= 500 ? s : s.slice(0, 500);
      }
      case 'landingLogoUrl': {
        const s = String(str || '').trim();
        if (!s) return '';
        // 只认 http(s) 和站内绝对路径：这一列会被直接拼进 <img src>，
        // 放过 javascript: 或 data: 就等于给建页开了一个注入口子
        if (/^\/(?!\/)/.test(s)) return s.slice(0, 200);
        try {
          const u = new URL(s);
          return /^https?:$/.test(u.protocol) ? u.href.slice(0, 300) : undefined;
        } catch {
          return undefined;
        }
      }
      case 'landingCountdown': {
        const n = Number(str);
        return Number.isFinite(n) && n >= 0 && n <= 30 ? Math.floor(n) : undefined;
      }
      case 'reservedCodes': {
        return String(str || '')
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
          .join(',');
      }
      case 'titleFetch':
      case 'publicCreate':
      case 'interstitialDefault':
      case 'allowReport':
      case 'blockBots':
      case 'trustProxy':
      case 'notifyAllowPrivate':
      case 'allowRegistration':
        return raw === true || raw === 'true' || raw === 'on' || raw === '1';
      default:
        return typeof str === 'string' ? str : undefined;
    }
  }

  reservedSet() {
    return new Set(String(this.data.reservedCodes || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  }
}
