import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { dateKey } from './util.js';

const MIGRATIONS = [
  function v1(db) {
    db.exec(`
      CREATE TABLE links (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        code        TEXT    NOT NULL UNIQUE,
        url         TEXT    NOT NULL,
        title       TEXT    NOT NULL DEFAULT '',
        note        TEXT    NOT NULL DEFAULT '',
        tags        TEXT    NOT NULL DEFAULT '',
        status      TEXT    NOT NULL DEFAULT 'active',
        password    TEXT,
        clicks      INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        last_click_at INTEGER,
        expire_at   INTEGER
      );
      CREATE INDEX idx_links_created ON links(created_at DESC);
      CREATE INDEX idx_links_clicks ON links(clicks DESC);
      CREATE TABLE click_daily (
        code   TEXT    NOT NULL,
        day    TEXT    NOT NULL,
        clicks INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (code, day)
      ) WITHOUT ROWID;
      CREATE TABLE click_refs (
        code   TEXT    NOT NULL,
        host   TEXT    NOT NULL,
        clicks INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (code, host)
      ) WITHOUT ROWID;
      CREATE TABLE click_agents (
        code     TEXT    NOT NULL,
        platform TEXT    NOT NULL,
        clicks   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (code, platform)
      ) WITHOUT ROWID;
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE admins (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        last_login_at INTEGER
      );
      CREATE TABLE api_keys (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        prefix     TEXT NOT NULL,
        hash       TEXT NOT NULL UNIQUE,
        scope      TEXT NOT NULL DEFAULT 'read,write',
        enabled    INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
      CREATE TABLE ua_rules (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        kind       TEXT NOT NULL DEFAULT 'ua',
        pattern    TEXT NOT NULL,
        note       TEXT NOT NULL DEFAULT '',
        hits       INTEGER NOT NULL DEFAULT 0,
        enabled    INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE audit_log (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        at     INTEGER NOT NULL,
        actor  TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX idx_audit_at ON audit_log(at DESC);
    `);
  },

  // v2：短链分组 + 软删除（回收站）
  function v2(db) {
    db.exec(`
      CREATE TABLE groups (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
        color      TEXT    NOT NULL DEFAULT '',
        note       TEXT    NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      ALTER TABLE links ADD COLUMN group_id INTEGER;
      ALTER TABLE links ADD COLUMN deleted_at INTEGER;
      CREATE INDEX idx_links_group ON links(group_id);
      CREATE INDEX idx_links_deleted ON links(deleted_at);
    `);
  },

  /**
   * v3：把「短码不区分大小写」这条业务规则下沉到数据库。
   *
   * 之前唯一约束只在 BINARY 层面成立，而应用层判重用的是 NOCASE：
   * 单条新建被挡住了，但批量路径（YOURLS 导入、备份恢复）直接拼 INSERT，
   * 于是库里能同时存在 /abc 和 /ABC 两条记录——访问 /ABC 跳一个、/abc 跳另一个，
   * 点击数还被拆成两份。这里先收敛已有冲突，再加 NOCASE 唯一索引兜住以后。
   */
  function v3(db) {
    const dupes = db
      .prepare('SELECT code FROM links GROUP BY code COLLATE NOCASE HAVING COUNT(*) > 1')
      .all();
    const taken = new Set(db.prepare('SELECT code FROM links').all().map((r) => String(r.code).toLowerCase()));
    const renames = [];
    for (const { code } of dupes) {
      // 保留最早创建的那条（先到先得，也是当初印在物料上的拼写），其余改名保数据
      const rows = db
        .prepare('SELECT id, code, clicks FROM links WHERE code = ? COLLATE NOCASE ORDER BY created_at ASC, id ASC')
        .all(code);
      const keep = rows.shift();
      for (const row of rows) {
        let suffix = 2;
        let candidate;
        do {
          const tail = `-${suffix}`;
          candidate = `${String(row.code).slice(0, 64 - tail.length)}${tail}`;
          suffix += 1;
        } while (taken.has(candidate.toLowerCase()));
        taken.add(candidate.toLowerCase());
        db.prepare('UPDATE links SET code = ? WHERE id = ?').run(candidate, row.id);
        // 统计表也按短码存，改名要一起跟着走，否则点击数成了孤儿数据。
        // 这些表都是 WITHOUT ROWID + (code, key) 主键，直接 UPDATE 可能撞键，
        // 所以先合并进目标短码再删旧行。
        for (const [table, key] of [['click_daily', 'day'], ['click_refs', 'host'], ['click_agents', 'platform']]) {
          db.prepare(`INSERT INTO ${table} (code, ${key}, clicks) SELECT ?, ${key}, clicks FROM ${table} WHERE code = ?
            ON CONFLICT(code, ${key}) DO UPDATE SET clicks = clicks + excluded.clicks`).run(candidate, row.code);
          db.prepare(`DELETE FROM ${table} WHERE code = ?`).run(row.code);
        }
        renames.push(`${row.code}->${candidate}`);
      }
      void keep;
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_links_code_nocase ON links(code COLLATE NOCASE)');
    if (renames.length) {
      const at = Date.now();
      const stmt = db.prepare('INSERT INTO audit_log (at, actor, action, detail) VALUES (?, ?, ?, ?)');
      stmt.run(at, 'system', 'link.code_dedupe', renames.join(', ').slice(0, 500));
    }
  },

  /**
   * v4：目标链接健康巡检。
   *
   * 短链的寿命比目标链接长得多——站点改版、换域名、下线页面，
   * 短链还在物料上印着，但点过去已经是 404 了。这里把每次探测的结论落到线上，
   * 列表里就能一眼看出哪条已经死掉。
   *
   * health_status 用空串表示「还没检测过」，与 'ok' 区分开：
   * 没测过和测过没问题，是两件事。
   */
  function v4(db) {
    // 逐列加，缺哪列补哪列：ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS，
    // 手工修过库或者迁移中途被打断时，重跑不能直接撞「duplicate column」。
    const existing = new Set(db.prepare('PRAGMA table_info(links)').all().map((c) => c.name));
    const columns = [
      ["health_status", "TEXT NOT NULL DEFAULT ''"],
      ['health_code', 'INTEGER'],
      ['health_at', 'INTEGER'],
      ['health_ms', 'INTEGER'],
      ["health_error", "TEXT NOT NULL DEFAULT ''"],
      ['health_miss', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [name, type] of columns) {
      if (!existing.has(name)) db.exec(`ALTER TABLE links ADD COLUMN ${name} ${type}`);
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_links_health ON links(health_status)');
  },
  /**
   * v5：一个短码对应多个目标地址（A/B 分流 + 按地域跳转）。
   *
   * 关键取舍是**不动 links.url**。它仍然是「默认目标」，被二维码、CSV、
   * 拼版打印、备份恢复、YOURLS 导入、健康巡检一大堆地方依赖着；
   * 把多目标塞进 links 表等于让每一处都要改一遍。这里只加一张从表，
   * 没有目标时行为与以前完全一致。
   *
   * clicks 记在目标上：只改权重不看结果，A/B 就只是一种装饰。
   */
  function v5(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS link_targets (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        link_id    INTEGER NOT NULL,
        url        TEXT    NOT NULL,
        label      TEXT    NOT NULL DEFAULT '',
        weight     INTEGER NOT NULL DEFAULT 100,
        regions    TEXT    NOT NULL DEFAULT '',
        enabled    INTEGER NOT NULL DEFAULT 1,
        clicks     INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        health_status TEXT NOT NULL DEFAULT '',
        health_code   INTEGER,
        health_at     INTEGER,
        health_ms     INTEGER,
        health_error  TEXT NOT NULL DEFAULT '',
        health_miss   INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_targets_link ON link_targets(link_id);
      CREATE TABLE IF NOT EXISTS click_countries (
        code    TEXT    NOT NULL,
        country TEXT    NOT NULL,
        clicks  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (code, country)
      ) WITHOUT ROWID;
    `);
  },

  /**
   * v6：访问时段分布（星期 × 小时）。
   *
   * 已有 click_daily 只按天存，回答不了「这批物料在哪些时段真的有人点」——
   * 而发推送、投放广告、安排值班都要看这个。粒度选「星期几 × 小时」：
   * 24 条只够看一天，7×24 才能看出工作日与周末的差别，168 个桶也小到可以随便存。
   *
   * 历史数据补不回来：升级前没有记过小时，这里不从 click_daily 猜。
   * 表里没有的桶就是没有点击，界面上要能区分「没数据」和「这个时段确实没人点」。
   */
  function v6(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS click_slots (
        code   TEXT    NOT NULL,
        dow    INTEGER NOT NULL,
        hour   INTEGER NOT NULL,
        clicks INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (code, dow, hour)
      ) WITHOUT ROWID;
    `);
  },
  /**
   * v7：短链变更历史。
   *
   * 「我刚才是不是把这个链接的目标地址改错了」是真实会发生的事，
   * 而审计日志只记了「谁改了哪条」，没有记「改之前是什么」——
   * 想改回去只能靠记忆。这里每次变更前存一份快照，可以逐版本回滚。
   *
   * 快照存 JSON 字符串而不是拆成一张宽表：字段还会长（分流目标、
   * 密码、地区……），拆表就意味着以后每加一个字段都要再迁移一次，
   * 而历史记录本质上是一份「当时的样子」，JSON 正是它本来的形态。
   */
  function v7(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS link_history (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        link_id    INTEGER NOT NULL,
        code       TEXT    NOT NULL,
        action     TEXT    NOT NULL,
        actor      TEXT    NOT NULL DEFAULT '',
        snapshot   TEXT    NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_history_link ON link_history(link_id, id DESC);
    `);
  },
  /**
   * v8：用「自动建页」替代「点短链之前的密码门」，并按短链记住二维码样式。
   *
   * 密码门（link.password）要求访问者先问发起人要口令才能看到目标地址，
   * 这在内部小范围分享里还行，一旦贴到海报、推文、群里，多一步就是一半人走掉。
   * 更好的做法是**先落在一张自动生成的介绍页上**，把目标站点、标题、
   * 剩下的访问时间摆清楚，再让人自己点「继续访问」——安全和转化都不丢。
   *
   * 页面内容是根据短链字段渲染出来的，不存 HTML：存了就等于埋了一份会过期的快照，
   * 改完短链还得记得改页面。这里只存「用不用自动建页」「用不用品牌主题」和一个附加说明。
   *
   * qr_style 同理：二维码样式以前只记在浏览器 localStorage 里，
   * 换台机器、换个浏览器就回到默认黑白——而物料是按那个样式印的。
   * 样式本来就属于这条短链，落库才对得上。
   */
  function v8(db) {
    const existing = new Set(db.prepare('PRAGMA table_info(links)').all().map((c) => c.name));
    const columns = [
      ['interstitial', 'INTEGER NOT NULL DEFAULT 0'],
      ['landing_theme', "TEXT NOT NULL DEFAULT 'auto'"],
      ['interstitial_note', "TEXT NOT NULL DEFAULT ''"],
      ['qr_style', "TEXT NOT NULL DEFAULT ''"],
    ];
    for (const [name, type] of columns) {
      if (!existing.has(name)) db.exec(`ALTER TABLE links ADD COLUMN ${name} ${type}`);
    }
  },
  /**
   * v9：建页按渠道记录「看过了但没走」，以及名片页的举报。
   *
   * v8 的建页页把「目标地址」从 HTML 里拿掉了，于是 click_refs 只剩「真的跳过去」
   * 的那批，看不到中途放弃——而「投放带来的 1000 人里有多少连域名都没确认就走了」
   * 恰恰是投放最该知道的一件事。这里单独记一份建页曝光，和 clicks 分开：
   * 混进点击里会让所有点击数从这一天起不可比。
   *
   * 存表而不是只留内存：内存里的过期数据在管理台一刷新就断了，而渠道归因
   * 至少要能横跨一次投放看一周。量级和 clicks 同级（每个短链每天几十行），
   * 跟着同一个计数器批量落库，跳转热路径依旧不碰磁盘。
   *
   * 举报同样落库：它是「有人对这条链有意见」的唯一凭据，
   * 存在内存里就是重启即忘。
   */
  function v9(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS landing_views (
        code   TEXT    NOT NULL,
        day    TEXT    NOT NULL,
        host   TEXT    NOT NULL DEFAULT '',
        views  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (code, day, host)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS reports (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        code       TEXT    NOT NULL,
        reason     TEXT    NOT NULL DEFAULT '',
        note       TEXT    NOT NULL DEFAULT '',
        ip         TEXT    NOT NULL DEFAULT '',
        ua         TEXT    NOT NULL DEFAULT '',
        status     TEXT    NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL,
        handled_at INTEGER,
        handled_by TEXT    NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, id DESC);
      CREATE INDEX IF NOT EXISTS idx_reports_code ON reports(code);
    `);
  },

  /**
   * v10：记住「过期前本来是什么状态」。
   *
   * 过期回收把链接置成 disabled 之后，信息就丢了：这条是本来就停用的，
   * 还是过期被自动停用的？续期时该恢复成 active 还是保持停用？
   * 没有这个字段，续期只能一律改回 active——那就等于替管理员把一个
   * 他自己关掉的链接又打开了。
   *
   * 另一个用途是「这条其实已经过期，只是状态还没被清扫」的判定：
   * 过期判断原本只看 expire_at，于是关掉策略的站里，过期链接在列表上
   * 依然显示「启用」，点进去 410，两边说法不一致。
   */
  function v10(db) {
    const existing = new Set(db.prepare('PRAGMA table_info(links)').all().map((c) => c.name));
    if (!existing.has('status_before_expire')) {
      db.exec("ALTER TABLE links ADD COLUMN status_before_expire TEXT NOT NULL DEFAULT ''");
    }
    // 续期要找「快到期的」：没有索引时每次筛选都是全表扫，
    // 而短链表本来就不大，一条索引足够
    db.exec('CREATE INDEX IF NOT EXISTS idx_links_expire ON links(expire_at)');
  },

  /**
   * v11：多管理员账号。
   *
   * 原来 admins 只有一张无角色的表，等于「谁拿到密码谁就是超管」。
   * 一个站交给两三个人维护时，这是真问题：实习生要能看数据但不该动备份，
   * 运维要能重启和恢复但不必管内容。
   *
   * role 只有两档，不是一套权限矩阵：
   * - owner：全部能力，含账号管理、备份恢复、系统设置
   * - viewer：只读。能看所有报表和列表，改不了任何东西
   *
   * 不设第三档（比如「编辑」）是因为说不清边界：能改短链的人必然能改目标地址，
   * 而目标地址就是一次跳转指向哪里——这条线画在「能不能写」上最清楚。
   *
   * 另外记 created_by：账号是谁加的。出了事要问人，先得知道问谁。
   */
  function v11(db) {
    const existing = new Set(db.prepare('PRAGMA table_info(admins)').all().map((c) => c.name));
    if (!existing.has('role')) db.exec("ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'owner'");
    if (!existing.has('created_by')) db.exec("ALTER TABLE admins ADD COLUMN created_by TEXT NOT NULL DEFAULT ''");
    if (!existing.has('disabled_at')) db.exec('ALTER TABLE admins ADD COLUMN disabled_at INTEGER');
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDatabase(file) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(file, { allowExtension: false });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec('PRAGMA cache_size = -32000');
  try {
    db.exec('PRAGMA mmap_size = 268435456');
  } catch {
    /* 部分平台不支持 mmap，忽略 */
  }

  migrate(db);
  return new Store(db);
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID');
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get();
  const current = row ? Number(row.value) : 0;
  if (current > SCHEMA_VERSION) {
    throw new Error(`数据库版本 ${current} 高于当前程序支持的 ${SCHEMA_VERSION}，请升级 HighURL`);
  }
  for (let i = current; i < SCHEMA_VERSION; i += 1) {
    db.exec('BEGIN IMMEDIATE');
    try {
      MIGRATIONS[i](db);
      db.prepare("INSERT INTO schema_meta (key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(i + 1));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/**
 * 链接查询的公共列。分组名用相关子查询取，避免每个调用点都要写 JOIN。
 * deleted_at 不为空表示在回收站里，业务查询一律过滤掉。
 */
/** 热度分档：占全库最高点击数的比例下限 */
export const HEAT_BANDS = { hot: 0.6, warm: 0.2 };

const LINK_COLUMNS = `id, code, url, title, note, tags, status, group_id,
  (SELECT name FROM groups WHERE groups.id = links.group_id) AS group_name,
  password IS NOT NULL AS protected,
  clicks, created_at, updated_at, last_click_at, expire_at, deleted_at, status_before_expire,
  health_status, health_code, health_at, health_ms, health_error, health_miss,
  interstitial, landing_theme, interstitial_note, qr_style,
  (SELECT COUNT(*) FROM link_targets WHERE link_targets.link_id = links.id AND link_targets.enabled = 1) AS target_count`;

export class Store {
  constructor(db) {
    this.db = db;
    const prepare = (sql) => db.prepare(sql);
    this.sql = {
      getLinkByCode: prepare(`SELECT ${LINK_COLUMNS} FROM links WHERE code = ? AND deleted_at IS NULL`),
      getLinkByCodeCI: prepare(`SELECT ${LINK_COLUMNS} FROM links WHERE code = ? COLLATE NOCASE AND deleted_at IS NULL`),
      getLinkById: prepare(`SELECT ${LINK_COLUMNS} FROM links WHERE id = ? AND deleted_at IS NULL`),
      // 回收站里的记录也要能按 id / 短码取到，恢复与彻底删除要用
      getLinkByIdAny: prepare(`SELECT ${LINK_COLUMNS} FROM links WHERE id = ?`),
      getLinkByCodeAny: prepare(`SELECT ${LINK_COLUMNS} FROM links WHERE code = ?`),
      getLinkByCodeAnyCI: prepare(`SELECT ${LINK_COLUMNS} FROM links WHERE code = ? COLLATE NOCASE`),
      getPasswordHash: prepare('SELECT password FROM links WHERE code = ? AND deleted_at IS NULL'),
      getPasswordHashCI: prepare('SELECT password FROM links WHERE code = ? COLLATE NOCASE AND deleted_at IS NULL'),
      insertLink: prepare(`INSERT INTO links (code, url, title, note, tags, status, password, created_at, updated_at, expire_at, group_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      deleteLinkById: prepare('DELETE FROM links WHERE id = ?'),
      softDeleteById: prepare('UPDATE links SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL'),
      restoreById: prepare('UPDATE links SET deleted_at = NULL, updated_at = ? WHERE id = ?'),
      listDeleted: prepare(`SELECT ${LINK_COLUMNS} FROM links WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ? OFFSET ?`),
      deleteLinkByCode: prepare('DELETE FROM links WHERE code = ?'),
      purgeLinkStats: prepare('DELETE FROM click_daily WHERE code = ?'),
      purgeLinkRefs: prepare('DELETE FROM click_refs WHERE code = ?'),
      purgeLinkAgents: prepare('DELETE FROM click_agents WHERE code = ?'),
      updateLink: prepare(`UPDATE links SET url = ?, title = ?, note = ?, tags = ?, status = ?, expire_at = ?, updated_at = ? WHERE id = ?`),
      // 续期单独一条：批量续期不该顺手把 url / title / tags 又写一遍，
      // 那些字段这次根本没被碰过，重写一次就多一次覆盖别人改动的机会。
      // 同时清掉「过期前状态」，改完有效期这条已经不是「过期后被停用」的状态了
      setLinkExpire: prepare("UPDATE links SET expire_at = ?, status = ?, status_before_expire = '', updated_at = ? WHERE id = ?"),
      updateLinkPassword: prepare('UPDATE links SET password = ?, updated_at = ? WHERE id = ?'),
      updateLinkLanding: prepare('UPDATE links SET interstitial = ?, landing_theme = ?, interstitial_note = ?, updated_at = ? WHERE id = ?'),
      updateLinkQrStyle: prepare('UPDATE links SET qr_style = ?, updated_at = ? WHERE id = ?'),
      listQrStyles: prepare("SELECT code, qr_style FROM links WHERE qr_style <> '' AND deleted_at IS NULL"),
      bumpClicks: prepare('UPDATE links SET clicks = clicks + ?, last_click_at = ? WHERE code = ?'),
      upsertDaily: prepare(`INSERT INTO click_daily (code, day, clicks) VALUES (?, ?, ?)
        ON CONFLICT(code, day) DO UPDATE SET clicks = clicks + excluded.clicks`),
      upsertRef: prepare(`INSERT INTO click_refs (code, host, clicks) VALUES (?, ?, ?)
        ON CONFLICT(code, host) DO UPDATE SET clicks = clicks + excluded.clicks`),
      upsertAgent: prepare(`INSERT INTO click_agents (code, platform, clicks) VALUES (?, ?, ?)
        ON CONFLICT(code, platform) DO UPDATE SET clicks = clicks + excluded.clicks`),
      // 建页曝光与点击分开两个集合：混进 clicks 会让「点击数」从建页上线那天起不可比
      upsertLanding: prepare(`INSERT INTO landing_views (code, day, host, views) VALUES (?, ?, ?, ?)
        ON CONFLICT(code, day, host) DO UPDATE SET views = views + excluded.views`),
      insertReport: prepare('INSERT INTO reports (code, reason, note, ip, ua, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
      getReport: prepare('SELECT * FROM reports WHERE id = ?'),
      // 短链可能已被彻底删除，所以是 LEFT JOIN：举报记录要比短链活得久
      listReports: prepare(`SELECT r.*, l.title AS link_title, l.url AS link_url, l.status AS link_status
        FROM reports r LEFT JOIN links l ON l.code = r.code COLLATE NOCASE
        ORDER BY r.status = 'open' DESC, r.id DESC LIMIT ? OFFSET ?`),
      countReports: prepare('SELECT COUNT(*) AS n FROM reports'),
      countOpenReports: prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'"),
      setReportStatus: prepare('UPDATE reports SET status = ?, handled_at = ?, handled_by = ? WHERE id = ?'),
      purgeReportsByCode: prepare('DELETE FROM reports WHERE code = ?'),
      countLinks: prepare('SELECT COUNT(*) AS n FROM links WHERE deleted_at IS NULL'),
      countLinksSince: prepare('SELECT COUNT(*) AS n FROM links WHERE deleted_at IS NULL AND created_at >= ?'),
      countDeleted: prepare('SELECT COUNT(*) AS n FROM links WHERE deleted_at IS NOT NULL'),
      sumClicks: prepare('SELECT COALESCE(SUM(clicks), 0) AS n FROM links WHERE deleted_at IS NULL'),
      activeLinks: prepare("SELECT COUNT(*) AS n FROM links WHERE deleted_at IS NULL AND status = 'active'"),
      expiredLinks: prepare('SELECT COUNT(*) AS n FROM links WHERE deleted_at IS NULL AND expire_at IS NOT NULL AND expire_at < ?'),
      // 回收站里的短链不再计入趋势，否则删掉的点击还在图上涨
      dailyRange: prepare('SELECT day, SUM(clicks) AS clicks FROM click_daily WHERE day >= ? AND code NOT IN (SELECT code FROM links WHERE deleted_at IS NOT NULL) GROUP BY day'),
      linkDaily: prepare('SELECT day, clicks FROM click_daily WHERE code = ? AND day >= ? ORDER BY day'),
      linkRefs: prepare('SELECT host, clicks FROM click_refs WHERE code = ? ORDER BY clicks DESC LIMIT ?'),
      linkAgents: prepare('SELECT platform, clicks FROM click_agents WHERE code = ? ORDER BY clicks DESC LIMIT ?'),
      // 来源/平台聚合同样排除回收站里的短链，保持和总量口径一致
      // 空 host 就是「浏览器没上报 referrer」的直接访问。它和真实的域名混在一条榜里，
      // 界面只能把它排在最后并显示成「直接访问」，而它往往又是最大的一块
      globalRefs: prepare(`SELECT host, SUM(clicks) AS clicks, COUNT(DISTINCT code) AS links FROM click_refs
        WHERE code NOT IN (SELECT code FROM links WHERE deleted_at IS NOT NULL)
        GROUP BY host ORDER BY clicks DESC LIMIT ?`),
      globalAgents: prepare(`SELECT platform, SUM(clicks) AS clicks FROM click_agents
        WHERE code NOT IN (SELECT code FROM links WHERE deleted_at IS NOT NULL)
        GROUP BY platform ORDER BY clicks DESC LIMIT ?`),
      purgeOrphanRefs: prepare('DELETE FROM click_refs WHERE code NOT IN (SELECT code FROM links)'),
      purgeOrphanAgents: prepare('DELETE FROM click_agents WHERE code NOT IN (SELECT code FROM links)'),
      purgeOrphanDaily: prepare('DELETE FROM click_daily WHERE code NOT IN (SELECT code FROM links)'),
      purgeOrphanLanding: prepare('DELETE FROM landing_views WHERE code NOT IN (SELECT code FROM links)'),
      // 渠道漏斗：曝光来自 landing_views（按天、有渠道），落地来自 click_refs（全期、有渠道）。
      //
      // 不用 click_daily 去对日期：它只有 (code, day)，没有 host —— 记不下
      // 「这一天这条链的点击来自哪几个渠道」。硬对只会造出一个看似精确的假数字。
      // 所以漏斗按短链算累计，日期维度只留给概览里的「今天新增曝光」。
      landingByCode: prepare(`SELECT lv.code, lv.host, SUM(lv.views) AS views FROM landing_views lv
        WHERE lv.code NOT IN (SELECT code FROM links WHERE deleted_at IS NOT NULL)
        GROUP BY lv.code, lv.host`),
      landingByDay: prepare(`SELECT day, SUM(views) AS views FROM landing_views
        WHERE day >= ? AND code NOT IN (SELECT code FROM links WHERE deleted_at IS NOT NULL)
        GROUP BY day`),
      redirectsByCodeHost: prepare(`SELECT r.code, r.host, SUM(r.clicks) AS clicks FROM click_refs r
        WHERE r.code NOT IN (SELECT code FROM links WHERE deleted_at IS NOT NULL)
        GROUP BY r.code, r.host`),
      // 下钻用：指定渠道时，曝光和落地都要按这个渠道过滤。
      // 落地侧不能复用上面那条全量求和——「某渠道的落地数」和「某渠道的曝光数」
      // 必须来自同一个渠道，否则算出来的落点率是跨渠道混出来的假数字。
      landingByHost: prepare(`SELECT lv.code, SUM(lv.views) AS views FROM landing_views lv
        WHERE lv.host = ? AND lv.code NOT IN (SELECT code FROM links WHERE deleted_at IS NOT NULL)
        GROUP BY lv.code`),
      redirectsByHost: prepare(`SELECT r.code, SUM(r.clicks) AS clicks FROM click_refs r
        WHERE r.host = ? AND r.code NOT IN (SELECT code FROM links WHERE deleted_at IS NOT NULL)
        GROUP BY r.code`),
      listGroups: prepare('SELECT * FROM groups ORDER BY name COLLATE NOCASE'),
      getGroupById: prepare('SELECT * FROM groups WHERE id = ?'),
      getGroupByName: prepare('SELECT * FROM groups WHERE name = ? COLLATE NOCASE'),
      insertGroup: prepare('INSERT INTO groups (name, color, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'),
      updateGroup: prepare('UPDATE groups SET name = ?, color = ?, note = ?, updated_at = ? WHERE id = ?'),
      deleteGroup: prepare('DELETE FROM groups WHERE id = ?'),
      clearGroupRefs: prepare('UPDATE links SET group_id = NULL WHERE group_id = ?'),
      setLinkGroup: prepare('UPDATE links SET group_id = ?, updated_at = ? WHERE id = ?'),
      getSetting: prepare('SELECT value FROM settings WHERE key = ?'),
      setSetting: prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
      listSettings: prepare('SELECT key, value FROM settings'),
      getAdmin: prepare('SELECT * FROM admins WHERE username = ?'),
      getAdminById: prepare('SELECT id, username, role, created_at, created_by, last_login_at, disabled_at FROM admins WHERE id = ?'),
      countAdmins: prepare('SELECT COUNT(*) AS n FROM admins'),
      countOwners: prepare("SELECT COUNT(*) AS n FROM admins WHERE role = 'owner' AND disabled_at IS NULL"),
      listAdmins: prepare(`SELECT id, username, role, created_at, created_by, last_login_at, disabled_at
        FROM admins ORDER BY disabled_at IS NOT NULL, created_at ASC`),
      insertAdmin: prepare('INSERT INTO admins (username, password_hash, created_at, role, created_by) VALUES (?, ?, ?, ?, ?)'),
      updateAdminPassword: prepare('UPDATE admins SET password_hash = ? WHERE id = ?'),
      setAdminRole: prepare('UPDATE admins SET role = ? WHERE id = ?'),
      setAdminDisabled: prepare('UPDATE admins SET disabled_at = ? WHERE id = ?'),
      deleteAdmin: prepare('DELETE FROM admins WHERE id = ?'),
      touchAdminLogin: prepare('UPDATE admins SET last_login_at = ? WHERE id = ?'),
      listKeys: prepare('SELECT id, name, prefix, scope, enabled, created_at, last_used_at FROM api_keys ORDER BY id DESC'),
      getKeyByHash: prepare('SELECT * FROM api_keys WHERE hash = ? AND enabled = 1'),
      insertKey: prepare('INSERT INTO api_keys (name, prefix, hash, scope, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)'),
      deleteKey: prepare('DELETE FROM api_keys WHERE id = ?'),
      toggleKey: prepare('UPDATE api_keys SET enabled = ? WHERE id = ?'),
      touchKey: prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?'),
      listRules: prepare('SELECT * FROM ua_rules ORDER BY id DESC'),
      insertRule: prepare('INSERT INTO ua_rules (kind, pattern, note, enabled, hits, created_at) VALUES (?, ?, ?, ?, 0, ?)'),
      deleteRule: prepare('DELETE FROM ua_rules WHERE id = ?'),
      toggleRule: prepare('UPDATE ua_rules SET enabled = ? WHERE id = ?'),
      bumpRuleHits: prepare('UPDATE ua_rules SET hits = hits + 1 WHERE id = ?'),
      bumpRuleHitsBy: prepare('UPDATE ua_rules SET hits = hits + ? WHERE id = ?'),
      insertAudit: prepare('INSERT INTO audit_log (at, actor, action, detail) VALUES (?, ?, ?, ?)'),
      listAudit: prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?'),
      countAudit: prepare('SELECT COUNT(*) AS n FROM audit_log'),
      listAuditPage: prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?'),
      listAuditByAction: prepare('SELECT * FROM audit_log WHERE action LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?'),
      countAuditByAction: prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE ?'),
      trimAudit: prepare('DELETE FROM audit_log WHERE id < ?'),
      // 巡检结果落库：只写本轮结论，不动 updated_at——
      // 「链接被改过」和「链接被检查过」是两件事，混在一起排序就乱了
      setHealth: prepare(`UPDATE links SET health_status = ?, health_code = ?, health_at = ?, health_ms = ?, health_error = ?, health_miss = ?
        WHERE id = ?`),
      // 巡检取待测项：最近一次检测最久远的优先，永远没测过的排最前
      healthQueue: prepare(`SELECT id, code, url FROM links WHERE deleted_at IS NULL AND status = 'active'
        ORDER BY (health_at IS NULL) DESC, health_at ASC, id ASC LIMIT ?`),
      // 分流目标：只有 enabled 的参与抽取，权重为 0 也不参与（等于临时关掉）
      listTargets: prepare('SELECT * FROM link_targets WHERE link_id = ? ORDER BY id'),
      insertTarget: prepare(`INSERT INTO link_targets (link_id, url, label, weight, regions, enabled, clicks, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?)`),
      updateTarget: prepare('UPDATE link_targets SET url = ?, label = ?, weight = ?, regions = ?, enabled = ? WHERE id = ? AND link_id = ?'),
      deleteTarget: prepare('DELETE FROM link_targets WHERE id = ? AND link_id = ?'),
      deleteTargetsByLink: prepare('DELETE FROM link_targets WHERE link_id = ?'),
      deleteTargetsByCode: prepare('DELETE FROM link_targets WHERE link_id IN (SELECT id FROM links WHERE code = ? COLLATE NOCASE)'),
      bumpTargetClicks: prepare('UPDATE link_targets SET clicks = clicks + ? WHERE id = ?'),
      setTargetHealth: prepare(`UPDATE link_targets SET health_status = ?, health_code = ?, health_at = ?, health_ms = ?, health_error = ?, health_miss = ?
        WHERE id = ?`),
      countTargets: prepare('SELECT COUNT(*) AS n FROM link_targets'),
      purgeOrphanTargets: prepare('DELETE FROM link_targets WHERE link_id NOT IN (SELECT id FROM links)'),
      upsertCountry: prepare(`INSERT INTO click_countries (code, country, clicks) VALUES (?, ?, ?)
        ON CONFLICT(code, country) DO UPDATE SET clicks = clicks + excluded.clicks`),
      linkCountries: prepare('SELECT country, clicks FROM click_countries WHERE code = ? ORDER BY clicks DESC LIMIT ?'),
      globalCountries: prepare(`SELECT country, SUM(clicks) AS clicks, COUNT(DISTINCT code) AS links FROM click_countries
        WHERE code NOT IN (SELECT code FROM links WHERE deleted_at IS NOT NULL)
        GROUP BY country ORDER BY clicks DESC LIMIT ?`),
      purgeLinkCountries: prepare('DELETE FROM click_countries WHERE code = ?'),
      purgeOrphanCountries: prepare('DELETE FROM click_countries WHERE code NOT IN (SELECT code FROM links)'),
      // 访问时段：星期(0=周日) × 小时(0-23)
      upsertSlot: prepare(`INSERT INTO click_slots (code, dow, hour, clicks) VALUES (?, ?, ?, ?)
        ON CONFLICT(code, dow, hour) DO UPDATE SET clicks = clicks + excluded.clicks`),
      linkSlots: prepare('SELECT dow, hour, clicks FROM click_slots WHERE code = ?'),
      // 全站时段：排除回收站，与其它统计口径保持一致
      globalSlots: prepare(`SELECT dow, hour, SUM(clicks) AS clicks FROM click_slots
        WHERE code NOT IN (SELECT code FROM links WHERE deleted_at IS NOT NULL)
        GROUP BY dow, hour`),
      purgeLinkSlots: prepare('DELETE FROM click_slots WHERE code = ?'),
      purgeLinkLanding: prepare('DELETE FROM landing_views WHERE code = ?'),
      // 分组时段：group_id 为 NULL（未分组）的短链一起带出来，前端按同一个键聚合
      groupSlots: prepare(`SELECT l.group_id AS gid, s.dow, s.hour, SUM(s.clicks) AS clicks
        FROM click_slots s JOIN links l ON l.code = s.code COLLATE NOCASE
        WHERE l.deleted_at IS NULL
        GROUP BY l.group_id, s.dow, s.hour`),
      // 变更历史：按链路查，最新的在前
      insertHistory: prepare('INSERT INTO link_history (link_id, code, action, actor, snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
      listHistory: prepare('SELECT * FROM link_history WHERE link_id = ? ORDER BY id DESC LIMIT ? OFFSET ?'),
      countHistory: prepare('SELECT COUNT(*) AS n FROM link_history WHERE link_id = ?'),
      getHistory: prepare('SELECT * FROM link_history WHERE id = ?'),
      deleteHistoryByLink: prepare('DELETE FROM link_history WHERE link_id = ?'),
      deleteHistoryByCode: prepare('DELETE FROM link_history WHERE code = ?'),
      purgeOrphanHistory: prepare('DELETE FROM link_history WHERE link_id NOT IN (SELECT id FROM links)'),
      trimHistory: prepare('DELETE FROM link_history WHERE id < ?'),

      purgeOrphanSlots: prepare('DELETE FROM click_slots WHERE code NOT IN (SELECT code FROM links)'),
      healthTargetQueue: prepare(`SELECT t.id, t.url, t.link_id, l.code AS code FROM link_targets t JOIN links l ON l.id = t.link_id
        WHERE l.deleted_at IS NULL AND l.status = 'active' AND t.enabled = 1
        ORDER BY (t.health_at IS NULL) DESC, t.health_at ASC, t.id ASC LIMIT ?`),
      healthTargetSummary: prepare(`SELECT health_status AS status, COUNT(*) AS n FROM link_targets WHERE enabled = 1 AND health_status <> '' GROUP BY health_status`),
      healthTargetBroken: prepare(`SELECT t.id, t.url, t.label, t.health_code, t.health_error, t.health_miss, l.code AS code
        FROM link_targets t JOIN links l ON l.id = t.link_id
        WHERE t.enabled = 1 AND t.health_status = 'dead' AND l.deleted_at IS NULL
        ORDER BY t.health_miss DESC, t.health_at DESC LIMIT ?`),
      healthSummary: prepare(`SELECT health_status AS status, COUNT(*) AS n FROM links
        WHERE deleted_at IS NULL AND health_status <> '' GROUP BY health_status`),
      healthBroken: prepare(`SELECT ${LINK_COLUMNS} FROM links
        WHERE deleted_at IS NULL AND health_status = 'dead'
        ORDER BY health_miss DESC, health_at DESC LIMIT ?`),
    };

    this.tx = (fn) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw err;
      }
    };
  }

  /**
   * 按短码取记录：先走 BINARY 索引（快），查不到再用 NOCASE 兜底。
   * 短码判重本来就不区分大小写，所以 /MiXeD 和 /mixed 必须是同一条记录，
   * 否则用户把短码抄成小写打不开——这是真实会发生的报错来源。
   * 不能直接把查询改成 COLLATE NOCASE：那会让 UNIQUE 索引失效，跳转热路径退化成全表扫。
   */
  findLinkByCode(code, { includeDeleted = false } = {}) {
    const exact = includeDeleted ? this.sql.getLinkByCodeAny.get(code) : this.sql.getLinkByCode.get(code);
    if (exact) return exact;
    return includeDeleted ? this.sql.getLinkByCodeAnyCI.get(code) : this.sql.getLinkByCodeCI.get(code);
  }

  /**
   * 彻底删除一条短链的全部残留数据。
   *
   * 之前是四处手写「purge 三张统计表」，加了分流目标和地域统计以后
   * 每一处都得记得补两行——漏一处就是孤儿数据。收敛成一个方法，
   * 以后再掉表只改这里。
   */
  purgeLinkData(code) {
    this.sql.purgeLinkStats.run(code);
    this.sql.purgeLinkRefs.run(code);
    this.sql.purgeLinkAgents.run(code);
    this.sql.purgeLinkCountries.run(code);
    this.sql.purgeLinkSlots.run(code);
    this.sql.purgeLinkLanding.run(code);
    this.sql.deleteTargetsByCode.run(code);
    // 历史记录跟着短链一起走：短链都没了，留着它的版本快照没有意义
    this.sql.deleteHistoryByCode.run(code);
  }

  /** 一条短链的全部目标（含已关停的，管理台要能看见并重新打开） */
  listTargets(linkId) {
    return this.sql.listTargets.all(Number(linkId));
  }

  /** 跳转热路径用：只取参与抽取的目标 */
  pickTargets(linkId) {
    return this.sql.listTargets.all(Number(linkId)).filter((t) => t.enabled && t.weight > 0);
  }

  /**
   * 带条件搜索 + 排序 + 分页的链接列表（不含回收站）。
   *
   * `heat` 用不了专门的索引，因为它要先知道「全库最高点击数」才能分档。
   * 查询本身仍然只扫一遍 links 表（一条聚合 + 一条分页），
   * 比把排序交给索引但算不出相对热度要实在。
   */
  listLinks({ q = '', status = '', tag = '', group = '', health = '', heat = '', sort = 'created_desc', sinceDay = '', expiring = '', page = 1, perPage = 20 } = {}) {
    const where = ['deleted_at IS NULL'];
    const params = [];
    // 「即将到期」按天算，不按时分：有效期本来就是粗粒度的东西，
    // 精确到分钟只会让同一批链接在界面上前后脚地消失
    const windowDays = Number(expiring) || 0;
    if (windowDays > 0) {
      const now = Date.now();
      where.push('expire_at IS NOT NULL AND expire_at >= ? AND expire_at <= ?');
      params.push(now, now + windowDays * 86400000);
    }
    if (q) {
      where.push("(code LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\')");
      const like = `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(like, like, like, like);
    }
    if (status === 'active' || status === 'disabled') {
      where.push('status = ?');
      params.push(status);
    }
    if (status === 'expired') {
      // 「过期」是 expire_at 说了算，不是 status 说了算。
      // 关掉过期策略的站里，过期链接的状态还停在 active，
      // 之前这里只看 expire_at，列表给的是「启用」，点进去却是 410。
      where.push('expire_at IS NOT NULL AND expire_at < ?');
      params.push(Date.now());
    }
    if (tag) {
      // 标签里可能有 % 或 _，统一转义，避免被当成 LIKE 通配符
      where.push("(',' || tags || ',') LIKE ? ESCAPE '\\'");
      params.push(`%,${String(tag).replace(/[\\%_]/g, (c) => `\\${c}`)},%`);
    }
    // 健康筛选只认这三种取值。以前只处理 ok / dead / unknown，
    // 传 health=warn 时条件一条都没加上，接口安静地返回全部——
    // 前端以为筛过了，实际拿到的是全库，这比报错更难发现
    if (health === 'ok' || health === 'dead' || health === 'warn') {
      where.push('health_status = ?');
      params.push(health);
    } else if (health === 'unknown') {
      // 「还没测过」= 空串，不是 null
      where.push("health_status = ''");
    }
    // 热度筛选：按「点击数占全库最高点击数」的比例分档，而不是绝对值。
    // 绝对值不可比——一个刚上线的站，10 次点击的小时榜第一名也值得看
    if (HEAT_BANDS[heat]) {
      where.push('clicks >= ?');
      params.push(Math.max(1, Math.ceil(HEAT_BANDS[heat] * this.maxClicks())));
    }
    if (group === 'none') {
      where.push('group_id IS NULL');
    } else if (group) {
      where.push('group_id = ?');
      params.push(Number(group) || 0);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const orderMap = {
      created_desc: 'created_at DESC, id DESC',
      created_asc: 'created_at ASC, id ASC',
      clicks_desc: 'clicks DESC, id DESC',
      clicks_asc: 'clicks ASC, id DESC',
      updated_desc: 'updated_at DESC, id DESC',
      code_asc: 'code ASC',
      health_asc: "(health_status = '') DESC, health_status ASC, health_miss DESC",
      health_at_asc: 'health_at IS NOT NULL, health_at ASC',
    };
    // 小时榜按「最近 24 小时新增点击」排，普通排序键里没有这个维度。
    // 时间基准由调用方给（服务端渲染与管理台共用同一条 SQL），不在这里取 Date.now()
    let order = orderMap[sort] || orderMap.created_desc;
    if (sort === 'recent_desc') {
      // 日期是本地时区的 YYYY-MM-DD，由调用方决定窗口起点
      const day = sinceDay || dateKey(new Date(Date.now() - 86400000));
      order = `(SELECT COALESCE(SUM(clicks), 0) FROM click_daily WHERE code = links.code AND day >= '${day}') DESC, last_click_at DESC, id DESC`;
    }
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM links ${whereSql}`).get(...params).n;
    const offset = (page - 1) * perPage;
    const rows = this.db
      .prepare(`SELECT ${LINK_COLUMNS} FROM links ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, perPage, offset);
    return { rows, total };
  }

  /** 全库最高点击数，热度分档的基准 */
  maxClicks() {
    return this.db.prepare('SELECT COALESCE(MAX(clicks), 0) AS n FROM links WHERE deleted_at IS NULL').get().n || 0;
  }

  /**
   * 即将到期的短链，按剩余时间升序。
   *
   * 过期是最典型的「事后才知道」：链接一失效，印在物料上的那串地址就作废，
   * 而人往往要等到有人反馈才发现。这里提前 N 天把人叫过来处理。
   * 已经过期的排除掉——那是另一件事（要不要恢复），不该和「还有 2 天」混在一张榜上。
   */
  expiringLinks({ days = 7, limit = 50, now = Date.now() } = {}) {
    const windowDays = Math.max(1, Math.min(365, Number(days) || 7));
    const rows = this.db
      .prepare(`SELECT ${LINK_COLUMNS} FROM links
        WHERE deleted_at IS NULL AND expire_at IS NOT NULL AND expire_at >= ? AND expire_at <= ?
        ORDER BY expire_at ASC, id ASC LIMIT ?`)
      .all(now, now + windowDays * 86400000, Math.max(1, limit));
    return { days: windowDays, until: now + windowDays * 86400000, rows };
  }

  /**
   * 热点榜：最近 N 小时新增点击最多的短链。
   *
   * 每行都是今天新建的、点击数还没拉开多少，按累计点击排和按创建时间排没区别；
   * 真正想回答的是「现在什么在被点」。所以窗口取最近 24 小时的新增点击，
   * 同时带上窗口内的曝光与落地，一眼能看出是没人来还是来了没进来。
   *
   * 没有点击的短链不进榜：榜单里塞满 0 只会把有数据的那几条挤下去。
   */
  hotLinks({ hours = 24, limit = 8, now = Date.now() } = {}) {
    const span = Math.max(1, Math.min(24 * 30, Number(hours) || 24));
    const from = now - span * 3600000;
    const fromDay = dateKey(new Date(from - 86400000));
    const rows = this.db
      .prepare(
        `SELECT l.id, l.code, l.title, l.url, l.group_id,
           (SELECT name FROM groups WHERE groups.id = l.group_id) AS group_name,
           (SELECT COALESCE(SUM(clicks), 0) FROM click_daily d WHERE d.code = l.code AND d.day >= ?) AS window_clicks,
           (SELECT COALESCE(SUM(views), 0) FROM landing_views v WHERE v.code = l.code AND v.day >= ?) AS window_views,
           l.clicks AS total_clicks, l.last_click_at
         FROM links l
         WHERE l.deleted_at IS NULL`,
      )
      .all(fromDay, fromDay)
      .filter((r) => r.window_clicks > 0)
      .sort((a, b) => b.window_clicks - a.window_clicks || (b.last_click_at || 0) - (a.last_click_at || 0))
      .slice(0, Math.max(1, limit));
    return { hours: span, since: from, rows };
  }

  listTags() {
    const rows = this.db.prepare("SELECT tags FROM links WHERE tags <> '' AND deleted_at IS NULL").all();
    const counter = new Map();
    for (const { tags } of rows) {
      for (const tag of String(tags).split(',')) {
        const t = tag.trim();
        if (!t) continue;
        counter.set(t, (counter.get(t) || 0) + 1);
      }
    }
    return [...counter.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
  }

  /**
   * 按分组汇总访问时段。
   *
   * 返回 [{ gid, cells, peak, total }]，gid 为 null 表示未分组。
   * 没有点击的分组不在这里出现——「没有数据」和「这个分组没人点」对画图来说
   * 是同一件事，但对上层是有区别的，所以由调用方补零而不是这里造假数据。
   */
  groupHours() {
    const buckets = new Map();
    for (const row of this.sql.groupSlots.all()) {
      const gid = row.gid === null || row.gid === undefined ? 0 : Number(row.gid);
      let cells = buckets.get(gid);
      if (!cells) {
        cells = new Array(7 * 24).fill(0);
        buckets.set(gid, cells);
      }
      const idx = Number(row.dow) * 24 + Number(row.hour);
      if (idx >= 0 && idx < cells.length) cells[idx] = Number(row.clicks) || 0;
    }
    return [...buckets.entries()].map(([gid, cells]) => ({
      gid: gid || null,
      cells,
      peak: Math.max(0, ...cells),
      total: cells.reduce((a, b) => a + b, 0),
    }));
  }

  /** 分组列表，带短链条数与累计点击 */
  listGroupsWithCounts() {
    return this.db
      .prepare(`SELECT g.id, g.name, g.color, g.note, g.created_at,
          COALESCE(c.n, 0) AS links, COALESCE(c.clicks, 0) AS clicks
        FROM groups g
        LEFT JOIN (
          SELECT group_id, COUNT(*) AS n, SUM(clicks) AS clicks
          FROM links WHERE deleted_at IS NULL AND group_id IS NOT NULL GROUP BY group_id
        ) c ON c.group_id = g.id
        ORDER BY g.name COLLATE NOCASE`)
      .all();
  }

  /** 未分组的短链条数，前端要单独展示 */
  countUngrouped() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM links WHERE deleted_at IS NULL AND group_id IS NULL').get().n;
  }

  statsOverview(sinceDay) {
    const total = this.sql.countLinks.get().n;
    const clicks = this.sql.sumClicks.get().n;
    const active = this.sql.activeLinks.get().n;
    const expired = this.sql.expiredLinks.get(Date.now()).n;
    const daily = this.sql.dailyRange.all(sinceDay);
    return { total, clicks, active, expired, disabled: total - active, daily };
  }

  /**
   * 星期 × 小时的热力矩阵。返回 7×24 的扁平数组（dow*24+hour 下标），
   * 前端拿到的就是可以直接画的密集数据，不用再补零。
   */
  /**
   * 渠道漏斗：建页被看了多少次、其中多少次点了「继续访问」。
   *
   * 两边都可能缺：有的渠道只有曝光没有落地（投放话术没说服人，或按钮坏了），
   * 也可能只有落地没有曝光（建页是后开的）。所以补齐成同一批键再算比例，
   * 只出现在曝光那侧的行要留着——那正是最该被看见的一行。
   */
  landingFunnel({ code = '' } = {}) {
    const key = (c, host) => `${c}\u0000${host}`;
    const merged = new Map();
    for (const row of this.sql.landingByCode.all()) {
      if (code && row.code !== code) continue;
      merged.set(key(row.code, row.host || ''), {
        code: row.code, host: row.host || '', views: Number(row.views) || 0, clicks: 0,
      });
    }
    for (const row of this.sql.redirectsByCodeHost.all()) {
      if (code && row.code !== code) continue;
      const k = key(row.code, row.host || '');
      const item = merged.get(k);
      if (item) item.clicks += Number(row.clicks) || 0;
      else merged.set(k, { code: row.code, host: row.host || '', views: 0, clicks: Number(row.clicks) || 0 });
    }
    return [...merged.values()];
  }

  /** 按渠道求和：哪个渠道的人最愿意点进去 */
  funnelByHost({ code = '' } = {}) {
    const map = new Map();
    for (const row of this.landingFunnel({ code })) {
      const item = map.get(row.host) || { host: row.host, views: 0, clicks: 0 };
      item.views += row.views;
      item.clicks += row.clicks;
      map.set(row.host, item);
    }
    return [...map.values()].sort((a, b) => b.views - a.views);
  }

  hourMatrix(rows) {
    const cells = new Array(7 * 24).fill(0);
    for (const row of rows) {
      const idx = Number(row.dow) * 24 + Number(row.hour);
      if (idx >= 0 && idx < cells.length) cells[idx] = Number(row.clicks) || 0;
    }
    const peak = Math.max(0, ...cells);
    return { cells, peak, total: cells.reduce((a, b) => a + b, 0) };
  }

  /** 备份用：全量导出 */
  exportAll() {
    return {
      version: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      links: this.db.prepare('SELECT * FROM links').all(),
      click_daily: this.db.prepare('SELECT * FROM click_daily').all(),
      click_refs: this.db.prepare('SELECT * FROM click_refs').all(),
      click_agents: this.db.prepare('SELECT * FROM click_agents').all(),
      groups: this.db.prepare('SELECT * FROM groups').all(),
      // 带上 code：link_id 是本机的自增主键，换台机器（或 replace 恢复重建了 links）
      // 就对不上了，短码才是跨机器稳定的标识
      link_targets: this.db
        .prepare('SELECT t.*, l.code AS code FROM link_targets t JOIN links l ON l.id = t.link_id')
        .all(),
      click_countries: this.db.prepare('SELECT * FROM click_countries').all(),
      click_slots: this.db.prepare('SELECT * FROM click_slots').all(),
      // 建页曝光与举报一起带走：搬机器后渠道漏斗和待处理举报都不该清零
      landing_views: this.db.prepare('SELECT * FROM landing_views').all(),
      reports: this.db.prepare('SELECT * FROM reports').all(),
      // 历史版本一起带走：换机器后「改坏了想退回去」这件事不该因为搬了家就没了
      link_history: this.db
        .prepare('SELECT h.code, h.action, h.actor, h.snapshot, h.created_at FROM link_history h JOIN links l ON l.id = h.link_id')
        .all(),
      settings: this.db.prepare('SELECT key, value FROM settings').all(),
      ua_rules: this.db.prepare('SELECT kind, pattern, note, enabled FROM ua_rules').all(),
    };
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}
