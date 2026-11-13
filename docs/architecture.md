# 架构说明

## 一句话

单进程 Node.js，请求进来分四类：静态资源、跳转、管理台 API、公开页。跳转是最热路径，只读内存缓存 + 写内存计数，不碰磁盘。

## 请求链路

```
客户端
  │
  ▼
http.createServer
  ├─ /static/*, /img/*        → StaticServer（内存缓存 + ETag）
  ├─ 限流（每 IP / 每分钟）    → RateLimiter 令牌桶
  ├─ Router 精确匹配
  │    ├─ /, /docs, /health, /metrics, /robots.txt, /sitemap.xml
  │    ├─ /api/v1/*           → Bearer Token 或管理员会话
  │    ├─ /admin/api/*        → 管理员会话
  │    └─ /login, /install…
  └─ 兜底：/<code>[/子路径]    → 短链跳转
```

短链跳转排在最后，因为短码是用户自定义的、形状不确定，只能兜底匹配。代价是未命中时会多走一次路由查表，可以忽略。

## 跳转热路径

```
handleRedirect(code)
  ├─ LinkCache.load(code)        LRU + 30s TTL，命中则零 SQL
  ├─ 爬虫屏蔽 / UA·IP 规则匹配    规则正则在启动时编译，变更时整体 reload
  ├─ 状态与有效期检查
  ├─ 密码校验（HMAC 签名 Cookie，无服务端会话存储）
  ├─ 分流选目标                  目标列表也在 LinkCache 里；有地区头先按地区筛，再按权重抽
  ├─ counter.hit()              只写内存 Map，O(1)，顺带记地区与命中的目标
  └─ 302 跳转（状态码可配 301/302/307/308）
```

关键点：**跳转路径没有任何写操作**。这是能跑到万级 QPS 的根本原因。

## 延迟计数

```
hit()  →  buffer: Map<code, { clicks, refs: Map, agents: Map, day }>
                    │
       setInterval(countFlushMs，默认 1000ms)
                    ▼
              flush(): 单个 BEGIN IMMEDIATE 事务
                    │
       ├─ UPDATE links SET clicks = clicks + ?
       ├─ UPSERT click_daily
       ├─ UPSERT click_refs
       └─ UPSERT click_agents
```

细节：

- 一个批次里每个短码只发 4 条 SQL，而不是每次点击 4 条
- 全部预编译语句，`node:sqlite` 的 `StatementSync.run()` 直接绑定
- flush 失败时整批回流到 buffer，下个节拍重试，不丢计数
- `buffer.size` 触达 `countCacheMax` 时强制同步落一次，防止内存无界增长
- 进程收到 SIGINT/SIGTERM 时先 flush 再退出

## 点击去重

刷量或者用户手抖连点，都会让数字变得不可信。去重在这一层拦：

```
handleRedirect(code) → 判定该跳转确实成立之后
  ├─ deduper.seen(ip, code)   窗口内见过 → 直接跳过计数
  └─ 否则 counter.hit()       照常入 buffer
```

- 键是 `ip + code`，窗口由设置里的 `dedupeWindowSec` 决定，0 表示关闭（默认）
- 结构是一个带上限的 `Map`，满了按插入顺序淘汰最老的一批，内存有界
- 纯内存、无 IO，热路径上只多一次哈希和一次查找
- **只影响计数，不影响跳转**——被判定为重复的请求照样 302 到目标地址

被跳过的次数记在 `deduper.stats().skipped`，`/health` 和 `/metrics` 都能看到。

## 数据自检

管理台「系统设置 → 数据自检」调 `GET /admin/api/doctor`，一次报四件事：

| 项 | 含义 |
| --- | --- |
| 统计孤儿行 | `click_daily` / `click_refs` / `click_agents` / `click_countries` / `click_slots` / `link_targets` 里指向已不存在短码的行数 |
| 短码冲突 | 只差大小写、指向不同链接的短码（正常情况下应为 0） |
| 数据库版本 | 当前 `SCHEMA_VERSION` |
| 待落库点击 | buffer 里还没写盘的点击数 |

它只报告，不动数据。要清理孤儿行得单独调 `POST /admin/api/doctor/collect`，或跑 `highurl stats --collect-orphans`。分开是有意的：诊断可以随时点，删除必须有第二次确认。

## 过期回收

短链的 `expire_at` 到点后，跳转侧本来就拒绝访问（410）。数据要不要清掉，由设置里的 `expiredPolicy` 决定：

| 策略 | 行为 |
| --- | --- |
| `none`（默认） | 不处理，只保留过期状态，数据不动 |
| `disable` | 过期超过宽限期后置为 `disabled` |
| `delete` | 过期超过宽限期后连统计一起删掉 |

`sweepExpired()` 挂在 maintenance 的定时任务上，也可以在短链页手动点「回收过期」触发。
宽限期从 `expire_at` 起算，给误设有效期留一段补救时间。每次回收写一条 `link.expire_sweep` 审计。

### 到期续约

过期最容易出的事不是「数据被删」，而是「到期那一刻才知道」——链接失效时，
印在物料上的那串地址已经作废，这时候能做的只剩道歉和重印。所以这一版把
到期从「一个会自己发生的日期」变成「一件需要人处理的事」：

- **提前量在界面上**：列表可按 7 天内 / 30 天内 / 已过期筛，三天内到期的行挂一枚 `N 天后到期`；
  概览「本期要点」把 7 天内到期的条数并进待处理项；`highurl expiring` 在终端里给同一份名单。
- **续期只动一个字段**：`setLinkExpire` 只写 `expire_at` / `status` / `status_before_expire`。
  走通用 `update` 意味着把 url、title、tags、group 一起重新提交一遍，只要前端拿的是
  十秒前读出来的快照，就有覆盖别人改动的机会。批量续期 500 条时，这个概率不为零。
- **基准是「现在」而不是「原有效期」**：一批链里可能有的已经过期三天、有的还有二十天，
  在 `expire_at` 上做加法在它们身上是完全不同的结果。原有效期还在未来的，从原有效期接着延
  （提前续期不该缩短期限）；已经过期的，从现在起算。
- **状态要还原，不能一律打开**：v10 加了 `status_before_expire`。自动停用的链续期后恢复成
  过期前的状态；本来就手动停用的保持停用。不记这一笔，续期只能一律改回 `active`——
  那等于替管理员把他自己关掉的链接又打开了。
- **「已过期」看 `expire_at`，不看 `status`**：关掉回收策略的站里，过期链接的状态还停在
  `active`，列表显示「生效中」、点进去却是 410。现在列表筛选与跳转用同一个口径。

## 分组与回收站

**分组**是一层软归类：`links.group_id` 指向 `groups.id`，查询时用相关子查询取名字（`SELECT name FROM groups WHERE groups.id = links.group_id`），点一次链接列表只多一次极快的索引查找，不值得为此写 JOIN。

删除分组走 `clearGroupRefs` 把 `group_id` 置空再删行——短链是用户资产，分组只是标签，删标签不该删资产。

**回收站**用 `links.deleted_at` 做软删除：

- `remove()` 只写 `deleted_at`，记录与统计都留着，跳转侧因为查不到记录而返回 404
- 短码继续占位，`code` 的唯一约束仍然生效，删掉的短链不会被人抢注走原本的流量
- `purge()` 才是真删，连带清 `click_daily` / `click_refs` / `click_agents`
- 所有统计口径（总量、来源、平台、趋势）都排除 `deleted_at IS NOT NULL`，否则删掉的点击还挂在图表上

回收站清理挂在 maintenance 上，按 `trashRetentionDays` 到期 `purge`，默认 0 表示不自动清。

## 来源分析

`click_refs` 只记录带 referrer 的点击，`click_agents` 记录按 UA 粗分的平台。来源页读的是全站聚合：

- 来源站点 Top 30：按 `host` 汇总，去掉 `www.` 前缀
- 访问平台：Windows / macOS / iOS / Android / Linux / 其他
- 「直接访问 / 无来源」= `links.clicks` 总和 − `click_refs` 总和

分母用 `links.clicks` 而不是 refs 合计，否则没有 referrer 的点击会被漏算，占比会失真。

访客地区来自 `click_countries`，聚合口径与上面一致（排除回收站里的短链）。没有地区头的请求
根本不会进这张表——所以「地区分布」的总和通常小于总点击，这是对的，不是数据丢了。

## 本期要点与热点榜

概览原来是一排 KPI 加几张图，数据全在，但「跟昨天比怎么样、有没有事等着我处理」得自己
在六个页面之间对。`src/services/insights.js` 把这些结论算成一段话，前端照着念。

几条硬规矩：

- **只报变化和异常**。没有变化不说「一切正常」，页面不会凭空长出一个空框
- **样本太小不判涨跌**。两期都不到 5 次点击时返回 `null`，不把 3 次点击说成涨了 300%
- **必须按天切窗口**。`click_daily` 只有天粒度，用滚动小时窗去凑会让同一天的数据在两期里各算一次；
  所以窗口只接受整天，`hours` 会先被取整到 24 的倍数，界面上也据实写「今天对比昨天」而不是「最近 24 小时」
- **每条都带入口**。结论和证据不隔页面，点进去就是来源分析 / 漏斗 / 举报箱 / 死链筛选
- **落地率只在两期都有曝光时比**。只有一期有曝光时那是「刚开建页」，不是「转化变差」

热点榜回答的是另一个问题：**现在什么在被点**。累计点击榜永远是那几条老链接，
所以榜单按最近 24 小时的 `click_daily` 增量排，顺带带上窗口内的 `landing_views`：

| 列 | 含义 |
| --- | --- |
| 窗口点击 | 最近 24 小时新增，排序依据 |
| 窗口曝光 | 同期建页被打开的次数，`0` 就说明这条链没走建页 |
| 最近一次 | 服务端记的 `last_click_at` |

窗口内没有点击的短链不进榜——榜单里塞满 `0` 只会把有数据的几条挤下去；短链列表那边
另有一套「最近 24 小时热度」排序，那个是全量、不截断的。

热度筛选（列表页）用**相对分档**而不是绝对值：门槛是「占全库最高点击数的比例」（热门 ≥ 60%、
有热度 ≥ 20%）。绝对值不可比，一个刚上线的站最高点击只有 10，按 100 卡的话一个都筛不出来。

## 分流目标（A/B 与按地域）

一个短码背后可以挂最多 8 个目标，按权重随机命中，或者按访客地区指定。

**没有动 `links.url`。** 它仍然是「默认目标」，被二维码、CSV 导出、拼版打印、备份、
YOURLS 导入、健康巡检一大堆地方依赖着。把多目标塞进 `links` 就等于让每一处都要改一遍。
多出来的只有一张 `link_targets` 从表，没有目标时行为与以前完全一致。

选择顺序是「精确优先、兜底其次、默认最后」：

```
pickTarget(targets, country)
  ├─ 有地区匹配的目标 → 在匹配集合里按权重抽
  ├─ 否则在全球目标（regions 为空）里按权重抽
  └─ 都没有 → 回 links.url
```

几条取舍：

- **地区来自代理，不是自建 GeoIP**。`CF-IPCountry` 无条件采信（Cloudflare 会覆盖客户端传的值）；
  `X-Country-Code` / `X-Geo-Country` 只在开了 `trustProxy` 时才认，否则客户端随便伪造一个头就能挑目标
- **取不到地区时只有全球目标参与抽取**，一条全球目标都没有就跳默认目标。地区识别失败不该让链接打不开
- **权重 0 等于临时关掉**，配置还在，不用记住原来的值就能恢复
- **目标全关停时安静回落到默认目标**，同样是为了「不能打不开」
- **抽签只用 `Math.random`**。这不是安全决策，选哪个目标不构成攻击面，热路径上不值得多一次 crypto 调用
- 命中时会回 `X-Highurl-Target: <id>` 响应头，排查「为什么跳过去是另一个页面」时不用猜

计数记在目标上（`link_targets.clicks`），和短链点击一样走内存攒批：
`counter.hit()` 多收两个可选参数 `country` / `targetId`，flush 时一个 `UPDATE` 加一个 `UPSERT`。
权重是「打算怎么分」，命中数是「实际分成了什么样」——两者不一致时，通常意味着某条目标被地区规则吃掉了大部分流量。

分流目标也参与死链巡检：主目标活着不代表备选活着，权重抽到一个 404 的备选，用户看到的就是坏链接。

## 短码大小写

短码对外**不区分大小写**：`/MiXeD` 和 `/mixed` 是同一条。这条规则落在数据库上（`code COLLATE NOCASE` 唯一索引，见[数据模型](#数据模型)），应用层只负责照顾热路径：

```
findLinkByCode(code)
  ├─ getLinkByCode(code)                 精确查
  └─ 未命中 → getLinkByCodeAnyCI(code)   COLLATE NOCASE 兜底
```

先精确查再兜底：精确查命中率在真实流量里极高（用户点的基本都是当初录入的那个拼写），一次索引等值查找就结束；只有大小写写歪的少数请求才多走一跳。

配套的两件事：

- 缓存键统一 `code.toLowerCase()`，否则 `/MiXeD` 与 `/mixed` 会存成两份，失效时只清掉一份
- 跳转时一律用查回来的规范短码（`link.code`）做后续动作——Cookie 里的密码票据、计数、审计都按规范短码走

## 二维码与批量导出

二维码不引入任何第三方库，自己算：

| 模块 | 做什么 |
| --- | --- |
| `services/qr.js` | `qrMatrix(text)` 出 0/1 矩阵，`qrSvg` / `qrPng` 两种渲染 |
| `lib/png.js` | 8 位灰度 PNG 编码（二维码只有黑白两色，不需要调色板和通道交织） |
| `lib/zip.js` | store 模式的 ZIP 写入，PNG 已压缩，再 deflate 只是烧 CPU |
| `lib/pdf.js` | 手写 PDF：矩形、圆 / 圆角矩形、线段、文字、自动换行、FlateDecode、xref 表 |
| `services/qr-sheet.js` | 把二维码排成纸张网格，算列宽、行高、裁切线、页眉页码，并套用与单条一致的样式 |

四个接口：

| 接口 | 说明 |
| --- | --- |
| `GET /admin/api/qr.svg?text=` | 单张矢量图，管理台预览与新建后的展示 |
| `GET /admin/api/qr.png?text=&scale=` | 单张位图，下载用（`scale` 2–24） |
| `GET /admin/api/qr.zip?scope=codes\|filter&codes=&preset=&dot=&dark=&light=&gradient=&ecc=` | 批量打包，单次上限 1000 条 |
| `GET /admin/api/qr.pdf?scope=codes\|filter&paper=&cols=&title=&cut=&preset=&dot=&dark=&light=&gradient=&ecc=` | 拼版打印稿，单次上限 500 条 |

样式参数四个接口都吃，且解析走同一个 `resolveStyle`：非法值一律回落默认，不让一个写错的 `dot=triangle` 变成 500。管理台把「上次选的那套」存在 localStorage，单条弹窗、批量 ZIP、拼版 PDF 三处共用——印物料时看到的就是下载到的那张，不会出现「预览有颜色、打出来黑白」这种偏差。

批量导出的 ZIP 里是 `qr/<短码>.png` 加一份 `codes.csv`（短码、短链、目标地址、标题）。印物料前先看对照表确认哪张图是哪条，不用挨个扫码。两种范围：`codes` 取勾选，`filter` 取当前筛选结果（搜索词、状态、标签、分组、排序都带上）。文件名带日期，大小写敏感的文件系统上也不会互相覆盖。

位图由服务端渲染而不是前端 `canvas`：Safari 上给 `<img>` 一个没有显式宽高的 SVG，画到 canvas 会得到空白图，而且受设备像素比影响尺寸不稳。

拼版 PDF 同样手写，不拉 PDF 库——需要的东西就这么点，三百来行写完，还省掉一次依赖审计。二维码按行合并连续黑格画成矢量矩形（`qrRuns`），所以放大到 A0 或拿去印刷都不会糊，也不存在位图 DPI 的问题。

不嵌字体是刻意的取舍：内置只有 Courier，中文标题画不出来。标题含非 ASCII 时退回显示域名——印一张全是问号的纸比印域名更没用。中文元数据用 UTF-16BE 写进 PDF Info，阅读器属性里能看到。

列数「自动」按条目数算：≤4 走 2 列，5–12 走 3 列，13–24 走 4 列，再往上 5 列。显式指定时夹在 2–6 之间，越界大抵是手滑。

拼版吃样式之后有两条渲染路径，选谁只看「有没有真的用上颜色」：

- **纯黑白方块**：按行合并成横向 run，一条 run 一个 `re f`，并用灰度算子 `0 g` 而不是 `0 0 0 rg`。一份 500 条的拼版能省几万字节，画出来完全一样。
- **彩色 / 渐变 / 圆角 / 圆点**：逐模块画。圆点与圆角走 PDF 的三次贝塞尔（控制点系数 `4/3·(√2−1)`），渐变按模块位置插值成实色，没去写 shading 字典——那要额外一套 Pattern 资源，收益不值这个复杂度。

圆点半径取 0.44 格而不是 0.5：半径等于半格时相邻圆点正好相切，远看还是一整片黑，圆点就白做了。

## 变更历史与版本对比

`link_history` 存的是**当时那一版的完整快照**（JSON），不是 diff。字段还会长（分流目标、密码、地区），做 diff 就意味着以后每加一个字段都要改比对逻辑；而历史记录本质上是「当时的样子」，JSON 正是它本来的形态。快照不含密码——它只在不同密码之间来回没有意义，也免得口令散进备份文件。

回滚就是重放快照，所以不会漏字段。回滚本身也先记一版（`rollback_before`），「回滚到了错的版本」还能再滚回来。

`GET /admin/api/links/:code/history/diff?from=<id>&to=<id|0>` 做逐字段对比，`to=0` 表示「和当前状态比」。按字段比而不是按字符比，是因为短链的字段各自是独立语义单位——比一行 URL 的字符差异没意义，要回答的是「哪个字段从什么变成什么」。

几个边界：`from` 缺失直接 400（不拿 `NaN` 去查库）；版本 id 属于别的短链时 404（`Number(row.link_id) !== Number(link.id)`），对比不能跨链。有效期比较前先落成 `YYYY-MM-DD`，不然两串毫秒数之间的差别读不出含义。分流目标按 URL 集合求增减，不按下标——整组换掉是常态，按下标比会得到「全变了」的噪音。

## 分组点击趋势

`GET /admin/api/groups/trend?days=7..90`（默认 14）一次返回所有分组 + 未分组的每日点击：

```sql
SELECT COALESCE(l.group_id, 0) AS gid, d.day, SUM(d.clicks)
FROM click_daily d JOIN links l ON l.code = d.code
WHERE d.day >= ? AND l.deleted_at IS NULL
GROUP BY gid, d.day
```

一次查全部、前端只发一个请求，比每组各查一次省 1+N 次往返。回收站的短链要排除，否则删掉的点击还挂在图上（和总量、来源、平台口径保持一致）。前端最多画 6 组，剩下的并成「其它 N 个分组」，卡片不至于被拉成一长条。

## 分组活跃时段

`GET /admin/api/groups/hours` 把 `click_slots` 直接按分组聚合：

```sql
SELECT l.group_id AS gid, s.dow, s.hour, SUM(s.clicks)
FROM click_slots s JOIN links l ON l.code = s.code COLLATE NOCASE
WHERE l.deleted_at IS NULL
GROUP BY l.group_id, s.dow, s.hour
```

比趋势图多两件事，都跟「别让图骗人」有关：

- **没有点击的分组要补一个全零矩阵**。趋势图那边不补没关系，少一行没人看得出；热力图是按卡片排的，缺一张卡会让人以为这个分组不存在。查询只返回有数据的组，缺的由接口按分组表补齐。
- **group_id 指向不存在分组的行**（分组被硬删、外部导入留下的悬空引用）不能悄悄并入「未分组」——它们既不属于任何现存分组，也不属于「从未分组」的短链，混进去会让未分组那张图多出一块解释不了的量。趋势图那边把这类数据单独成「已删除分组」一段；热力图这边直接跳过，因为它的量通常已经为 0（分组删除时短链会回到未分组）。

矩阵固定 7×24 扁平数组，前端拿到就能画，不用补零。着色用分组自己的颜色：同一页上五张热力图如果都是紫色，就得靠标题认人。

## 跳转前建页（interstitial）

密码门（`links.password`）在内部小范围分享还行，一旦贴到海报、推文、群里，
多一步就是一半人走掉。更好的做法是**先落在一张自动生成的介绍页上**：
目标域名大字打头，标题、分组、剩余有效期跟着，再让人自己点「继续访问」。

几个刻意的取舍：

- **不自动跳**。自动跳的「等待 3 秒」页只是噪音——真正的窗口期只有那几秒，
  而人在这几秒里通常什么都没看。要让人看清，就得让他主动点一下。
- **目标地址不写进 HTML 的链接**。按钮是 `<form method="get" action="/<code>">` +
  `?go=1` 提交，目标地址只存在于服务端。这样各种预取、邮件扫描、爬虫顺手点开
  都不会产生一次真实点击；介绍页被人收藏或转发出去，别人打开也只是又看一遍介绍页。
- **`go=1` 不往下传**。它只是本站的放行标记，透给目标站点会在对方的统计里
  多出一个看不懂的参数，在 `appendSuffix` 里统一跳过。
- **停用 / 过期照常渲染，只换掉按钮**。一屏冷冰冰的 404 回答不了「为什么打不开」，
  而「这条链已经过期」是能让人当场处理掉的信息。
- **密码门仍然优先**。开了建页不等于免密，`?go=1` 也绕不过去。
- **建页本身不计点击**。点在「继续访问」之后才计数——把「看了一眼介绍页」
  记成一次访问，会让所有点击数都变得不可信。
- **结论在创建时落库**，不是每次读站点设置。否则改一次全局默认值，
  所有存量短链的行为会跟着变，而它们可能正印在物料上。

页面内容是从短链字段渲染的，不存 HTML：存了就是一份会过期的快照，
改完短链还得记得改页面。主题只存 `auto` / `dark` / `light` 三个值，
非法值回落到 `auto`——一列 TEXT 不该成为坏值的容器。

顺带记一个真 bug：第一版 `return showLanding(...)` 把渲染函数的 `true`
当成了「短链没匹配上，再补一个 404」，响应头已经写完再写一次，于是每次
打开建页都白送一个 500。`ERR_HTTP_HEADERS_SENT` 这类错误不会自己冒出来——
页面在浏览器里看着完全正常，只有看日志和 `/health` 的 `errors` 才发现。

## 二维码样式跟随短链

样式原先只存在浏览器 `localStorage`，换台机器、换个浏览器就回到默认黑白。
可二维码是印在物料上的东西：同一批海报和下一次导出必须长得一样。
样式本来就属于这条短链，落库才对得上（`links.qr_style`）。

- 写入走白名单，逐字段校验（预设名、形状、颜色、纠错等级），坏值当场 400。
  这一列会被拼进导出链路，存进一份奇怪的 JSON，坏的是之后每一次生成。
- 前端优先级：短链记住的 > 本机上次用的 > 默认。批量 ZIP 与拼版 PDF
  也读同一份，所以「预览里看到的那张」就是「印出来的那张」。
- 建页的品牌强调色也从这里取（渐变起点优先，白码点不算），物料上的码和
  落地页因此是同一套颜色。

## 静态资源缓存

`app.css` / 管理台脚本的地址都带 `?v=<版本号>`。不只为了部署后立刻拿到新样式，
更因为**跨主题的那几个颜色**：落地页浅色主题的标题色、按钮文字色是后加的，
浏览器一旦缓存了旧的 `app.css`，页面结构是对的、只是文字看不见——
这种缺陷最容易被当成「设计就这样」漏过去。

带 `v` 的请求回 `immutable`（一年），不带 `v` 的回落到 5 分钟：地址里既然有版本号，
内容就是不可变的，可以放心长缓存。这一版之前统一只给 5 分钟，代价是升级后的头五分钟里
浏览器还在用旧 JS 对着新接口跑——改了半天的新行为，刷新看不见。

## 短链名片页 `/<code>+`

- 用 `+` 而不是 `/p/<code>` 或 `/preview?code=`：短码允许 1–64 位 `[A-Za-z0-9_-]`，任何英文路径段都可能正好是别人的短码，而 `+` 不在字符集里，永远不会撞。
- **不计数、不走分流**。它是「看清楚」，不是「访问」，记进点击统计只会让数字变得不可信。
- 密码保护的链只显示「受密码保护」，目标地址、标题、二维码全部隐藏。加密码是为了藏东西，名片页不能把它漏出去。
- 停用 / 过期的链照常显示目标地址，排查「这条链为什么打不开」时正好要用。
- 二维码内联成 SVG：塞进 `<img src="<svg ...>">` 会被 HTML 转义成一段文本，页面上就是一个破图标。这是本轮自测时截图才发现的问题——接口返回 200、DOM 里也有内容，只有真的看一眼才知道它是空的。
- `noindex, nofollow`：名片页是给收到链接的人看的，不该被搜索引擎当内容收录。
- 底部有「这条链接有问题？」。用原生 `<details>` 而不是弹窗：这一页没有加载任何脚本，
  为一个举报表单拉一套前端逻辑不值得。表单 POST 回 `/<code>` 并带隐藏字段 `kind=report`，
  和密码解锁共用一个地址——短码字符集里没有 `/`，另开 `/report/<code>` 反而会和子路径透传撞上。

## 缓存

| 缓存 | 位置 | 失效方式 |
| --- | --- | --- |
| 短链记录 | `LinkCache`（LRU 2 万条，TTL 30s） | 写入时按短码失效 / 全量失效 |
| 分流目标 | `LinkCache.targets`（同 TTL） | 同上；空数组也缓存，免得每次跳转都去问库 |
| 静态文件 | `StaticServer` | 启动时读入，ETag + 304 |
| 标题抓取 | `TitleFetcher`（10 分钟） | 到期自然淘汰 |
| 规则正则 | `UaFilter` | 规则增删改时 reload |

缓存 TTL 30 秒意味着「改完链接最多 30 秒生效」——写操作会主动失效，所以实际是立刻生效。TTL 只是多进程部署时的兜底。

## 数据模型

```sql
groups(id, name UNIQUE COLLATE NOCASE, color, note, created_at, updated_at)
links(id, code UNIQUE, url, title, note, tags, status, password,
      clicks, created_at, updated_at, last_click_at, expire_at,
      group_id,      -- 软引用分组，删分组只置空，不删链
      deleted_at,    -- 非空表示在回收站
      status_before_expire)  -- 过期被自动停用前的状态，续期时按它还原
click_daily(code, day, clicks)        -- 每日点击
click_refs(code, host, clicks)         -- 来源域名
click_agents(code, platform, clicks)   -- 平台分布
click_countries(code, country, clicks) -- 访客地区，来自反向代理写入的国家码
click_slots(code, dow, hour, clicks)   -- 访问时段，星期(0=周日) × 小时
landing_views(code, day, host, views)  -- 建页曝光，按天、按渠道。和点击分开两张表
reports(id, code, reason, note, ip, ua, status, created_at, handled_at, handled_by)  -- 举报
-- links 上另有 v8 加的四列：
--   interstitial(0/1)      是否走跳转前建页，创建时按站点默认值落定
--   landing_theme          auto / dark / light
--   interstitial_note      建页上的一句话说明
--   qr_style               这条短链记住的二维码样式（JSON 或空串）
link_history(id, link_id, code, action, actor, snapshot, created_at)  -- 变更历史快照
link_targets(id, link_id, url, label, weight, regions, enabled, clicks, created_at, health_*)  -- 分流目标
settings(key, value)
admins(id, username, password_hash, created_at, last_login_at)
api_keys(id, name, prefix, hash, scope, enabled, …)
ua_rules(id, kind, pattern, note, enabled, hits)
audit_log(id, at, actor, action, detail, ip)
schema_meta(key, value)                -- 迁移版本
```

统计表用 `(code, day)` / `(code, host)` 复合主键 + `ON CONFLICT DO UPDATE` 做增量累加，避免读-改-写。

SQL dump 的表名从 `sqlite_master` 现取，不写死清单——原先那张手写清单在加 `groups` 时漏了它，
加 `click_slots` 时又会漏。索引与触发器也一并导出：只 dump 表结构的话恢复出来的库虽能读，
但短码 `NOCASE` 唯一索引、健康与分组索引全没了，「能跑」和「一样」是两件事。

迁移用 `schema_meta.version` 线性推进，每步在 `BEGIN IMMEDIATE` 事务里执行，失败回滚。版本高于程序支持时直接拒绝启动，防止旧程序写坏新库。

### v3：短码不区分大小写

`/abc` 和 `/ABC` 在用户眼里是同一个短码（浏览器、聊天工具都可能改大小写），所以判重一直用 `NOCASE`。但早期只在应用层判，批量入口——YOURLS 导入、JSON 备份恢复——绕过 service 直接写库，于是库里能同时存在 `/abc` 与 `/ABC`，`SELECT ... WHERE code = ?` 只认其中一个，另一条永远跳不过去。

v3 把这条业务规则下沉成数据库约束：

```sql
CREATE UNIQUE INDEX idx_links_code_nocase ON links(code COLLATE NOCASE);
```

建索引前先收敛存量重复：按 `created_at, id` 排序保留最早的那条（它也是当初印在物料上的拼写），其余依次改名 `code-2`、`code-3`，并同步迁移 `click_daily` / `click_refs` / `click_agents` 的计数行。改名会写一条 `link.code_dedupe` 审计，detail 形如 `ABC->ABC-2`，方便事后找回来改印刷品。

有了约束，upsert 也要跟着写全，否则 SQLite 匹配不到索引：`ON CONFLICT(code COLLATE NOCASE) DO UPDATE ...`。

### v5：分流目标与地区统计

新增两张从表，不动 `links`：

```sql
CREATE TABLE link_targets (id, link_id, url, label, weight, regions, enabled, clicks, created_at, health_*);
CREATE TABLE click_countries (code, country, clicks);   -- WITHOUT ROWID，(code, country) 主键
```

`link_targets` 里也放了一份 `health_*` 字段（和 `links` 同名同义），巡检时按 `link_targets.id` 回写，
管理台就能同时看到「主目标正常、B 版已死」这种状态。

备份导出时 `link_targets` 带上 `code` 而不是只带 `link_id`：id 是本机自增主键，换台机器（或 replace
恢复重建了 `links`）就对不上了，短码才是跨机器稳定的标识。恢复时按短码找 `link_id`，先清掉备份里
出现的那些短链的目标再插——`merge` 模式不该动到本地其它链的分流配置。

顺带收敛了一处一直靠人记的约定：彻底删除散落在四处的「purge 三张统计表」收成 `store.purgeLinkData(code)`。
加表以后每处都得记得补两行，漏一处就是孤儿数据，这种一致性不该靠记忆。

### v6：访问时段

```sql
CREATE TABLE click_slots (code, dow, hour, clicks);   -- WITHOUT ROWID，(code, dow, hour) 主键
```

`click_daily` 只按天存，回答不了「这批物料在哪些时段真的有人点」。粒度取「星期几 × 小时」：
24 条只能看一天，7×24 才能分出工作日与周末，168 个桶又小到可以随便存。

时段在 `ClickCounter.hit()` 里就落桶（`dow * 24 + hour`），和点击数一起批量刷盘——跳转热路径上
只多一次 `getDay()/getHours()`，仍然不碰磁盘。用**服务器本地时区**：这张图回答的是运营者
所在时区的问题，存 UTC 只会让人对着热力图算时差。

历史数据补不回来，也不从 `click_daily` 猜——表里没有的桶就是没有数据，界面上要让「没记录」
和「这个时段确实没人点」可区分。

全站聚合和别的统计口径一致，排除回收站里的短链：

```sql
SELECT dow, hour, SUM(clicks) FROM click_slots
WHERE code NOT IN (SELECT code FROM links WHERE deleted_at IS NOT NULL)
GROUP BY dow, hour
```

`store.hourMatrix()` 把行摊成 7×24 的扁平数组（缺的补 0）再交给前端，顺便算出峰值与合计，
前端不用自己补零，也不用为了一个峰值把 168 个数再遍历一遍。

### v10：续期要知道「过期前是什么状态」

```sql
ALTER TABLE links ADD COLUMN status_before_expire TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_links_expire ON links(expire_at);
```

两件事挤在一步迁移里，理由都是「续期得知道原样」：

- **状态还原**：过期停用会把 `status` 改成 `disabled`，原值就没了。续期时无法区分
  「本来就手动停用」和「过期被自动停用」，只能一律改回 `active`——等于替管理员
  把他自己关掉的链接打开了。`status_before_expire` 存下原值，续期按它还原；
  空串表示「不是被过期清扫停用的」，那就别动状态。
- **到期索引**：`expiringLinks()` 与列表的 `expiring` 筛选都是
  `expire_at BETWEEN now AND now+N`，没有索引就是每次全表扫。

`status_before_expire` 只在 `sweepExpired()` 里写，续期时清空——
一次性的事实，用完即弃，不需要额外的状态机。

### v9：建页曝光与举报

```sql
CREATE TABLE landing_views (code, day, host, views);  -- WITHOUT ROWID，(code, day, host) 主键
CREATE TABLE reports (id, code, reason, note, ip, ua, status, created_at, handled_at, handled_by);
```

建页曝光**必须**和 `links.clicks` 分开存，理由不是性能而是口径：把「看了一眼介绍页」
记成一次点击，从建页上线那天起，这个站所有短链的历史点击数就和以前的不可比了。
`ClickCounter` 里也对应分成两个桶（`buffer` 与 `views`），落库各走各的 upsert。

三个刻意的边界：

- **渠道只按短链聚合，不按天对**。`click_daily` 是 `(code, day)`，没有 `host`——
  它记不下「这一天这条链的点击来自哪几个渠道」。硬把两张表按日期拼起来只能造出一个
  看似精确的假数字。所以漏斗是「这条短链累计：某渠道曝光 N 次、落地 M 次」，
  日期维度只留给概览里的「今天新增曝光」。
- **落点率的分母为 0 时返回 `null` 而不是 0**。「没有曝光」和「曝光了但一次没点」
  是两件不同的事，界面上一个是「—」一个是「0%」。
- **比例超过 100% 不截断**。曝光从建页打开那天开始记，落地侧还含着之前的点击，
  于是早期数据会出现 130%。截成 100% 会把这个事实藏起来，界面用 `*` 标出来并写清原因。

举报用独立的 `reports` 表，短码是软关联（不带外键）：短链被彻底删除后举报要留着，
否则「有人投诉过」这件事会凭空消失。`listReports` 用 `LEFT JOIN` 就是为了这个。
举报**不自动停链**——自动停等于把「谁能打掉一条链接」交给匿名访问者。
同 IP 同短码 24 小时一条，节流在内存 `ReportBox.recent`，够用且不用为它建表。

跳转前建页的组织级配置（组织名 / Logo / 免责声明 / 倒数秒数）放在 `settings`，
不放到 `links`：一处设好全站共用，逐条填必然不一致，也没人会填第二遍。
`landingLogoUrl` 走白名单校验（站内绝对路径或 http(s)），因为它会被直接拼进
`<img src>`——放过 `javascript:` 就等于给建页开了一个注入口子。

### v11：账号从「一个管理员」变成「几个人」

```sql
ALTER TABLE admins ADD COLUMN role       TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE admins ADD COLUMN created_by TEXT NOT NULL DEFAULT '';
ALTER TABLE admins ADD COLUMN disabled_at INTEGER;
```

装完只有一个 `admin`，那是够用；一旦有人要「看数据但别动配置」，就只有两条路：
把密码给出去，或者不给。前者等于权限失控，后者等于让人天天截图来问。

**角色只分两档：`owner` 和 `viewer`。** 中间那档「能改短链但不能改系统设置」听着
合理，实际问题在边界：能改短链就能把目标地址改到别处去——那已经是最高权限了。
所以线画在「能不能写」上，能被一句话讲清，也不会用着用着长出第三种解释。
不认识的 `role` 值一律按 `viewer` 处理，唯一安全的降权方向。

写权限**在 `api()` 包装层统一拦**，不逐个路由判断。逐路由判就得每加一个写接口都
想起来加一次，漏掉的那个不会报错，只会安静地允许只读账号改东西。
`/admin/api/me` 与改自己密码走 `apiUnscoped`——只读账号也必须能改自己的口令。

`verifySession` 每个请求都回库读 `role` 和 `disabled_at`，不信 Cookie 里的值。
无状态 Cookie 发出去就收不回来，而「把某人降成只读」必须立刻生效，不能等 Cookie 过期。

三个保护：

- **最后一个 owner 不能被降级、停用或删除**。否则没人能再进账号页，只能回来改数据库。
  命令行留了一条路：`highurl admin reset --username x --password y`。
- **停用不是删除**。账号还在、审计日志的操作人还挂得住，随时能再打开。
  停用后旧会话立即失效（同上，每请求查库）。
- **停用的登录提示和密码错误完全一致**。同一个回复、同一句话，不确认用户名是否存在。

前端在 `/admin/api/me` 拿到 `readonly` 后给 `body` 加 `readonly-account`，
会写的按钮统一标 `data-writes` 由 CSS 置灰。这只是提前告知，不是权限——
真正的闸在服务端。服务器返回的 403 没人想靠点击去发现。

## 渠道漏斗为什么能下钻到短链

按渠道看「曝光 4170、落地 851」之后，下一个问题一定是「哪个渠道的哪条链在漏」。
所以点渠道名就地展开，列出这个渠道下的短链，按「没进去」倒序——人多却没往下走的排最前。

**下钻时曝光和落地两边都按同一个 `host` 过滤。** 只过滤一边会造出一个看着精确、
实际错的落点率：分子是这条链在所有渠道的落地数，分母是它在这个渠道的曝光数，
算出来能超过 100%。这类错误最难发现，因为界面上它长得很正常。

就地展开而不跳页，是因为复盘时答案要和问题同屏——点进去再点回来，人就不看了。

## 备份恢复为什么收进一个 service

管理台的 `/admin/api/restore` 和命令行的 `highurl restore` 早期是两份实现，结果各自漏东西：

- 管理台恢复了短链和统计，**但没恢复 `groups` 表**。短链上挂着 `group_id=1`，而本机分组表是空的，
  「先校验分组存在性」这一步就把所有 `group_id` 归零了——备份里明明有分组，恢复完一条分组关系都没有
- 命令行恢复了分组，却漏了 `link_targets`、`click_countries`、`ua_rules`

同一件事写两遍就会这样分叉，而且分叉是静默的：两边都返回「恢复成功」。

现在两个入口都调 `services/restore.js`，顺序是**分组 → 短链 → 分流目标 → 统计**，
反了外键关系就落不下去。几条刻意的取舍：

- **分组按名字对齐**，不按 id。`groups.id` 是本机自增，换台机器就错位
- **站点设置默认不写回**。备份经常来自试验机，安静地把线上 `baseUrl` 改了，比「设置没恢复」严重得多
- **恢复前先预检**（`inspectBackup`），算出新增/覆盖/跳过各多少条，只读不写
- CSV 解析按 RFC 4180：引号、字段内逗号与换行都要认。`split(',')` 遇到备注里的逗号会让整行列错位，而错位是静默的

## 备份的完整性校验

导出时给每份 JSON 加一层 `manifest`：程序版本、库版本、来源主机、各类条数，以及对业务集合算的 sha256。

驱动力来自一个很具体的失败：合并恢复的语义是「备份里有的就写进去」，所以文件缺了一截不会报错——
缺掉的那半被当成「不需要恢复」，接口照样返回 `{"ok":true,"restored":8}`。这种失败半年后才会以
「统计怎么少了一半」的形式出现，届时已经无从追查。

于是把「文件本身可信吗」和「内容怎么落地」拆成两个问题：

- `services/backup.js` 只负责 `buildBackup` / `verifyBackup` / `listBackups`，不写库
- `services/restore.js` 在动数据前先问一句 `verifyBackup`，`mismatch` 默认拦下

三种结论必须分开，不能合并成布尔值：

| 状态 | 依据 | 默认行为 |
| --- | --- | --- |
| `ok` | checksum 对得上 | 放行 |
| `mismatch` | 有 checksum 但对不上 | 拒绝，除非 `force` |
| `legacy` | 没有 checksum（早期备份） | 放行，但界面标明「无法确认内容一致」 |

把 `legacy` 当成 `ok` 是最省事也最坏的选择：它会让「无法确认」悄悄变成「确认没问题」，
而这正是校验和要解决的那类问题。

校验范围刻意包含 `settings`。理由不是「设置重要」——它默认根本不恢复——而是**改动过的文件
和打包时的不一样**这件事本身要能被发现。少算一类集合，就多一条「改了但验不出来」的口子。

自动备份的写入也改成 `xxx.json.tmp` → `rename`。轮转和灾难恢复最先拿的都是「今天那份」，
把一个写了一半的 JSON 顶在这个位置上，等于把最需要它的时候变成最不能用它的时候。

**校验名单分两层，是为了不误伤老备份。** `CHECKED` 是一份冻结的契约：往里加一项，
之前导出的所有备份都会一次性变成「校验不通过」——把好好的备份判成损坏，比少校验一类数据糟得多。
后加的集合并进 `EXTRA`（`click_slots`、`link_history`、`landing_views`、`reports`），
只在 manifest 里也带了对应摘要时才核对，老文件按它自己带的算。

## 安全设计

| 风险 | 措施 |
| --- | --- |
| 密码存储 | scrypt(N=16384, r=8, p=1)，每个密码独立 salt |
| 会话 | HMAC-SHA256 签名 Cookie，无服务端 session 表；`HttpOnly` + `SameSite=Lax` |
| CSRF | 写接口校验 `Origin` 与 `Host`；非浏览器客户端无 Origin 则跳过 |
| API Key | 只在创建时明文返回，库里存 SHA-256；支持读/写 scope 与停用 |
| SSRF | 抓标题前解析 DNS，拒绝私有网段、回环、链路本地地址；跟随跳转时二次校验 |
| ReDoS | 规则正则长度截断，编译失败降级为字面量匹配 |
| 暴力破解 | 登录失败写审计日志；全站令牌桶限流 |
| XSS | 服务端渲染统一走 `escapeHtml`，前端 SPA 使用 `textContent` |
| SQL 注入 | 全部预编译绑定参数，动态条件只拼白名单字段名 |

## 为什么是 SQLite

短链接的读写比大概是 1000:1，写还是「攒批」的。SQLite 的 WAL 模式支持单写多读并发，一次批量事务写入几千次点击是毫秒级的事。

瓶颈从来不在数据库，而在于「每次点击都要落盘」这个错误设计。

如果确实需要多实例：把 `data/` 放共享存储（NFS 有风险）或改用 PostgreSQL——但那时候你大概更需要的是 CDN 缓存跳转，而不是更强的数据库。

## 前端

没有构建步骤。原生 ES 模块 + hash 路由的小 SPA：

```
public/static/admin.js   管理台（概览 / 短链 / 分组 / 来源 / 新建 / UA 屏蔽 / 迁移 / 密钥 / 审计 / 备份 / 回收站 / 设置）
public/static/landing.js 落地页的即时缩短
public/static/app.css    CSS 变量驱动的深色设计系统
```

服务端只输出一个管理台外壳（`src/pages/admin.js`），内容由前端渲染。这样做的好处是：改界面不用重启进程，只刷浏览器。
