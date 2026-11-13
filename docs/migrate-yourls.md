# 从 YOURLS 迁移

HighURL 能直接读 YOURLS 的 MySQL dump，不用先装 YOURLS、也不用起 MySQL。短码、点击数和创建时间都原样保留。

## 一、从 YOURLS 导出

在跑 YOURLS 的机器上：

```bash
mysqldump -u yourls_user -p --single-transaction --no-tablespaces yourls_db > yourls.sql
```

只需要 `yourls_url` 表就够了，想小一点可以只导这一张：

```bash
mysqldump -u yourls_user -p --no-tablespaces yourls_db yourls_url > yourls.sql
```

> 如果 YOURLS 有自定义短码前缀，`keyword` 列里存的就是完整短码，HighURL 会照搬。

## 二、先预览，再导入

命令行方式：

```bash
# 干跑：只看会导入多少、冲突多少，不写库
node src/cli.js migrate yourls.sql --dry-run

# 正式导入
node src/cli.js migrate yourls.sql
```

输出会告诉你三个数字：

- **新增** — 干净的、可直接插入的条目
- **冲突** — 短码在该 HighURL 实例中已存在（默认跳过）
- **无效** — 短码或 URL 格式不合法的记录

短码冲突不想跳过就加 `--overwrite`，会用 YOURLS 里的数据覆盖同名短码：

```bash
node src/cli.js migrate yourls.sql --overwrite
```

管理台方式：**数据迁移 → 上传文件 → 预览 → 确认导入**，页面上能逐条看到样本和冲突列表，心里更有底。

## 三、会发生什么

导入的字段映射：

| YOURLS | HighURL |
| --- | --- |
| `url` | `url` |
| `keyword` | `code` |
| `title` | `title` |
| `clicks` | `clicks` |
| `timestamp` | `created_at` |

不会迁移的：

- **点击明细** — YOURLS 默认只存总数，没有按天/按来源的历史，所以 HighURL 的 `click_daily` 会是空的，从导入那天开始重新累积。总数（`clicks`）是准的。
- **用户与权限** — HighURL 只有管理员账号，请重新创建。
- **插件配置** — YOURLS 插件的行为需要手动对应到 HighURL 的 UA 屏蔽规则。

## 四、切换流量

最稳的顺序是**不动老服务，先让新服务跑起来**：

1. 新域名 `s2.example.com` 指向 HighURL，导入数据，自测几条短码
2. 老域名 `s.example.com` 的 DNS TTL 提前调低到 60 秒
3. 在 YOURLS 停止写入（或者干脆停掉）
4. 把 `s.example.com` 解析切到 HighURL
5. 观察 `/health` 与跳转日志

已经有流量的老服务里，在切换前最后再导一次增量：重复导入是幂等的，冲突的短码会跳过（除非你加 `--overwrite`），所以"全量导入 + 再导一次"这个操作是安全的。

## 五、常见问题

**报错「未在文件中找到 yourls_url 表数据」**
导出文件里没有这张表。确认 `mysqldump` 命令带上了正确的库名，或者检查 `--tables` 过滤条件。

**导入后点击数变小了**
YOURLS 的 `clicks` 是 BIGINT，如果你的 dump 里出现了 `NULL`，会被当 0。检查一下源库里的实际值。

**短码里有 `/` 或中文**
YOURLS 允许任意字符串做关键词，HighURL 限制为 `A-Z a-z 0-9 - _`（1–64 位）。这类记录会进「无效」列表，得手动改。建议在 YOURLS 后台先批量处理掉。

**想从 YOURLS 之外的系统迁**
只要能把数据整成 HighURL 的 JSON 导出格式就能导。参考 `highurl backup out.json` 生成的文件结构：

```json
{
  "version": 1,
  "links": [
    {"code": "abc", "url": "https://example.com", "title": "", "clicks": 12,
     "created_at": 1700000000000, "status": "active", "tags": "", "note": ""}
  ]
}
```

然后用 `highurl migrate yourls.json` 或管理台的「数据迁移」导入。

## 从 HighURL 自己导出的 CSV 导入

「备份恢复」页能导出 CSV（带 BOM，Excel 直接打开不乱码），同一份文件也能导回来：

```bash
node src/cli.js migrate links.csv --dry-run
node src/cli.js migrate links.csv
```

在管理台「数据迁移」页上传 `.csv` 也一样，预检会把「识别为 CSV」和可导入条数列出来。

几个细节：

- **解析按 RFC 4180 走**，引号包裹、字段内的逗号与换行、`""` 转义都认。标题里写「旧站入口,含逗号」不会被拆成两列——只按逗号 `split` 的话，这种备注会让后面每一列都错位，而且错得静默
- **分组按名字接回去**。CSV 里带的是分组名字而不是 id；本机没有这个名字就新建一个，有就复用。以前导出时分组列恒空（表头写 `group`、SQL 里叫 `group_name`，取值取的是 `r['group']`），所以这条路径实际上一直是残的
- **点击数、创建时间、有效期都保留**，`expire_at` 是毫秒时间戳，空值或非数字一律当「永久有效」，不猜
- 表头大小写、列顺序都容忍，只要求至少有 `code` 与 `url`
