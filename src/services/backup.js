import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ROOT, sha256 } from '../lib/util.js';
import { SCHEMA_VERSION } from '../lib/db.js';

/**
 * 备份文件的完整性校验。
 *
 * 之前恢复前只能看到「短链 8 条、分组 2 个」，看不到这份文件是哪台机器、
 * 什么版本导的、有没有被截断。SMB 断线、网盘同步冲突、编辑器顺手保存，
 * 任何一件都能让备份悄悄缺半截——而合并恢复照样会「成功」，把一半数据
 * 写进去，另一半保持原样。所以导出时算一次校验和，恢复前先核对。
 *
 * 校验覆盖业务数据，不覆盖 settings 里的端口这类本机配置——它们本来就
 * 默认不恢复，把它们算进去只会让「换机器」这个正常操作变得可疑。
 */

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
export const APP_VERSION = String(pkg.version || '0.0.0');

/**
 * 参与校验的集合，顺序固定，缺哪个都算差异。
 *
 * 这份名单就是校验和的「契约」，**不要往里加东西**：加一项，之前导出的备份
 * 全部会变成「校验不通过」，把好好的备份判成损坏，比少校验一类数据糟得多。
 * 新增的集合走 EXTRA，只在 manifest 里也带了对应摘要时才校验。
 */
const CHECKED = [
  'groups', 'links', 'link_targets', 'click_daily', 'click_refs', 'click_agents', 'click_countries', 'ua_rules', 'settings',
];

/** 后加的集合：老备份没有，不参与主校验和，单独算一份摘要 */
const EXTRA = ['click_slots', 'link_history', 'landing_views', 'reports'];

export const FORMAT = 'highurl-backup';

/**
 * 对业务集合算摘要。
 *
 * 用行本身的 JSON 参与计算即可：导出时行序来自 SQL 的固定 ORDER BY / 主键顺序，
 * 同一次导出的两次计算结果必然一致。这里不追求「内容不变顺序变也对得上」——
 * 备份是快照，不是集合。
 */
export function checksumOf(data) {
  const parts = CHECKED.map((name) => {
    const rows = Array.isArray(data?.[name]) ? data[name] : [];
    return `${name}:${rows.length}:${sha256(JSON.stringify(rows))}`;
  });
  return sha256(parts.join('|'));
}

/**
 * 后加集合的摘要。
 *
 * 只算「文件里确实带了这一项」的集合：EXTRA 每加一项，之前导出的备份就少一个
 * 键，强行算成 0 条会让所有老备份一次性变成「校验不通过」——把好好的备份
 * 判成损坏，比少校验一类数据糟得多。所以名单可以长，老文件按它自己带的算。
 */
export function extraKeysOf(data) {
  return EXTRA.filter((name) => Object.prototype.hasOwnProperty.call(data || {}, name));
}

export function checksumExtraOf(data) {
  const parts = extraKeysOf(data).map((name) => {
    const rows = Array.isArray(data[name]) ? data[name] : [];
    return `${name}:${rows.length}:${sha256(JSON.stringify(rows))}`;
  });
  return sha256(parts.join('|'));
}

export function countsOf(data) {
  const out = {};
  for (const name of [...CHECKED, ...EXTRA]) out[name] = Array.isArray(data?.[name]) ? data[name].length : 0;
  return out;
}

/**
 * 导出：把 store.exportAll() 的结果包上一层 manifest。
 *
 * 顶层仍保留 version / exportedAt，早期版本的程序读得懂；
 * manifest 是新增的，老程序会忽略它，新程序优先读它。
 */
export function buildBackup(store, { hostname = os.hostname() } = {}) {
  const data = store.exportAll();
  const exportedAt = new Date().toISOString();
  const counts = countsOf(data);
  return {
    ...data,
    format: FORMAT,
    // 顶层保留 version / exportedAt：老版本程序不认 manifest，但认得这两个字段
    version: data.version,
    exportedAt,
    manifest: {
      app: 'HighURL',
      appVersion: APP_VERSION,
      schemaVersion: SCHEMA_VERSION,
      exportedAt,
      hostname: String(hostname || '').slice(0, 120),
      counts,
      checksum: checksumOf(data),
      extraChecksum: checksumExtraOf(data),
      // 记下这份文件到底带了哪些「后加集合」：备份被截断时少掉一整项，
      // 光比对摘要值会算成「两边都没有」而显得一致，得先比键集合
      extraKeys: extraKeysOf(data),
      algorithm: 'sha256',
    },
  };
}

/**
 * 校验一份备份。
 *
 * 三种结论，别混成两种：
 * - `ok`     校验和对得上
 * - `mismatch` 有 checksum 但对不上：文件被改过或缺了内容，恢复前必须拦一下
 * - `legacy`  没有 checksum：早期版本的备份，只能按结构判断，不能假装验过
 */
export function verifyBackup(raw) {
  const data = typeof raw === 'string' ? parse(raw) : raw;
  if (!data || typeof data !== 'object' || !Array.isArray(data.links)) {
    return { status: 'invalid', reason: '不是有效的 HighURL 备份文件' };
  }
  const manifest = data.manifest && typeof data.manifest === 'object' ? data.manifest : null;
  const counts = countsOf(data);
  const actual = checksumOf(data);
  if (!manifest?.checksum) {
    return {
      status: 'legacy',
      reason: '这份备份早于校验和功能，无法确认是否完整',
      actual,
      counts,
      version: data.version ?? null,
      exportedAt: data.exportedAt ?? null,
    };
  }
  // 老备份没有 extraChecksum，跳过而非判失败——它确实没这一项可核对
  const expectedExtra = manifest.extraChecksum ? String(manifest.extraChecksum) : '';
  // 键集合先比一遍：老备份没有 extraKeys（这一项本身也是后加的），跳过；
  // 有的话，manifest 声明过、文件里却整块不见，就是被截断了
  const declaredExtra = Array.isArray(manifest.extraKeys) ? manifest.extraKeys.filter((k) => EXTRA.includes(k)) : null;
  const presentExtra = extraKeysOf(data);
  const missingExtra = declaredExtra ? declaredExtra.filter((k) => !presentExtra.includes(k)) : [];
  const extraOk = missingExtra.length === 0 && (!expectedExtra || expectedExtra === checksumExtraOf(data));
  const expected = String(manifest.checksum);
  if (expected !== actual || !extraOk) {
    // 能说清差在哪儿就比「校验失败」有用得多
    const changed = [...CHECKED, ...(expectedExtra ? presentExtra : [])]
      .filter((name) => Number(manifest.counts?.[name] ?? -1) !== counts[name]);
    return {
      status: 'mismatch',
      reason: changed.length
        ? `内容与 manifest 不一致（${changed.map((n) => `${n} ${manifest.counts?.[n] ?? '?'}→${counts[n]}`).join('，')}）`
        : missingExtra.length
          ? `备份缺少 ${missingExtra.join('、')} 整块内容，文件可能被截断`
          : expectedExtra && !extraOk
          ? '新集合的校验和对不上，文件可能被截断或修改过'
          : 'checksum 不匹配，文件可能被截断或修改过',
      expected,
      actual,
      counts,
      manifest,
      version: data.version ?? null,
      exportedAt: data.exportedAt ?? null,
    };
  }
  return { status: 'ok', reason: '', expected, actual, counts, manifest, version: data.version ?? null, exportedAt: data.exportedAt ?? null };
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 列出数据目录里的自动备份。
 *
 * 只读目录，不碰数据库。每份文件都算一次校验和——一次十几份、每份几 MB，
 * 放在点开页面的那一下可以接受；真正的风险是「看着有文件、其实早坏了」，
 * 让界面上直接显示状态比事后翻日志有用。按 名字+mtime 缓存，重复点开不重复算。
 */
const verifyCache = new Map();

/** 自动备份保留份数，导出给界面显示，别在两处各写一遍数字 */
export const KEEP_AUTO_BACKUPS = 14;

export function listBackups(dir, { limit = 50 } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => /^highurl-.*\.(json|sql\.gz)$/.test(f));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.sort().reverse().slice(0, limit)) {
    const file = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    const entry = { name, size: stat.size, mtime: stat.mtimeMs, integrity: null, counts: null, appVersion: null, hostname: null };
    if (name.endsWith('.json') && stat.size <= 64 * 1024 * 1024) {
      const key = `${name}:${stat.mtimeMs}`;
      let cached = verifyCache.get(key);
      if (!cached) {
        try {
          const v = verifyBackup(fs.readFileSync(file, 'utf8'));
          cached = { status: v.status, counts: v.counts, appVersion: v.manifest?.appVersion ?? null, hostname: v.manifest?.hostname ?? null };
        } catch (err) {
          cached = { status: 'invalid', reason: err.message, counts: null };
        }
        if (verifyCache.size > 200) verifyCache.clear();
        verifyCache.set(key, cached);
      }
      entry.integrity = cached.status;
      entry.counts = cached.counts;
      entry.appVersion = cached.appVersion;
      entry.hostname = cached.hostname;
    }
    out.push(entry);
  }
  return out;
}

/** 备份文件名白名单校验：这个参数直接决定读哪个文件，不能靠调用方自觉 */
export function backupPath(dir, name) {
  const base = path.basename(String(name || ''));
  if (!/^highurl-[\w.-]+\.(json|sql\.gz)$/.test(base)) return null;
  const file = path.join(dir, base);
  return fs.existsSync(file) ? file : null;
}
