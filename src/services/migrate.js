/**
 * YOURLS 数据迁移：解析 MySQL dump 中的 yourls_url 表，导入为 HighURL 短链。
 * 同时也支持 HighURL 自己的 JSON 导出格式（跨机转移用）。
 */

/** 从 MySQL dump 里切出所有 INSERT 语句的 values 片段 */
function splitStatements(sql) {
  const out = [];
  let i = 0;
  const len = sql.length;
  while (i < len) {
    // 跳过注释与空行
    if (sql[i] === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? len : nl + 1;
      continue;
    }
    if (sql[i] === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? len : end + 2;
      continue;
    }
    if (sql[i] === ';') {
      i += 1;
      continue;
    }
    const start = i;
    let depth = 0;
    let quote = null;
    let escaped = false;
    while (i < len) {
      const ch = sql[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) {
          // '' 转义
          if (sql[i + 1] === quote) i += 1;
          else quote = null;
        }
      } else if (ch === "'" || ch === '"') {
        quote = ch;
      } else if (ch === '(') {
        depth += 1;
      } else if (ch === ')') {
        depth -= 1;
      } else if (ch === ';' && depth <= 0) {
        break;
      }
      i += 1;
    }
    const stmt = sql.slice(start, i).trim();
    if (stmt) out.push(stmt);
    i += 1;
  }
  return out;
}

function parseValues(text) {
  // 解析 (a,'b',NULL),(...) 形式的元组列表
  const tuples = [];
  let i = 0;
  const len = text.length;
  while (i < len) {
    if (text[i] !== '(') {
      i += 1;
      continue;
    }
    i += 1;
    const values = [];
    let current = '';
    let quote = null;
    let escaped = false;
    let isNull = false;
    let started = false;
    while (i < len) {
      const ch = text[i];
      if (quote) {
        if (escaped) {
          const map = { n: '\n', r: '\r', t: '\t', '0': '\0', Z: '\x1a', b: '\b' };
          current += map[ch] ?? ch;
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === quote) {
          if (text[i + 1] === quote) {
            current += quote;
            i += 1;
          } else {
            quote = null;
          }
        } else {
          current += ch;
        }
        i += 1;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        started = true;
        i += 1;
        continue;
      }
      if (ch === ',') {
        values.push(isNull && !started ? null : current);
        current = '';
        isNull = false;
        started = false;
        i += 1;
        continue;
      }
      if (ch === ')') {
        values.push(isNull && !started ? null : current);
        i += 1;
        break;
      }
      if (!started && (ch === 'N' || ch === 'n') && /^null/i.test(text.slice(i, i + 4))) {
        isNull = true;
        i += 4;
        continue;
      }
      if (!/\s/.test(ch)) {
        started = true;
        current += ch;
      }
      i += 1;
    }
    tuples.push(values);
  }
  return tuples;
}

const TABLE_RE = /insert\s+(?:ignore\s+)?into\s+`?([\w$]+)`?\s*(?:\(([^)]*)\))?\s*values/i;

/** 解析 YOURLS 的 MySQL dump */
export function parseYourlsDump(sql) {
  const text = String(sql);
  const links = [];
  const options = {};
  let tableFound = false;
  for (const stmt of splitStatements(text)) {
    const table = TABLE_RE.exec(stmt);
    if (!table) continue;
    const tableName = table[1];
    const cols = table[2]
      ? table[2].split(',').map((c) => c.trim().replace(/`/g, '').toLowerCase())
      : null;
    const valuesIndex = stmt.toUpperCase().indexOf('VALUES');
    if (valuesIndex < 0) continue;
    const tuples = parseValues(stmt.slice(valuesIndex + 6));

    if (tableName === 'yourls_url') {
      tableFound = true;
      const header = cols || ['url', 'keyword', 'title', 'timestamp', 'ip', 'clicks'];
      for (const tuple of tuples) {
        const row = {};
        header.forEach((col, idx) => {
          row[col] = tuple[idx];
        });
        const keyword = String(row.keyword || '').trim();
        const url = String(row.url || '').trim();
        if (!keyword || !url) continue;
        const ts = row.timestamp ? Date.parse(String(row.timestamp).replace(' ', 'T')) : Date.now();
        links.push({
          code: keyword,
          url,
          title: String(row.title || '').trim(),
          clicks: Number(row.clicks) || 0,
          createdAt: Number.isFinite(ts) ? ts : Date.now(),
          ip: String(row.ip || ''),
        });
      }
    } else if (tableName === 'yourls_options') {
      const header = cols || ['option_id', 'option_name', 'option_value'];
      for (const tuple of tuples) {
        const row = {};
        header.forEach((col, idx) => {
          row[col] = tuple[idx];
        });
        if (row.option_name && row.yourls_site === undefined) options[row.option_name] = row.option_value;
      }
    }
  }
  if (!tableFound) {
    throw new Error('未在文件中找到 yourls_url 表数据，请确认导出的是 YOURLS 数据库');
  }
  return { links, options };
}

/** HighURL 自身的导出格式（JSON） */
export function parseHighUrlExport(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  if (!data || !Array.isArray(data.links)) throw new Error('不是有效的 HighURL 导出文件');
  return {
    links: data.links.map((l) => ({
      code: String(l.code),
      url: String(l.url),
      title: String(l.title || ''),
      clicks: Number(l.clicks) || 0,
      createdAt: Number(l.created_at) || Date.now(),
      expireAt: l.expire_at ?? null,
      tags: l.tags || '',
      note: l.note || '',
      status: l.status || 'active',
    })),
    options: {},
    settings: data.settings,
  };
}

export function detectFormat(content, filename = '') {
  if (/\.json$/i.test(filename)) return 'highurl';
  if (/\.csv$/i.test(filename)) return 'csv';
  const head = String(content).slice(0, 200000);
  if (/yourls_url/i.test(head)) return 'yourls';
  if (/^\s*\{/.test(head)) return 'highurl';
  // 没给文件名时靠表头认：管理台导出的 CSV 第一行必然是这几列
  const firstLine = head.split(/\r?\n/, 1)[0] || '';
  if (/^\uFEFF?\s*code\s*,\s*url\b/i.test(firstLine)) return 'csv';
  return 'unknown';
}

/**
 * 生成迁移计划（不写库）：统计可导入 / 冲突 / 非法条目。
 *
 * 判重一律按小写归一：库里有 idx_links_code_nocase，/abc 与 /ABC 是同一个入口，
 * 这里若用原始大小写比对，`ABC` 会被当成「不冲突」放行，落到 INSERT 时撞唯一索引。
 */
export function planImport(store, parsed, { overwrite = false } = {}) {
  const existing = new Set(store.db.prepare('SELECT code FROM links').all().map((r) => String(r.code).toLowerCase()));
  const seen = new Set();
  const plan = { import: [], conflict: [], invalid: [], overwrite };
  for (const item of parsed.links) {
    const code = String(item.code || '').trim();
    const url = String(item.url || '').trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(code) || !/^https?:\/\//i.test(url)) {
      plan.invalid.push({ code, url, reason: '短码或链接格式不合法' });
      continue;
    }
    const key = code.toLowerCase();
    if (seen.has(key)) {
      plan.invalid.push({ code, url, reason: '文件内短码重复（不区分大小写）' });
      continue;
    }
    seen.add(key);
    if (existing.has(key)) {
      if (overwrite) plan.import.push({ ...item, overwrite: true });
      else plan.conflict.push({ code, url });
      continue;
    }
    plan.import.push(item);
  }
  return plan;
}

/** 执行导入，单事务，返回统计 */
export function applyImport(store, plan) {
  let created = 0;
  let updated = 0;
  let groups = 0;
  // CSV 里带的是分组「名字」而不是 id：id 换台机器就错位，名字才是人认得的东西。
  // 名字在本机不存在时新建一个——导入一份带分组的备份，结果分组全丢，那不叫导入
  const groupIdOf = (name) => {
    const key = String(name || '').trim();
    if (!key) return null;
    const found = store.db.prepare('SELECT id FROM groups WHERE name = ? COLLATE NOCASE').get(key);
    if (found) return found.id;
    const ts = Date.now();
    store.db.prepare('INSERT INTO groups (name, color, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(key, '', '', ts, ts);
    groups += 1;
    return store.db.prepare('SELECT id FROM groups WHERE name = ? COLLATE NOCASE').get(key)?.id ?? null;
  };
  store.tx(() => {
    for (const item of plan.import) {
      const ts = Number(item.createdAt) || Date.now();
      if (item.overwrite) {
        // 覆盖导入时顺手把回收站里的同名短码救回来，否则看起来「导入成功了但列表里没有」。
        // 匹配必须带 COLLATE NOCASE：文件里写的是 ABC、库里是 abc，用 BINARY 比会一条都更新不到。
        store.db
          .prepare('UPDATE links SET url = ?, title = ?, clicks = ?, updated_at = ?, tags = ?, note = ?, status = ?, expire_at = ?, deleted_at = NULL WHERE code = ? COLLATE NOCASE')
          .run(item.url, item.title || '', Number(item.clicks) || 0, ts, item.tags || '', item.note || '', item.status || 'active', item.expireAt ?? null, item.code);
        if (item.groupName !== undefined) {
          store.db.prepare('UPDATE links SET group_id = ? WHERE code = ? COLLATE NOCASE').run(groupIdOf(item.groupName), item.code);
        }
        updated += 1;
      } else {
        store.db
          .prepare('INSERT INTO links (code, url, title, note, tags, status, password, clicks, created_at, updated_at, last_click_at, expire_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?)')
          .run(item.code, item.url, item.title || '', item.note || '', item.tags || '', item.status || 'active', Number(item.clicks) || 0, ts, ts, item.expireAt ?? null);
        if (item.groupName) {
          store.db.prepare('UPDATE links SET group_id = ? WHERE code = ? COLLATE NOCASE').run(groupIdOf(item.groupName), item.code);
        }
        created += 1;
      }
    }
  });
  store.sql.insertAudit.run(Date.now(), 'migrate', 'migrate.import', `created=${created} updated=${updated}`);
  return { created, updated, groups, total: plan.import.length };
}

/* ---------------- CSV ---------------- */

/**
 * 解析 CSV（RFC 4180 的一个子集，够用就好）：
 * 双引号包裹、引号内 `""` 转义、字段里允许逗号与换行、忽略 BOM 与 CRLF。
 *
 * 不能用 `split(',')`——备注里一个逗号就能把整行的列错开，
 * 而错位是静默的：导入成功、数据全歪。管理台导出的 CSV 里
 * 「含,逗号」这种备注本来就存在，所以这里必须认真做。
 */
export function parseCsv(text) {
  const src = String(text).replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // 最后一行没有换行符时也要收尾，否则最后一条会静默丢掉
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ''));
}

/** 按格式分派到对应的解析器，路由和 CLI 都走这里，避免两处各判断一遍 */
export function parseByFormat(format, content) {
  if (format === 'yourls') return parseYourlsDump(content);
  if (format === 'csv') return parseCsvExport(content);
  return parseHighUrlExport(content);
}

/** 把导出的 CSV 读回成统一的 links 结构；列名大小写与顺序都容忍 */
export function parseCsvExport(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('CSV 内容为空');
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const at = (name) => header.indexOf(name);
  const iCode = at('code');
  const iUrl = at('url');
  if (iCode < 0 || iUrl < 0) throw new Error('CSV 缺少 code 或 url 列，请使用管理台导出的格式');
  const col = (row, name) => {
    const idx = at(name);
    return idx < 0 ? '' : String(row[idx] ?? '').trim();
  };
  const links = [];
  for (const row of rows.slice(1)) {
    const code = col(row, 'code');
    const url = col(row, 'url');
    if (!code && !url) continue;
    const clicks = Number(col(row, 'clicks')) || 0;
    const expire = Number(col(row, 'expire_at'));
    links.push({
      code,
      url,
      title: col(row, 'title'),
      note: col(row, 'note'),
      tags: col(row, 'tags'),
      status: col(row, 'status') || 'active',
      clicks,
      // 纯数字才是时间戳；空值或非数字一律当「永久有效」，不猜
      expireAt: Number.isFinite(expire) && expire > 0 ? expire : null,
      groupName: col(row, 'group_name') || col(row, 'group'),
      createdAt: Number(col(row, 'created_at')) || Date.now(),
    });
  }
  return { links, options: {}, settings: undefined };
}
