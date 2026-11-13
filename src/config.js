import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, randomId } from './lib/util.js';

const DEFAULTS = {
  siteName: 'HighURL',
  siteDescription: '轻快、可靠的自托管短链接服务',
  baseUrl: '',
  redirectStatus: 302,
  blockBots: false,
  titleFetch: true,
  titleTimeout: 5000,
  publicCreate: false,
  reservedCodes: 'api,admin,static,assets,login,logout,health,metrics,docs,install,favicon.ico,favicon.svg',
  codeLength: 6,
  notFoundUrl: '',
  // 新短链默认是否启用「跳转前的自动建页」。默认关：绝大多数短链就是该直接跳，
  // 让人多点一次是净损失。有需要的单条或整体再打开。
  interstitialDefault: false,
  // 建页的组织级配置：一处设好，全站所有建页都用。
  // 单独建一条链接的时候不该再填一遍免责声明，而各条自己填又必然不一致。
  landingOrgName: '',
  landingLogoUrl: '',
  landingDisclaimer: '',
  // 建页上「继续访问」按钮前的倒数提示，0 表示不显示。
  // 注意这不是自动跳转：只是提醒一句「你即将离开本站」，人还是要自己点
  landingCountdown: 0,
  // 名片页 /<code>+ 上是否显示「举报这条链」入口
  allowReport: true,
  rateLimitPerMinute: 600,
  createRateLimitPerMinute: 60,
  countFlushMs: 1000,
  countCacheMax: 20000,
  trustProxy: false,
  retentionDays: 0,
  allowRegistration: false,
  expiredPolicy: 'none',
  expiredGraceDays: 7,
  // 同一 IP 对同一短链，多少秒内的重复点击只算一次。0 表示不去重（按原始点击记）
  dedupeWindowSec: 0,
  // 回收站自动清理天数，0 表示一直留着等人工处理
  trashRetentionDays: 0,
  // 目标链接健康巡检间隔（分钟），0 表示关闭自动巡检
  healthCheckIntervalMin: 0,
  // 单次探测超时（毫秒）
  healthCheckTimeout: 8000,
  // 每条短链保留多少个历史版本，0 表示不留
  historyKeep: 20,
  // 通知去重窗口（小时）：同一渠道、同一事件、同一主体在这个窗口内只推一次。
  // 0 表示不去重。死链会在每轮巡检里被再判一次，不去重就等于定时骚扰
  notifyDedupeHours: 6,
  // 「即将到期」提前多少天推通知。默认 3 天：7 天对短活动链接太早，
  // 推到手机上等于噪音；等到最后一天又来不及补物料
  notifyExpireDays: 3,
  // 允许把通知推到内网地址。默认关：接收端地址是管理员填的，
  // 但一个填错的地址不该让本站变成探测内网的跳板；自建接收端再明确打开
  notifyAllowPrivate: false,
};

const ENV_MAP = {
  HIGHLURL_SITE_NAME: 'siteName',
  HIGHURL_SITE_NAME: 'siteName',
  HIGHURL_BASE_URL: 'baseUrl',
  HIGHURL_PORT: 'port',
  HIGHURL_HOST: 'host',
  HIGHURL_DATA_DIR: 'dataDir',
  HIGHURL_TRUST_PROXY: 'trustProxy',
  HIGHURL_RATE_LIMIT: 'rateLimitPerMinute',
};

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

export function resolveDataDir(explicit) {
  const dir =
    explicit ||
    process.env.HIGHURL_DATA_DIR ||
    process.env.DATA_DIR ||
    (fs.existsSync('/data') && fs.statSync('/data').isDirectory() ? '/data' : path.join(ROOT, 'data'));
  fs.mkdirSync(dir, { recursive: true });
  return path.resolve(dir);
}

export function loadConfig(rawOverrides = {}) {
  // 过滤 undefined，避免 CLI 可选参数把默认值覆盖成空
  const overrides = {};
  for (const [k, v] of Object.entries(rawOverrides)) {
    if (v !== undefined && v !== null && v !== '') overrides[k] = v;
  }
  const dataDir = resolveDataDir(overrides.dataDir);
  const cfg = {
    dataDir,
    dbFile: path.join(dataDir, 'highurl.db'),
    backupDir: path.join(dataDir, 'backups'),
    host: overrides.host || process.env.HIGHURL_HOST || process.env.HOST || '0.0.0.0',
    port: Number(overrides.port || process.env.HIGHURL_PORT || process.env.PORT || 8080),
    trustProxy: overrides.trustProxy ?? toBool(process.env.HIGHURL_TRUST_PROXY, false),
    maxBodyBytes: Number(overrides.maxBodyBytes || process.env.HIGHURL_MAX_BODY || 1024 * 1024),
    hostname: os.hostname(),
    ...DEFAULTS,
    ...overrides,
  };
  for (const [envKey, key] of Object.entries(ENV_MAP)) {
    if (process.env[envKey] !== undefined && overrides[key] === undefined) {
      if (key === 'trustProxy') cfg[key] = toBool(process.env[envKey], cfg[key]);
      else if (key === 'port') cfg[key] = Number(process.env[envKey]);
      else cfg[key] = process.env[envKey];
    }
  }
  cfg.backupDir = path.join(dataDir, 'backups');
  return cfg;
}

export function secretFile(dataDir) {
  return path.join(dataDir, '.secret');
}

export function ensureSecret(dataDir) {
  const file = secretFile(dataDir);
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    if (value.length >= 32) return value;
  } catch {
    /* 生成新密钥 */
  }
  const secret = randomId(32);
  fs.writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  return secret;
}

export { DEFAULTS };
