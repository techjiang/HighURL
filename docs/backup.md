# 备份与迁移

## 数据都在一个目录里

```
data/
  highurl.db          SQLite 主库（短链、统计、设置、密钥）
  highurl.db-wal      WAL 日志（运行中存在）
  .secret             会话/密码 Cookie 签名密钥
  backups/            每日自动备份
    highurl-2025-01-01.json
    ...
```

备份这件事就简化成：**把 `data/` 拷走**。迁移服务器也一样。

## 三种备份方式

### 1. 自动备份（默认开启）

每天第一次维护巡检（每 30 秒一次）时生成一份 JSON 快照，保留最近 **14 份**，旧的自动删除。

位置：`data/backups/`。

### 2. 管理台导出

**备份恢复** 页面提供三种格式：

| 格式 | 适合什么 |
| --- | --- |
| JSON | 推荐。跨版本迁移、恢复，包含短链、分组、统计 |
| SQL (`.sql.gz`) | 想用 `sqlite3` 直接接管，或者导入其它工具。全量：所有表 + 索引一起导出，`gunzip -c x.sql.gz \| sqlite3 新库.db` 就能得到一个结构完整的库 |
| CSV | 给运营/财务看数据，带 BOM，Excel 直接打开不乱码 |

### 3. 命令行

```bash
node src/cli.js backup /backup/highurl-$(date +%F).json
```

可以挂到 cron：

```bash
# 每天 3:20 备份到远端挂载点
20 3 * * * cd /opt/highurl && node src/cli.js backup /mnt/nas/highurl/$(date +\%F).json
```

## 完整性校验

每份 JSON 备份都带一个 `manifest`：导出的程序版本、库版本、来源主机名、各类条数与**校验和**（sha256，覆盖分组 / 短链 / 分流目标 / 四类统计 / 屏蔽规则 / 站点设置）。

为什么需要：合并恢复的语义是「备份里有的就写进去」。一旦文件被截断，缺掉的那半截不会报错，只会被当成「不需要恢复」，然后返回成功。这类失败最难追——它半年后才会以「统计怎么少了一半」的形式出现。

三种结论分得很清：

| 状态 | 含义 | 默认行为 |
| --- | --- | --- |
| `ok` | 校验和与导出时一致 | 直接放行 |
| `mismatch` | 有校验和但对不上（被改过 / 被截断 / 网盘同步冲突） | **拒绝恢复**，要勾选「忽略校验」或 CLI 加 `--force` |
| `legacy` | 早于该功能的备份，没有校验和 | 允许恢复，但界面明说「无法确认内容一致」 |

校验和分两层：`checksum` 覆盖 1.8 之前就有的那批集合，**名单不再改动**——往里加一项，之前导出的备份会整批被判成「损坏」，把好备份当坏的处理比少校验一类数据糟得多。后加的集合（如 `click_slots`）单独算一个 `extraChecksum`：备份里带了这一项才核对，老文件没有就跳过。

先验一遍再动手：

```bash
node src/cli.js verify data/backups/highurl-2026-11-13.json
```

```
data/backups/highurl-2026-11-13.json
  来源 box-1 · HighURL 1.9.0
  导出 2026-11-13 03:12:44 · 库版本 v5
  内容 短链 128，分组 6，分流目标 9，统计 4120，规则 3
✓ 完整性校验通过（sha256 2e18e270f7956f7b…）
```

管理台的「备份恢复」页里还有一张**自动备份**表：每个文件的大小、条数、来源机器与校验状态一并列出，可以当场「复核」或直接「用于恢复」。校验结果按（文件名 + mtime）缓存，重复点开不会重复算。

自动备份的写入顺序也改了：先写 `xxx.json.tmp` 再 `rename`。中途断电只会留下一个 `.tmp`，不会把一个截断的 JSON 顶在「今天的备份」这个位置上——而这个位置恰好是灾难恢复时最先被拿去用的。

## 恢复

### 管理台

**备份恢复 → 选择文件 → 选择模式**：

- **合并** — 同短码覆盖，新短码追加。适合「补数据」「多实例合并」
- **替换** — 先清空所有短链、分组与统计，再全量导入。适合整机迁移

### 恢复会带回什么

管理台与 `highurl restore` 走的是同一套实现（`src/services/restore.js`）：

| 内容 | 落地方式 |
| --- | --- |
| 分组 | 按**名字**（不区分大小写）落库，再把短链挂回去。备份里的分组 id 是本机自增号，换台机器就错位，名字才稳定 |
| 短链 | 同短码覆盖，`deleted_at` 一起恢复——回收站里的东西跟着走 |
| 分流目标 | 按短码重新对应 `link_id`，整组替换；备份里没出现的短链不动 |
| 统计 | `click_daily` / `click_refs` / `click_agents` / `click_countries` 四类全恢复，累加 |
| 屏蔽规则 | 按「类型 + 规则」去重，本机已有的不覆盖 |
| 站点设置 | **默认不恢复**。备份常来自试验机，安静地把线上 `baseUrl` 改了比不恢复危险得多 |

指向本机不存在分组的 `group_id` 会落成 `null`，不会留下「名字空白」的幽灵分组。

### 先预检，再恢复

选好文件后管理台会自动跑一次预检，给出「新增 / 覆盖 / 跳过多少条、带多少分组与统计」。
命令行同样支持干跑：

```bash
node src/cli.js restore backup.json --dry-run
```

恢复是不可逆操作（尤其替换模式），先把账算清楚再点确认。

> 替换模式是不可逆操作，做之前先把当前库导一份。

### 命令行

```bash
node src/cli.js restore /backup/highurl-2025-01-01.json           # 合并
node src/cli.js restore /backup/highurl-2025-01-01.json --replace # 替换
node src/cli.js restore /backup/highurl-2025-01-01.json --force   # 校验不过也要恢复
```

`--replace` 必须配 `--yes`（清库不该被一个手滑的 Tab 完成）；`--force` 只有在校验和对不上、而你确认这份文件没问题时才需要。

### 从 SQL 备份恢复

```bash
# 停服务
systemctl stop highurl

# 备份现有库
mv /var/lib/highurl/highurl.db /var/lib/highurl/highurl.db.bak

# 导入
gunzip -c highurl-2025-01-01.sql.gz | sqlite3 /var/lib/highurl/highurl.db

systemctl start highurl
```

如果只拿到 `.db` 文件本身（没做 dump），直接放回去也行——但要**连着 `-wal` 和 `-shm` 一起**，否则可能丢掉最后一批还没 checkpoint 的点击。

## 换机器

```bash
# 老机器
systemctl stop highurl
tar czf highurl-data.tgz -C /var/lib highurl

# 新机器
tar xzf highurl-data.tgz -C /var/lib
chown -R highurl: /var/lib/highurl
systemctl start highurl
```

`data/` 里包含 `.secret`，一起带过去意味着**已有的登录 Cookie 仍然有效**，不用重新登录。如果换机器是为了"切断旧凭证"，那就删掉 `.secret` 让它重新生成——代价是所有会话失效。

## 灾难恢复演练

别等出事才第一次跑恢复。定期做这个练习：

```bash
# 1. 起一个临时实例，用备份数据
node src/cli.js serve --port 18081 --data /tmp/dr-test

# 2. 导入昨天的备份
node src/cli.js restore data/backups/highurl-$(date -d yesterday +%F).json --replace --data /tmp/dr-test

# 3. 检查条数与点击数
node src/cli.js stats --data /tmp/dr-test

# 4. 抽查几条短码能不能跳转
curl -sI http://127.0.0.1:18081/<某个短码> | head -3
```

跑通了说明备份是「能用的备份」，而不只是「存在的备份」。

## 备份里有什么、没什么

有：短链记录、分组、分流目标、每日点击、来源域名、平台分布、访客地区、访问时段（星期 × 小时）、站点设置、UA 屏蔽规则。

没有：管理员密码哈希、API 密钥、审计日志。这是刻意的——备份文件经常会被复制到别处，不该带着凭证。

所以整机灾难恢复后需要：**重建管理员账号**（`/install` 或 `highurl init`），**重新生成 API 密钥**。

恢复时如果备份里的分组已经被删掉，那条短链会落到「未分组」而不是指向一个不存在的 id；短码大小写不同但实际相同的重复条目，恢复时按后者覆盖前者，不会中途报错。

如果你的场景要求备份也包含账号，用 SQL 备份（`highurl.db` 或 `.sql.gz`）——那里面是全量数据，请自行妥善保管。
