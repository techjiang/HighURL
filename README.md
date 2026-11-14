<div align="center">

<img src="public/img/logo-256.png" width="112" alt="HighURL">

# HighURL

**把长链接剪短、提速、管起来。**

自托管短链接系统 · 零运行时依赖 · 单文件 SQLite · 一个容器就能跑

[![version](https://img.shields.io/badge/version-v1.0.0-8b5cf6)](https://github.com/techjiang/HighURL/releases)
[![node](https://img.shields.io/badge/node-%E2%89%A522.5-22d3ee)](https://nodejs.org)
[![deps](https://img.shields.io/badge/runtime%20deps-0-5b8bff)](package.json)
[![tests](https://img.shields.io/badge/tests-467%20passed-22c55e)](test)
[![license](https://img.shields.io/badge/license-MIT-8b5cf6)](LICENSE)

</div>

> 作者：科技酱 · 同一个世界，同一个互联网！
>
> - 科技酱：<https://www.asoe.cn>
> - 技术文档（博客）：<https://docs.asoe.cn>
> - GitHub：<https://github.com/techjiang/>
> - 哔哩哔哩：<https://space.bilibili.com/1768832152>
> - 邮箱：official@tech.asoe.cn
> - 玲珑：<https://forums.asoe.cn/>
> - QQ 群：291974598 ｜ ② 474819022 ｜ ③ 631167288

## 看一眼

<div align="center">

![落地页](docs/screenshots/landing.png)

</div>

<div align="center">

| 管理台概览（含分组分布） | 短链列表（支持批量操作） |
| --- | --- |
| ![概览](docs/screenshots/dashboard.png) | ![短链](docs/screenshots/links.png) |

| 分组 | 回收站 |
| --- | --- |
| ![分组](docs/screenshots/groups.png) | ![回收站](docs/screenshots/trash.png) |

| 各分组的活跃时段（7×24，按分组色） | 短链名片 `/<短码>+` |
| --- | --- |
| ![分组活跃时段](docs/screenshots/groups-hours.png) | ![短链名片](docs/screenshots/link-preview.png) |

| 来源分析（含访问时段） | 批量操作 |
| --- | --- |
| ![来源分析](docs/screenshots/sources.png) | ![批量操作](docs/screenshots/links-batch.png) |

| 单链统计（时段热力图 · 分流命中） |
| --- |
| ![单链统计](docs/screenshots/stats-hours.png) |

| 本期要点（概览顶部） | 热点榜（最近 24 小时） |
| --- | --- |
| ![本期要点](docs/screenshots/digest.png) | ![热点榜](docs/screenshots/hot.png) |

| 热度筛选（短链列表） | 单链统计（曝光 / 落点率） |
| --- | --- |
| ![热度筛选](docs/screenshots/links-heat.png) | ![单链统计](docs/screenshots/link-stats-views.png) |

| 审计日志 | 系统设置 |
| --- | --- |
| ![审计日志](docs/screenshots/audit.png) | ![设置](docs/screenshots/settings.png) |

| 死链巡检（健康占比 / 失败原因） | 数据自检（孤儿统计 / 短码冲突） |
| --- | --- |
| ![死链巡检](docs/screenshots/links-health.png) | ![数据自检](docs/screenshots/doctor.png) |

| 事件通知（渠道 / 投递记录） | 新建渠道（事件订阅 / 签名） |
| --- | --- |
| ![事件通知](docs/screenshots/notify.png) | ![新建渠道](docs/screenshots/notify-modal.png) |

| 事件通知（手机） |
| --- |
| ![事件通知移动端](docs/screenshots/notify-mobile.png) |

| 二维码下载（单条 / 批量） | 拼版打印（A4 网格 PDF） |
| --- | --- |
| ![二维码](docs/screenshots/qr-modal.png) | ![拼版打印](docs/screenshots/qr-sheet.png) |

| 二维码样式（颜色 / 渐变 / 圆点 / 透明底） | 透明底贴纸 |
| --- | --- |
| ![二维码样式](docs/screenshots/qr-style.png) | ![透明底](docs/screenshots/qr-transparent.png) |

拼版打印同样吃这套样式，印出来就是这个样子（品牌渐变 / 圆点）：

| A4 三列 · 品牌渐变 | 圆点样式放大看 |
| --- | --- |
| ![拼版成品](docs/screenshots/qr-sheet-print.png) | ![圆点拼版](docs/screenshots/qr-sheet-dots.png) |

| 变更历史与回滚（改坏了能退回去） | 和「现在」逐字段对比 |
| --- | --- |
| ![变更历史](docs/screenshots/link-history.png) | ![版本对比](docs/screenshots/history-diff.png) |

| 分流目标（A/B + 按地区） | 目标命中分布 |
| --- | --- |
| ![分流目标](docs/screenshots/targets-editor.png) | ![目标命中](docs/screenshots/targets-stats.png) |

| 备份恢复（自动备份带完整性状态） | 校验不通过时拦下来 |
| --- | --- |
| ![备份恢复](docs/screenshots/backup.png) | ![校验不通过](docs/screenshots/backup-checksum.png) |

| CSV 导入（分组按名字接回去） | 到期续约（批量 / 单条 / 永久） |
| --- | --- |
| ![CSV 导入](docs/screenshots/csv-import.png) | ![批量续期](docs/screenshots/renew-batch.png) |

| 即将到期（三天内直接在行上标出来） | 单链统计里的有效期与「续期」 |
| --- | --- |
| ![即将到期](docs/screenshots/links-expiring.png) | ![单链到期](docs/screenshots/link-expiry.png) |

</div>

手机上也一样能用，窄屏下表格自动折成卡片：

<div align="center">

| 概览 | 短链 | 分组 |
| --- | --- | --- |
| ![移动端概览](docs/screenshots/mobile-dashboard.png) | ![移动端短链](docs/screenshots/mobile-links.png) | ![移动端分组](docs/screenshots/mobile-groups.png) |

| 续期 | 回收站 | 来源分析 |
| --- | --- | --- |
| ![移动端续期](docs/screenshots/mobile-renew.png) | ![移动端回收站](docs/screenshots/mobile-trash.png) | ![移动端来源](docs/screenshots/mobile-sources.png) |

| 回收站 | 来源分析 | 审计日志 |
| --- | --- | --- |
| ![移动端回收站](docs/screenshots/mobile-trash.png) | ![移动端来源](docs/screenshots/mobile-sources.png) | ![移动端审计](docs/screenshots/mobile-audit.png) |

| 死链筛选 | 落地页 | 系统设置 |
| --- | --- | --- |
| ![移动端死链筛选](docs/screenshots/mobile-links-health.png) | ![移动端落地页](docs/screenshots/mobile-landing.png) | ![移动端设置](docs/screenshots/mobile-settings.png) |

| 分流目标（窄屏折行，不横向溢出） | 备份恢复 | 数据迁移 |
| --- | --- | --- |
| ![移动端分流目标](docs/screenshots/mobile-targets.png) | ![移动端备份](docs/screenshots/mobile-backup.png) | ![移动端迁移](docs/screenshots/mobile-migrate.png) |

| 备份校验不通过（窄屏也一样看得见） | 版本对比（窄屏折成两行） |
| --- | --- |
| ![移动端校验](docs/screenshots/mobile-backup-checksum.png) | ![移动端版本对比](docs/screenshots/mobile-history-diff.png) |

| 分组活跃时段（一格一张卡片） | 短链名片 |
| --- | --- |
| ![移动端分组活跃时段](docs/screenshots/mobile-groups-hours.png) | ![移动端短链名片](docs/screenshots/mobile-link-preview.png) |

| 热点榜（窄屏折行，不为「多久之前」挤掉标题） | 本期要点（数值换行到第二行） |
| --- | --- |
| ![移动端热点榜](docs/screenshots/mobile-hot.png) | ![移动端本期要点](docs/screenshots/mobile-digest.png) |

跳转前建页：目标域名是这页唯一的主角，按钮只有「继续访问」。

![建页 · 暗色](docs/screenshots/landing-dark.png)

| 建页 · 亮色主题 | 过期 / 停用时说清原因 |
| --- | --- |
| ![建页 · 亮色](docs/screenshots/landing-light.png) | ![建页 · 过期](docs/screenshots/landing-expired.png) |

编辑弹窗里的建页设置，以及二维码样式「记住在短链上」：

| 建页开关与主题 | 二维码样式跟随短链 |
| --- | --- |
| ![建页设置](docs/screenshots/edit-landing.png) | ![二维码样式](docs/screenshots/qr-style-saved.png) |

| 移动端建页（390 宽） | 移动端建页 · 亮色 |
| --- | --- |
| ![移动端建页暗色](docs/screenshots/landing-mobile-dark.png) | ![移动端建页亮色](docs/screenshots/landing-mobile-light.png) |

建页带组织级配置：一处设好，全站共用。页头换成组织名，底部一段免责声明，按钮下给一句倒数提示（**不会自动跳走**）：

| 建页 · 组织配置（暗色） | 建页 · 组织配置（亮色） |
| --- | --- |
| ![建页组织配置暗色](docs/screenshots/landing-org-dark.png) | ![建页组织配置亮色](docs/screenshots/landing-org-light.png) |

渠道漏斗：曝光与落地分开记，零落地渠道会被标出来：

| 渠道漏斗 | 举报箱 |
| --- | --- |
| ![渠道漏斗](docs/screenshots/funnel-desktop.png) | ![举报箱](docs/screenshots/reports-desktop.png) |

渠道名点开就地看到短链：哪条链在这个渠道里没把人带进去，按「没进去」倒序排：

| 展开下钻（就地，不跳页） | 按「没进去」排出来的落点率 |
| --- | --- |
| ![漏斗下钻](docs/screenshots/funnel-drill.png) | ![下钻收起的渠道](docs/screenshots/funnel-drill-collapsed.png) |

账号页：两档角色，操作都在行尾。最后一个管理员动不了，停用的账号灰着但留着：

| 账号与角色 | 只读账号看到的概览 |
| --- | --- |
| ![账号](docs/screenshots/accounts.png) | ![只读概览](docs/screenshots/readonly-dashboard.png) |

只读账号能看能导，会写的按钮先置灰——不用点一下才知道自己没权限：

![只读短链页](docs/screenshots/readonly-links.png)

名片页底部的举报入口，展开就能提交（这页没有任何脚本，用 `<details>` 就够）：

![名片页举报入口](docs/screenshots/preview-report-desktop.png)

| 移动端渠道漏斗 | 移动端举报箱 | 移动端建页 |
| --- | --- | --- |
| ![移动端渠道漏斗](docs/screenshots/funnel-mobile.png) | ![移动端举报箱](docs/screenshots/reports-mobile.png) | ![移动端建页](docs/screenshots/landing-org-mobile.png) |

| 移动端漏斗下钻 | 移动端账号（折成卡片，每列带标签） |
| --- | --- |
| ![移动端下钻](docs/screenshots/mobile-funnel-drill.png) | ![移动端账号](docs/screenshots/mobile-accounts.png) |

</div>

## 为什么又一个短链接

大部分自托管短链接项目要么是 PHP 全家桶，要么塞一堆中间件。HighURL 的取舍很简单：

- **只依赖 Node.js 22.5+**，SQLite 用内置 `node:sqlite`，`npm install` 都不用跑
- **跳转走内存**：点击先累加在内存，定时批量单事务落库，跳转路径不碰磁盘
- **备份即文件**：整个系统就是一个 `data/` 目录，拷走就能换机器
- **界面不将就**：暗色玻璃拟态设计，桌面和手机都能用

## 功能特点

| 功能 | 说明 |
| --- | --- |
| 短链生成 | 自定义短码 / 自动生成，支持有效期、备注、标签 |
| 链接管理 | 搜索、状态过滤、标签筛选、分组筛选、排序、分页、CSV 导出 |
| 分组归类 | 按项目 / 活动 / 团队归堆，带颜色与条数统计；删分组不删链 |
| 批量操作 | 跨页勾选后一键启用 / 停用 / 删除 / 改分组 / 改标签，单次最多 500 条；标签支持合并、覆盖、清空 |
| 回收站 | 删除先进回收站，可单条或批量恢复；短码继续占位，不会被抢注 |
| 审计日志 | 登录、增删改、分组变更、回收站操作、备份恢复全部留痕，可分页与按动作过滤 |
| 延迟计数 | 跳转只写内存 Map，默认每秒批量落库一次 |
| 点击去重 | 同 IP 对同一短链在窗口内只计一次，防刷量也防手抖，跳转行为不受影响 |
| 标题抓取 | 自动读取目标页 `og:title` / `<title>`，带 SSRF 防护 |
| UA 屏蔽 | 关键字、通配符、正则三种规则，UA 和 IP 都能挡 |
| 密码保护 | 单条短链加访问密码，解锁后 1 小时内免重复输入 |
| 子路径透传 | `/abc/docs/intro?x=1` → `目标地址/docs/intro?x=1` |
| 统计 | 点击趋势、来源域名、平台分布、访客地区、全站概览 |
| A/B 分流 | 一个短码挂最多 8 个目标，按权重随机命中；每个目标单独记命中数，能看实际分成什么样 |
| 按地域跳转 | 目标可绑定地区码（`CN`、`JP,HK,TW`），地区命中的优先，其余走全球目标；地区来自反向代理写入的 `CF-IPCountry` / `X-Country-Code` |
| 来源分析 | 独立页面看近 30 天 referrer 站点 Top 30、访问平台分布、访客地区分布、直接访问占比，可导出 CSV |
| 访问时段 | 星期 × 小时的热力图，一眼看出哪几天哪个时段流量最密；概览、来源页、单链统计、分组页都有，最忙的那一格直接写成文字 |
| 本期要点 | 概览顶部一段话把「跟昨天比怎么样、哪几件事等人处理」列出来，每条点进去就是对应页面；只报变化和异常，点击太少时不判涨跌 |
| 热点榜 | 最近 24 小时新增点击最多的短链，带窗口内曝光与实际落点，同时给条数和相对比例；累计榜看不出「现在什么在被点」，这里看的是增量 |
| 热度筛选 | 短链列表可按「热门 / 有热度」筛，按全库最高点击数的比例分档而不是绝对值；排序里多了「最近 24 小时热度」 |
| 分组统计 | 分组页看每组近 14 天每日点击的迷你柱状图，一眼知道哪块流量在跑 |
| 分组活跃时段 | 分组页再往下，每个分组一张 7×24 热力图并按分组色着色：哪个项目的人在工作日上午来、哪个活动是周末夜里起量，不用自己对着两张图算 |
| 实时访问 | 概览页滚动显示最近访问的短码、来源、平台、脱敏 IP，SSE 推送；连不上自动退回轮询 |
| 跳转前建页 | 开启后访问 `/abc` 先落在一张自动生成的介绍页：目标域名大字打头、标题、剩余有效期、附加说明，点「继续访问」才跳。目标地址不写进任何链接，预取 / 扫描 / 收藏转发都不会顺手把人带走；停用与过期的链在这页上说清原因而不是一屏 404；密码保护的链仍要先过密码；三种主题（跟随系统 / 暗色 / 亮色），站点可设新建默认值 |
| 短链名片 | 在短链后面加个 `+`（`/abc+`）就能看到目标地址、二维码、分组标签与点击量，跳过去之前先确认这条链到底指向哪；名片页不计数、不被搜索引擎收录，密码保护的链不露出目标 |
| 渠道漏斗 | 建页曝光与落地分开记，按 referrer 渠道算落点率；只有曝光没有落地的渠道单独标出。曝光不算点击，建页上线不会让历史点击数变得不可比 |
| 渠道漏斗下钻 | 点渠道名就地展开这个渠道下的短链，按「没进去」倒序——人多却没往下走的排最前。曝光和落地两边按同一个渠道过滤，不混口径 |
| 多账号与角色 | 管理员可以开子账号，角色只有两档：管理员能写，只读能看。最后一个管理员不会被降级、停用或删除；停用账号旧会话立刻失效；命令行 `highurl admin reset` 留了后路 |
| 建页组织配置 | 组织名、Logo、免责声明、倒数提示一处设好全站共用，不用逐条填。Logo 只接受站内路径与 http(s)；倒数只是提示，页面不会自动跳走 |
| 举报箱 | 名片页 `/<短码>+` 上可以提交举报（垃圾 / 钓鱼 / 恶意软件 / 违法 / 其它），进管理台队列由人核对，**不会自动停链**；同 IP 同短链一天一条，IP 只留网段 |
| 死链巡检 | 按间隔探测目标地址，连续两次失败才判定死链；概览页看健康占比，死链一键筛出 |
| 到期续约 | 单条或批量续期：往后推 N 天、统一改到一个日期、或设为永久有效。只动有效期一个字段，不会顺手覆盖别人刚改的标题和标签；过期后被自动停用的会恢复成过期前的状态，而本来就手动停用的保持停用 |
| 即将到期 | 列表按「7 天内 / 30 天内 / 已过期」筛，三天内到期的行直接挂一枚 `N 天后到期`；概览「本期要点」把 7 天内到期的条数算进待处理项，点进去就是筛好的列表；`highurl expiring` 在终端里也能看 |
| 过期回收 | 短链过期后按策略自动停用或删除，宽限期内还能救回来；也可手动一键回收 |
| 回收站清理 | 可设置保留天数，到期自动彻底删除；默认 0 表示一直留着等人工处理 |
| 二维码 | 每条短链实时生成二维码，可下载 SVG / PNG；批量打包成 ZIP（内含 `qr/<短码>.png` 与 `codes.csv` 对照表），单次上限 1000 条 |
| 二维码样式 | 码点颜色、双色渐变、方点 / 圆角 / 圆点、透明底、纠错等级 L/M/Q/H 都能调，内置 5 套预设；对比度不够或反色时给提示；样式可以「记住在短链上」——换台设备打开还是这套，物料印的和下次导出的不会对不上；**单条、批量 ZIP、拼版 PDF 三处共用同一套样式** |
| 拼版打印 | 把当前筛选结果或勾选条目排成 A4 / Letter 网格并导出 PDF，直接送印或贴物料；二维码矢量绘制（方块按行合并、圆点走贝塞尔圆），放大不糊，颜色与渐变都落到纸上 |
| 数据迁移 | 直接解析 YOURLS 的 MySQL dump，短码和点击数原样保留；也认本系统导出的 CSV，分组按名字接回去 |
| SQL 备份 | `.sql.gz` 从库里现取表名导出全部表与索引，`gunzip -c x.sql.gz \| sqlite3 新库.db` 直接得到一个结构完整的库 |
| 开放 API | Bearer Token，读/写权限分离，会话也能调 |
| 备份恢复 | JSON 全量备份带 manifest（版本 / 来源主机 / 校验和，后加的集合单独一份摘要，老备份不会被误判为损坏）、SQL dump、CSV 导出；恢复前先预检并核对校验和，对不上默认拒绝；恢复时把分组、分流目标、四类统计、屏蔽规则一起带回来；每天自动备份保留 14 份，界面上能直接看每份文件完整不完整 |
| 变更历史 | 改短链、改密码、删除、回滚前都留一版快照，能看某条短链当时长什么样，也能一键回滚到任意一版；回滚前再记一版，滚错还能滚回来；默认每条留 20 版，条数可调，0 表示不留 |
| 版本对比 | 任一历史版本都能和「现在」逐字段对比：目标地址、标题、备注、标签、状态、分组、有效期、分流目标（按 URL 加删）；窄屏下折成上下两行带「这一版 / 现在」前缀 |
| 数据自检 | 一眼看孤儿统计、短码冲突、数据库版本，确认无误再一键清理 |
| 事件通知 | 死链、举报、即将到期、备份失败这四件事发生时，主动推到你手上，不用一直盯着管理台。支持通用 Webhook（带 HMAC 签名）、Slack、飞书、钉钉；同一件事在窗口内只推一次，到期提醒合成每日一条汇总；发失败按 5 秒、30 秒退避重试两次，三次都失败就留底等人看，不无限重试 |
| 静默时段 | 每个渠道可单独设一段不打扰的时间（如 22:00–08:00，跨夜直接写），期间通知先挂起不丢，结束后按渠道合成一条摘要补发；也可以选「直接不发」并留痕。备份失败这类等不得的事件可按事件穿透 |
| 定期摘要 | 每天（或每周一）到点把「本期要点」推一次：涨跌、落点率变化、待处理几件事，一段话看完，不用挨着页面点。内容和概览页那一段同源；默认关，开了才推；没点击也没待办时不打扰人；手动「立即推送一次」仍然遵守渠道订阅与静默时段 |
| 可观测 | `/health` 健康检查、`/metrics` Prometheus 指标，含去重跳过数 |
| 零依赖部署 | 单进程 + 单文件，无 Redis、无 MySQL、无构建步骤 |

## 性能

跳转路径全程不碰磁盘：链接走内存 LRU，点击先攒在内存，随后批量单事务落库。
本机（8 核、Node 26）实测：

| 场景 | QPS | p50 | p99 |
| --- | --- | --- | --- |
| 200 条短链 / 32 并发 | 10,992 | 2.65 ms | 4.80 ms |
| 200 条短链 / 32 并发，每条 3 个分流目标 | 9,514 | 3.00 ms | 6.42 ms |
| 200 条短链 / 128 并发 | 9,751 | — | 17.09 ms |
| 1000 条短链 / 128 并发 | 10,268 | — | 19.2 ms |

分流带来的开销就是上面那一行的差距：多一次内存数组遍历加一次加权抽签，
目标列表和短链记录一起缓存在内存里，热路径仍然不碰磁盘。

自己跑一遍：

```bash
node scripts/bench.js --links 200 --conns 32 --duration 10
node scripts/bench.js --links 200 --conns 32 --duration 10 --targets 3   # 带分流目标
```

## 快速开始

```bash
# 1. 启动（首次自动建库）
node src/cli.js serve --port 8080 --data ./data

# 2. 浏览器打开 http://localhost:8080/install 创建管理员
# 3. 或者命令行初始化
node src/cli.js init --username admin --password 'your-password' --base-url 'https://s.example.com'

# 4. 登录 /admin 开始创建短链
```

自检环境：

```bash
node src/cli.js doctor
```

## 用 Docker 跑

```bash
docker run -d --name highurl \
  -p 8080:8080 \
  -v $(pwd)/data:/data \
  -e HIGHURL_BASE_URL=https://s.example.com \
  --restart unless-stopped \
  ghcr.io/techjiang/highurl:latest
```

或者用 compose：

```bash
docker compose up -d
```

首次启动后打开 `/install` 建账号。

## 配置

优先级：**命令行参数 > 环境变量 > 管理台设置 > 默认值**。

常用环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HIGHURL_PORT` | `8080` | 监听端口 |
| `HIGHURL_HOST` | `0.0.0.0` | 监听地址 |
| `HIGHURL_DATA_DIR` | `./data` | 数据目录（DB、备份、密钥都在这里） |
| `HIGHURL_BASE_URL` | 空 | 站点公网地址，用于生成短链与 OG 图 |
| `HIGHURL_TRUST_PROXY` | `false` | 信任 `X-Forwarded-*`，反代后面必须打开；同时决定是否采信 `X-Country-Code` 这类地区头 |
| `HIGHURL_RATE_LIMIT` | `600` | 单 IP 每分钟请求上限 |
| `HIGHURL_SITE_NAME` | `HighURL` | 站点名称 |
| `HIGHURL_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

## API 一览

```bash
# 创建
curl -X POST https://s.example.com/api/v1/links \
  -H "Authorization: Bearer hu_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/very/long/link","code":"mylink","tags":["推广"]}'

# 查询 / 更新 / 删除
curl -H "Authorization: Bearer $TOKEN" https://s.example.com/api/v1/links?q=example&page=1
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"disabled"}' https://s.example.com/api/v1/links/mylink
curl -X DELETE -H "Authorization: Bearer $TOKEN" https://s.example.com/api/v1/links/mylink

# 统计
curl -H "Authorization: Bearer $TOKEN" https://s.example.com/api/v1/links/mylink/stats?days=30
curl -H "Authorization: Bearer $TOKEN" https://s.example.com/api/v1/stats
```

管理台侧的运营视图（会话鉴权）：

```bash
# 本期要点：窗口只接受整天，48 表示「近两天对比前两天」
curl -b 'highurl_session=...' https://s.example.com/admin/api/digest?hours=48

# 热点榜：最近 N 小时新增点击最多的短链，带窗口内曝光
curl -b 'highurl_session=...' https://s.example.com/admin/api/hot?hours=24&limit=8

# 列表按热度筛 / 按最近热度排
curl -b 'highurl_session=...' 'https://s.example.com/admin/api/links?heat=hot&sort=recent_desc'

# 即将到期：7 天内要失效的，按剩余时间升序
curl -b 'highurl_session=...' 'https://s.example.com/admin/api/expiring?days=7'

# 续期：往后推 30 天 / 改到某个日期 / 永久有效
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"days":30}' https://s.example.com/api/v1/links/mylink/renew
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"expireAt":"2027-01-31"}' https://s.example.com/api/v1/links/mylink/renew
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"expireAt":null}' https://s.example.com/api/v1/links/mylink/renew   # 永久
```

续期单独一个动词，不走 `PATCH {expireAt}`：PATCH 是全字段更新，只想延长期限的
调用方得先把整条记录读出来再写回去，中途别人改的字段就被覆盖了。

短链对象里带健康字段：`health`（`ok` / `warn` / `dead` / 空串表示没测过）、`health_code`、`health_at`、`health_error`。
`GET /api/v1/links?health=dead` 直接筛死链。`targetCount` 大于 1 表示这条开了分流。

分流目标读写（管理台会话或 Bearer Token 都行）：

```bash
# 读
curl -b 'highurl_session=...' https://s.example.com/admin/api/links/promo/targets

# 整组提交：语义是「提交后就是这样」，不在列表里的目标会被删掉
curl -X PUT -b 'highurl_session=...' -H 'Content-Type: application/json' \
  -d '{"targets":[
        {"url":"https://example.com/a","label":"A 版","weight":50},
        {"url":"https://example.com/b","label":"B 版","weight":50},
        {"url":"https://cn.example.com/","label":"中国大陆站","weight":100,"regions":"CN"}
      ]}' \
  https://s.example.com/admin/api/links/promo/targets
```

创建短链时也能直接带 `targets` 数组，一次把事说完。命中分流目标时跳转响应会多一个
`X-Highurl-Target: <目标 id>` 头，排查「为什么跳过去是另一个页面」时不用猜。

跳转前建页：

```bash
# 单条的建页配置跟着短链对象一起返回
curl -H "Authorization: Bearer $TOKEN" https://s.example.com/api/v1/links/promo
# → { ..., "landing": { "enabled": true, "theme": "dark", "note": "活动仅限本周" }, "qrStyle": {...} }

# 创建时直接打开（也可以给站点设默认值，让之后新建的都带上）
curl -X POST https://s.example.com/api/v1/links \
  -H "Authorization: Bearer hu_xxx" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/sale","code":"sale","landing":{"enabled":true,"theme":"auto"}}'

# 单独改，不用把目标地址、标题一起重新提交一遍
curl -X PATCH https://s.example.com/admin/api/links/sale/landing \
  -H "Authorization: Bearer hu_xxx" -H "Content-Type: application/json" \
  -d '{"enabled":true,"theme":"light","note":"仅限本周"}'

# 二维码样式记住在这条短链上（换台设备打开还是这套）
curl -X PUT https://s.example.com/admin/api/links/sale/qr-style \
  -H "Authorization: Bearer hu_xxx" -H "Content-Type: application/json" \
  -d '{"qrStyle":{"preset":"brand","dotStyle":"rounded","ecc":"M"}}'
```

### 事件通知

```bash
# 建渠道：kind 取 webhook / slack / feishu / dingtalk
curl -X POST https://s.example.com/admin/api/notify/channels \
  -H "Authorization: Bearer hu_xxx" -H "Content-Type: application/json" \
  -d '{"name":"运维群","url":"https://hooks.example.com/x","kind":"feishu",
       "events":["link.dead","backup.failed"],"secret":"shared-key"}'

curl https://s.example.com/admin/api/notify/channels   # 列表（不回传 secret）
curl -X POST https://s.example.com/admin/api/notify/channels/1/test   # 发一条测试
curl https://s.example.com/admin/api/notify/deliveries?limit=50       # 投递记录
curl -X POST https://s.example.com/admin/api/notify/deliveries/12/retry  # 手动重发
```

`events` 只认 `link.dead`、`link.expiring`、`report.new`、`backup.failed`、`digest.periodic`。
配了 `secret` 之后，每个请求带 `X-HighURL-Signature: sha256=<hmac>` 与
`X-HighURL-Timestamp`，签名内容是 `<timestamp>.<body>`，接收端按同样方式算一遍即可验签，
顺便拒绝时间戳过旧的请求防重放。举报通知只带短码与类型，**不带匿名正文**。

指向内网的地址默认会被拦下（防 SSRF）；接收端就在自己内网时，到设置里打开
「允许推送到内网」。

静默时段是渠道上的一对 `HH:MM`（服务器本地时间），`quiet.from > quiet.to` 表示跨夜，
两个值相同等于没设。`quiet.policy` 取 `digest`（默认，结束后合并补发一条）或 `drop`
（不发，但投递记录里留一条带原因的 `dropped`）；`quiet.pierce` 是静默期内照样放行的
事件列表。返回的渠道对象带 `quietActive`，直接告诉你此刻是不是静默中。

### 定期摘要

```bash
curl https://s.example.com/admin/api/digest/push        # 预览：下次推送时间 + 真正会发出去的那段文本
curl -X POST https://s.example.com/admin/api/digest/push # 立即推一次（不管到没到点）
```

频率、推送小时、统计窗口在设置里（`digestPushKind` = `off` / `daily` / `weekly`，
`digestPushHour` 0–23，`digestPushWindowDays` 1–30）。订阅了 `digest.periodic`
的渠道才会收到；周报只在周一推。终端里也能看：`highurl digest --days 7`，
加 `--push` 就顺带发一次。

`landing.theme` 只认 `auto` / `dark` / `light`，其它值会回落到 `auto` 而不是原样写库；
`qrStyle` 逐字段白名单校验，坏值直接 400，不会把一条短链的导出链路带坏。

响应统一为 `{"ok":true,"result":...}`，失败为 `{"ok":false,"error":{"code","message"}}`。
完整文档见站内 `/docs`。

## 命令行

```bash
highurl serve   [--port 8080] [--data /var/lib/highurl] [--trust-proxy]
highurl init    --username admin --password 'xxx' [--base-url https://s.example.com]
highurl backup  ./out.json                                  # 带 manifest 与校验和
highurl verify  ./out.json                                  # 只校验，不写数据
highurl restore ./out.json [--replace --yes] [--dry-run] [--with-settings] [--force]
highurl migrate yourls.sql [--overwrite] [--dry-run]   # 也认 .json 与 .csv
highurl stats
highurl expiring [--days 7] [--limit 200] [--code-only]   # 即将到期的短链
highurl digest [--days 1] [--push]                       # 运营摘要，--push 同时推一次
highurl doctor
```

`restore` 干跑会先把「新增几条、覆盖几条、带多少分组与统计」列出来，不动数据；
`--replace` 必须加 `--yes` 才真的执行——清库这件事不该被一个手滑的 Tab 完成。
备份里带 sha256 校验和，校验对不上默认拒绝恢复（合并模式会把「缺的那半」当成
「不需要恢复」静静跳过，然后报成功），确认文件没问题再加 `--force`。
默认不写回备份里的站点设置（`baseUrl` 之类的，从试验机带过来会出事），
要恢复就显式加 `--with-settings`。

## 按地域跳转怎么拿到地区

HighURL 不带 GeoIP 库——那玩意儿几十兆，还得按月更新，跟「零依赖、拷一个目录就走」是矛盾的。
所以地区来自**反向代理已经算好的国家码**，按这个顺序取：

| 来源 | 生效条件 |
| --- | --- |
| `CF-IPCountry` | 无条件采信。Cloudflare 会覆盖客户端传的值，可信 |
| `X-Country-Code` / `X-Geo-Country` | 需要开 `trustProxy`，否则客户端伪造一个头就能挑目标 |

取不到地区时，只有「全球目标」（不填地区）参与抽取；一条全球目标都没有，就跳默认目标——
地区识别失败不该让印在物料上的短链打不开。

Nginx 示意：

```nginx
location / {
  proxy_pass http://127.0.0.1:8080;
  # 有 GeoIP2 模块时自己写；没装就交给 CDN 或上游
  proxy_set_header X-Country-Code $geoip2_data_country_code;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

## 从 YOURLS 迁过来

```bash
# 1. 导出 YOURLS 数据库
mysqldump -u root -p yourls > yourls.sql

# 2. 先干跑看冲突
node src/cli.js migrate yourls.sql --dry-run

# 3. 正式导入（短码、点击数、创建时间都保留）
node src/cli.js migrate yourls.sql
```

也可以在管理台「数据迁移」页面上传，支持预览冲突条目。详见 [docs/migrate-yourls.md](docs/migrate-yourls.md)。

## 品牌资源

Logo 源文件在 `assets/`，都是纯 SVG、透明底，可以直接拿去印或改色：

| 文件 | 用途 |
| --- | --- |
| `assets/logo.svg` | 主标，双色渐变（紫 → 蓝 → 青） |
| `assets/logo-mono.svg` | 单色版，用 `currentColor`，跟随文字颜色 |
| `assets/logo-badge.svg` | 圆角底版本，适合头像、社交平台 |
| `assets/logo-maskable.svg` | 带安全区的版本，给 Android 自适应图标 |

改完跑 `npm run icons` 重新生成 `public/img/` 下的 PNG/ICO 和 OG 图。
图标脚本用 `@resvg/resvg-js` 渲染，是唯一一个 devDependency。

## 部署

- [更新日志](CHANGELOG.md)：v1.0.0 做了什么、开发期版本对照
- [部署指南](docs/deploy.md)：systemd、Docker、Nginx / Caddy 反代、跨版本升级
- [架构说明](docs/architecture.md)：请求链路、计数落库、缓存、安全设计
- [备份与迁移](docs/backup.md)：备份策略、异地迁移、灾难恢复

## 开发

```bash
npm test          # node --test 跑单元与集成测试（467 个用例，约 8s）
npm run bench     # 本地压测跳转 QPS
npm run icons     # 重新生成图标（需装 @resvg/resvg-js）
```

目录结构：

```
src/
  cli.js          命令行入口
  server.js       HTTP 服务与请求分发
  config.js       配置与默认值
  lib/            db(SQLite) / http / router / util / html / pdf / png / zip
  services/       业务：links、titles、counter、auth、ua-filter、migrate…
  routes/         redirect / public / api / admin
  pages/          服务端渲染：落地页、登录、管理台外壳、API 文档、建页、短链名片
public/           静态资源与前端 SPA
```

## FAQ

**Q：为什么不用 Redis？**
单机短链接服务的瓶颈在写盘次数，不在存储介质。把点击先攒在内存里批量写，SQLite 的 WAL 模式足够跑满千兆网卡。真要水平扩展再上 Redis 不迟。

**Q：数据会不会丢？**
进程正常退出会 flush；异常崩溃最多丢最近一节拍（默认 1 秒）的计数。每天自动生成 JSON 备份，保留 14 份。想更稳就配 `countFlushMs` 小一点。

**Q：能换主题吗？**
`public/static/app.css` 顶部有 CSS 变量，改颜色和圆角就行，无需构建。

**Q：短码能改吗？**
不能。短码是链接的身份，改它等于让所有已发出去的链接失效。要换就新建一条。

**Q：短码区分大小写吗？**
不区分。`/MiXeD`、`/mixed`、`/MIXED` 都指向同一条短链，创建时也不允许只靠大小写区分的重复短码——印在物料上的短码大小写经常被手抄错。

## License

MIT
