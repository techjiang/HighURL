#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer, createLogger } from './server.js';
import { loadConfig, resolveDataDir, ensureSecret } from './config.js';
import { openDatabase } from './lib/db.js';
import { Settings } from './services/settings.js';
import { AuthService } from './services/auth.js';

const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));

const HELP = `HighURL ${pkg.version} · 高性能自托管短链接系统

用法:
  highurl serve [选项]      启动服务
  highurl init [选项]        初始化管理员账号（非交互为命令行参数）
  highurl backup <文件>      导出 JSON 备份（带校验和）
  highurl verify <文件>      校验备份完整性，不写任何数据
  highurl restore <文件>     从 JSON 备份恢复 [--replace --yes] [--dry-run] [--force]
  highurl migrate <文件>     导入 YOURLS dump / HighURL 备份 / CSV
  highurl stats              查看统计
  highurl expiring [--days 7] 列出即将到期的短链
  highurl admin [list]       账号列表
  highurl admin add --username x --password y [--role owner|viewer]
  highurl admin reset --username x --password y   重置密码（忘密码时的救生门）
  highurl admin role --username x --role viewer
  highurl doctor             自检运行环境

通用选项:
  -p, --port <端口>          监听端口（默认 8080）
  -h, --host <地址>          监听地址（默认 0.0.0.0）
  -d, --data <目录>          数据目录（默认 ./data）
      --trust-proxy          信任 X-Forwarded-* 头

示例:
  highurl serve --port 8080 --data /var/lib/highurl
  highurl init --username admin --password 's3cret-pass'
  highurl migrate yourls.sql
  highurl admin add --username ops --password 's3cret-pass' --role viewer
`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=');
      const next = argv[i + 1];
      if (inline !== undefined) out[key] = inline;
      else if (next && !next.startsWith('-')) {
        out[key] = next;
        i += 1;
      } else out[key] = true;
    } else if (arg.startsWith('-') && arg.length > 1) {
      const key = { p: 'port', h: 'host', d: 'data' }[arg.slice(1)] || arg.slice(1);
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        out[key] = next;
        i += 1;
      } else out[key] = true;
    } else {
      out._.push(arg);
    }
  }
  return out;
}

function optionsFrom(args) {
  return {
    port: args.port,
    host: args.host,
    dataDir: args.data,
    trustProxy: args['trust-proxy'] ? true : undefined,
  };
}

async function cmdServe(args) {
  const server = await createServer(optionsFrom(args));
  const { config, ctx, logger } = server;
  const addr = await new Promise((resolve) => {
    server.server.listen(config.port, config.host, () => resolve(server.server.address()));
  });
  const shown = config.host === '0.0.0.0' ? os.hostname() : config.host;
  const base = config.baseUrl || `http://${shown}:${addr.port}`;
  logger.info(`HighURL ${pkg.version} 已启动 → ${base}`);
  logger.info(`数据目录 ${config.dataDir}`);
  if (!ctx.auth.hasAdmin()) logger.warn('尚未初始化管理员，请打开 /install 创建账号');

  const shutdown = async (signal) => {
    logger.info(`收到 ${signal}，正在处理缓存的点击计数…`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => logger.error('未捕获异常', err));
  process.on('unhandledRejection', (err) => logger.error('未处理的 Promise 拒绝', err));
}

function openContext(args) {
  const config = loadConfig(optionsFrom(args));
  const store = openDatabase(config.dbFile);
  const secret = ensureSecret(config.dataDir);
  const settings = new Settings(store, config);
  return { config, store, secret, settings, auth: new AuthService({ store, secret }) };
}

async function cmdInit(args) {
  const ctx = openContext(args);
  if (ctx.auth.hasAdmin()) {
    console.error('已存在管理员账号，跳过初始化');
    process.exitCode = 1;
    return;
  }
  const username = args.username || 'admin';
  const password = args.password || process.env.HIGHURL_PASSWORD;
  if (!password) {
    console.error('请通过 --password 或环境变量 HIGHURL_PASSWORD 提供密码（至少 8 位）');
    process.exitCode = 1;
    return;
  }
  ctx.auth.createAdmin(username, password);
  if (args.site) ctx.settings.update({ siteName: args.site });
  if (args['base-url']) ctx.settings.update({ baseUrl: args['base-url'] });
  console.log(`已创建管理员 ${username}，数据目录 ${ctx.config.dataDir}`);
  ctx.store.close();
}

async function cmdBackup(args) {
  const ctx = openContext(args);
  const { buildBackup } = await import('./services/backup.js');
  const target = args._[0] || path.join(ctx.config.dataDir, `highurl-${new Date().toISOString().slice(0, 10)}.json`);
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  const payload = buildBackup(ctx.store, { hostname: ctx.config.hostname });
  fs.writeFileSync(target, JSON.stringify(payload, null, 2));
  const m = payload.manifest;
  console.log(`备份已写入 ${path.resolve(target)}`);
  console.log(`短链 ${m.counts.links} 条，校验和 ${m.checksum.slice(0, 16)}…（恢复前可用 highurl verify 复核）`);
  ctx.store.close();
}

/**
 * 只校验不写数据。备份有没有被截断，是恢复前唯一值得单独问一句的事。
 */
async function cmdVerify(args) {
  const file = args._[0];
  if (!file) {
    console.error('请指定备份文件');
    process.exitCode = 1;
    return;
  }
  const { verifyBackup } = await import('./services/backup.js');
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`读不到备份文件：${err.message}`);
    process.exitCode = 1;
    return;
  }
  const v = verifyBackup(content);
  if (v.status === 'invalid') {
    console.error(`✗ ${v.reason}`);
    process.exitCode = 1;
    return;
  }
  const when = v.exportedAt ? v.exportedAt.replace('T', ' ').slice(0, 19) : '未知时间';
  const from = v.manifest?.hostname ? `${v.manifest.hostname} · HighURL ${v.manifest.appVersion ?? '?'}` : '早期版本备份（无来源信息）';
  const c = v.counts;
  console.log(`${file}`);
  console.log(`  来源 ${from}`);
  console.log(`  导出 ${when} · 库版本 v${v.version ?? '?'}`);
  console.log(`  内容 短链 ${c.links}，分组 ${c.groups}，分流目标 ${c.link_targets}，统计 ${c.click_daily + c.click_refs + c.click_agents + c.click_countries}，规则 ${c.ua_rules}`);
  if (v.status === 'ok') {
    console.log(`✓ 完整性校验通过（sha256 ${v.actual.slice(0, 16)}…）`);
  } else if (v.status === 'mismatch') {
    console.error(`✗ ${v.reason}`);
    console.error(`  期望 ${v.expected.slice(0, 16)}… 实际 ${v.actual.slice(0, 16)}…`);
    process.exitCode = 1;
  } else {
    console.log('! 这份备份没有校验和（早于该功能），只能确认结构完整，无法确认内容一致');
  }
}

async function cmdRestore(args) {
  const ctx = openContext(args);
  const file = args._[0];
  if (!file) {
    console.error('请指定备份文件');
    process.exitCode = 1;
    return;
  }
  const { inspectBackup, restoreBackup } = await import('./services/restore.js');
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`读不到备份文件：${err.message}`);
    process.exitCode = 1;
    return;
  }
  let plan;
  try {
    plan = inspectBackup(content, ctx.store);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  if (plan.integrity.status === 'mismatch') {
    console.error(`备份完整性校验未通过：${plan.integrity.reason}`);
    if (!args.force) {
      console.error('确认要用这份文件，请加 --force（先跑 highurl verify 看一眼更稳）');
      process.exitCode = 1;
      ctx.store.close();
      return;
    }
    console.error('--force 已指定，继续恢复');
  }
  if (args['dry-run']) {
    console.log(`备份 v${plan.version ?? '?'}（${plan.exportedAt || '未知时间'}）· 完整性 ${plan.integrity.status}`);
    console.log(`短链 ${plan.links.total} 条：新增 ${plan.links.create}，覆盖 ${plan.links.overwrite}，跳过 ${plan.links.skipped}`);
    console.log(`分组 ${plan.counts.groups}，分流目标 ${plan.counts.link_targets}，明细统计 ${plan.counts.click_daily + plan.counts.click_refs + plan.counts.click_agents + plan.counts.click_countries}，屏蔽规则 ${plan.rules}`);
    ctx.store.close();
    return;
  }
  const replace = Boolean(args.replace);
  if (replace && args.yes !== true) {
    console.error('替换模式会清空现有短链与统计。确认要这么做，请加 --yes');
    process.exitCode = 1;
    ctx.store.close();
    return;
  }
  // 走和后台同一套恢复实现：两边各写一遍的结果就是互相漏字段
  const out = restoreBackup(ctx.store, content, {
    mode: replace ? 'replace' : 'merge',
    withSettings: Boolean(args['with-settings']),
    force: Boolean(args.force),
  });
  console.log(`已恢复 ${out.restored} 条短链${replace ? '（替换模式）' : ''}，分组 ${out.groups}，分流目标 ${out.targets}`
    + `${out.skipped ? `，跳过 ${out.skipped} 条非法记录` : ''}`);
  ctx.store.close();
}

async function cmdMigrate(args) {
  const ctx = openContext(args);
  const file = args._[0];
  if (!file) {
    console.error('请指定要导入的文件（YOURLS .sql 或 HighURL .json）');
    process.exitCode = 1;
    return;
  }
  const { detectFormat, parseByFormat, planImport, applyImport } = await import('./services/migrate.js');
  const content = fs.readFileSync(file, 'utf8');
  const format = detectFormat(content, file);
  if (format === 'unknown') {
    console.error('无法识别文件格式');
    process.exitCode = 1;
    return;
  }
  const parsed = parseByFormat(format, content);
  const plan = planImport(ctx.store, parsed, { overwrite: Boolean(args.overwrite) });
  const dry = Boolean(args['dry-run']);
  if (dry) {
    console.log(`格式 ${format}，可导入 ${plan.import.length}，冲突 ${plan.conflict.length}，无效 ${plan.invalid.length}`);
    ctx.store.close();
    return;
  }
  const stats = applyImport(ctx.store, plan);
  console.log(`导入完成：新增 ${stats.created}，更新 ${stats.updated}，冲突 ${plan.conflict.length}，无效 ${plan.invalid.length}`);
  ctx.store.close();
}

async function cmdStats(args) {
  const ctx = openContext(args);
  const rows = ctx.store.db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(clicks),0) AS clicks FROM links WHERE deleted_at IS NULL').get();
  const top = ctx.store.db.prepare('SELECT code, clicks FROM links WHERE deleted_at IS NULL ORDER BY clicks DESC LIMIT 5').all();
  const trash = ctx.store.sql.countDeleted.get().n;
  console.log(`短链 ${rows.total} 条，累计点击 ${rows.clicks} 次${trash ? `（回收站 ${trash} 条）` : ''}`);
  for (const row of top) console.log(`  /${row.code}  ${row.clicks}`);
  const orphans = ['click_daily', 'click_refs', 'click_agents']
    .map((t) => ctx.store.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE code NOT IN (SELECT code FROM links)`).get().n)
    .reduce((a, b) => a + b, 0);
  if (orphans) console.log(`另有 ${orphans} 行失去归属的统计（用 --collect-orphans 清理）`);
  if (args['collect-orphans']) {
    let removed = 0;
    ctx.store.tx(() => {
      removed += ctx.store.sql.purgeOrphanDaily.run().changes || 0;
      removed += ctx.store.sql.purgeOrphanRefs.run().changes || 0;
      removed += ctx.store.sql.purgeOrphanAgents.run().changes || 0;
    });
    console.log(`已清理 ${removed} 行`);
  }
  ctx.store.close();
}

/**
 * 列出即将到期的短链。
 *
 * 命令行版本存在的理由很实际：真正需要提前处理的场景是「一批物料还没发出去，
 * 先确认里面没有明天就失效的链」，那时候人在 CI 或终端里，不在管理台。
 * 输出用制表符分隔，脚本直接可切；带 --code-only 就只吐短码，方便接批量续期。
 */
async function cmdExpiring(args) {
  const ctx = openContext(args);
  const days = Math.max(1, Math.min(365, Number(args.days) || 7));
  const { rows } = ctx.store.expiringLinks({ days, limit: Math.max(1, Number(args.limit) || 200) });
  const now = Date.now();
  if (args['code-only']) {
    for (const row of rows) console.log(row.code);
  } else if (!rows.length) {
    console.log(`未来 ${days} 天没有到期的短链`);
  } else {
    console.log(`未来 ${days} 天有 ${rows.length} 条短链到期：`);
    for (const row of rows) {
      const left = Math.max(0, Math.ceil((row.expire_at - now) / 86400000));
      console.log(`  /${row.code}\t${left} 天后\t${new Date(row.expire_at).toISOString().slice(0, 10)}\t${row.title || row.url}`);
    }
    console.log('\n续期：highurl expiring --code-only | xargs …（或在管理台短链页批量续期）');
  }
  ctx.store.close();
}

async function cmdDoctor(args) {
  const checks = [];
  const add = (ok, label, detail = '') => checks.push({ ok, label, detail });
  add(Number(process.versions.node.split('.')[0]) >= 22, 'Node.js 版本', process.version);
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t(a)');
    db.close();
    add(true, 'node:sqlite 可用', '内置 SQLite 正常');
  } catch (err) {
    add(false, 'node:sqlite 可用', err.message);
  }
  const dataDir = resolveDataDir(args.data);
  try {
    fs.accessSync(dataDir, fs.constants.W_OK);
    add(true, '数据目录可写', dataDir);
  } catch (err) {
    add(false, '数据目录可写', err.message);
  }
  try {
    const probe = path.join(dataDir, `.probe-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    add(true, '文件系统', '可读写');
  } catch (err) {
    add(false, '文件系统', err.message);
  }
  add(typeof fetch === 'function', 'fetch 可用', '用于标题抓取校验');
  add(os.cpus().length >= 1, 'CPU', `${os.cpus().length} 核 · ${(os.totalmem() / 1e9).toFixed(1)} GB 内存`);
  let failed = 0;
  for (const c of checks) {
    if (!c.ok) failed += 1;
    console.log(`${c.ok ? '✓' : '✗'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  if (failed) {
    console.error(`\n${failed} 项检查未通过`);
    process.exitCode = 1;
  } else {
    console.log('\n一切就绪，可以运行 highurl serve');
  }
}

const [, , command, ...rest] = process.argv;
const args = parseArgs(rest);

/**
 * 账号管理。命令行必须留一条路：把最后一个 owner 停用/降级之后，
 * 管理台上就没人能进「账号」页了，只能回来改数据库——那是最不该发生的事。
 * 这里不做「最后一个 owner」这类保护，反而要能强行重置：它本来就是最后的救生门。
 */
async function cmdAdmin(args) {
  const ctx = openContext(args);
  const sub = String(args._?.[0] || args.action || 'list');
  const auth = ctx.auth;
  if (sub === 'list' || args.list) {
    for (const row of auth.listAdmins()) {
      console.log(`${row.username}\t${row.role}\t${row.disabled ? '已停用' : '启用'}${row.last_login_at ? `\t最近登录 ${new Date(row.last_login_at).toISOString().slice(0, 19).replace('T', ' ')}` : ''}`);
    }
  } else if (sub === 'add') {
    if (!args.username || !args.password) throw new Error('用法：highurl admin add --username x --password y [--role owner|viewer]');
    const created = auth.createAdmin(args.username, args.password, { role: args.role || 'viewer', createdBy: 'cli' });
    console.log(`已创建 ${created.username}（${created.role}）`);
  } else if (sub === 'reset') {
    if (!args.username || !args.password) throw new Error('用法：highurl admin reset --username x --password y');
    const row = ctx.store.sql.getAdmin.get(String(args.username).trim());
    if (!row) throw new Error(`账号不存在：${args.username}`);
    auth.changePassword(row.id, '', args.password, { reset: true, actor: 'cli' });
    console.log(`已重置 ${row.username} 的密码`);
  } else if (sub === 'role') {
    const row = ctx.store.sql.getAdmin.get(String(args.username || '').trim());
    if (!row) throw new Error(`账号不存在：${args.username}`);
    const out = auth.setRole(row.id, args.role || 'viewer', 'cli');
    console.log(`${out.username} 现在是 ${out.role}`);
  } else {
    throw new Error(`未知子命令：${sub}（可用：list / add / reset / role）`);
  }
  ctx.store.close();
}

const commands = {
  serve: cmdServe,
  init: cmdInit,
  admin: cmdAdmin,
  backup: cmdBackup,
  verify: cmdVerify,
  restore: cmdRestore,
  migrate: cmdMigrate,
  stats: cmdStats,
  expiring: cmdExpiring,
  doctor: cmdDoctor,
};

const runner = commands[command];
if (!command || args.help || command === 'help') {
  console.log(HELP);
} else if (!runner) {
  console.error(`未知命令：${command}\n`);
  console.log(HELP);
  process.exitCode = 1;
} else {
  runner(args).catch((err) => {
    // CLI 的错误走 stderr，方便脚本判断
    process.stderr.write(`${err?.message || err}\n`);
    if (process.env.HIGHURL_LOG_LEVEL === 'debug') process.stderr.write(`${err?.stack || ''}\n`);
    process.exitCode = 1;
  });
}
