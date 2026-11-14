# 部署指南

## 环境要求

- Node.js **22.5+**（需要内置的 `node:sqlite`），推荐 22 LTS 或 24
- Linux / macOS / Windows 均可，无需数据库、Redis、反向代理以外的任何组件
- 内存 64 MB 起步，几十万条短链也就百来兆

先跑一遍自检：

```bash
node src/cli.js doctor
```

## 方式一：直接运行

```bash
git clone https://github.com/techjiang/HighURL.git
cd HighURL
node src/cli.js serve --port 8080 --data /var/lib/highurl
```

首次访问 `http://服务器IP:8080/install` 创建管理员。

用 systemd 托管：

```ini
# /etc/systemd/system/highurl.service
[Unit]
Description=HighURL 短链接服务
After=network-online.target

[Service]
Type=simple
User=highurl
Group=highurl
WorkingDirectory=/opt/highurl
Environment=HIGHURL_PORT=8080
Environment=HIGHURL_DATA_DIR=/var/lib/highurl
Environment=HIGHURL_BASE_URL=https://s.example.com
Environment=HIGHURL_TRUST_PROXY=true
ExecStart=/usr/bin/node /opt/highurl/src/cli.js serve
Restart=always
RestartSec=3

# 安全加固
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/highurl

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd -r -s /usr/sbin/nologin highurl
sudo mkdir -p /var/lib/highurl && sudo chown highurl: /var/lib/highurl
sudo systemctl daemon-reload
sudo systemctl enable --now highurl
journalctl -u highurl -f
```

停止时进程会先把内存里的点击计数落库再退出，`Restart=always` 不会丢数据。

## 方式二：Docker

```bash
docker run -d --name highurl \
  -p 8080:8080 \
  -v /srv/highurl:/data \
  -e HIGHURL_BASE_URL=https://s.example.com \
  -e HIGHURL_TRUST_PROXY=true \
  --restart unless-stopped \
  ghcr.io/techjiang/highurl:latest
```

镜像基于 `node:22-alpine`，非 root 用户运行，`/data` 是唯一需要持久化的卷。

带 HTTPS 的 compose 示例见仓库根目录 `docker-compose.yml`。

## 反向代理

生产环境请务必在反代后面加 HTTPS，并把 `HIGHURL_TRUST_PROXY` 打开——否则拿不到真实 IP，UA/IP 屏蔽和限流都会失效。

### Nginx

```nginx
server {
    listen 80;
    server_name s.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name s.example.com;

    ssl_certificate     /etc/letsencrypt/live/s.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/s.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Caddy

```caddyfile
s.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Caddy 会自动带上 `X-Forwarded-For` 和 `X-Forwarded-Proto`，同样记得开 `HIGHURL_TRUST_PROXY`。

### 让跳转不经过你的服务器（可选）

短链服务最省的优化是：让热门短码的跳转直接由 CDN 缓存。做法是在反代层对 301 响应加缓存：

```nginx
proxy_cache_path /var/cache/nginx/shorturl levels=1:2 keys_zone=short:10m max_size=1g;

location / {
    proxy_cache short;
    proxy_cache_valid 301 1h;
    proxy_cache_key "$scheme$host$request_uri";
    add_header X-Cache-Status $upstream_cache_status;
    proxy_pass http://127.0.0.1:8080;
}
```

前提是在「系统设置」里把跳转状态码改成 **301**（永久）。302 不该被缓存。

## 配置项

优先级：**命令行参数 > 环境变量 > 管理台设置 > 默认值**。

大部分功能开关都在管理台「系统设置」里，改完即时生效，不用重启。

| 设置项 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | 空 | 站点公网地址，影响短链拼接与 OG 图；留空则按请求 Host 推断 |
| `redirectStatus` | 302 | 301 / 302 / 307 / 308 |
| `codeLength` | 6 | 自动生成短码长度 |
| `titleFetch` | 开 | 创建时自动抓取标题 |
| `blockBots` | 关 | 屏蔽常见爬虫 UA |
| `publicCreate` | 关 | 允许游客在首页创建短链 |
| `rateLimitPerMinute` | 600 | 单 IP 每分钟请求上限 |
| `createRateLimitPerMinute` | 60 | 单 IP 每分钟创建上限 |
| `countFlushMs` | 1000 | 计数落库间隔（越大吞吐越高，崩溃丢的越多） |
| `retentionDays` | 0 | 点击明细保留天数，0 表示永久 |
| `notFoundUrl` | 空 | 短链失效后跳转到哪（支持 `{code}` 占位） |
| `trustProxy` | 关 | 是否信任 `X-Forwarded-*` |

## 监控

```bash
curl -s https://s.example.com/health   # {"status":"ok","uptime":…}
curl -s https://s.example.com/metrics  # Prometheus 文本格式
```

`/metrics` 暴露的关键指标：

- `highurl_links_total` / `highurl_clicks_total`
- `highurl_clicks_pending`：还在内存里没落库的点击数，正常应在个位数
- `highurl_cache_hit_ratio`：跳转缓存命中率，健康的服务通常 > 0.95
- `highurl_clicks_deduped_total`：被去重窗口跳过的点击，只在开了去重后才有意义
- `highurl_requests_total` / `highurl_process_uptime_seconds`

`clicks_pending` 持续增长说明 flush 在失败，看日志里的 `[counter] flush failed`。

## 升级

### 从 v1.0.0 开始

v1.0.0 就是第一个正式版本，之后再升级都是小版本内的事：

```bash
cd /opt/highurl
git fetch --tags && git checkout v1.0.1   # 换成目标版本
systemctl restart highurl
```

进程启动时会自动跑数据库迁移，**不需要手动执行 SQL**，也不会动已有数据。

### 从开发期版本（v1.14 – v1.21）升到 v1.0.0

v1.14 到 v1.21 是开发期版本号，v1.0.0 是它们合并后的第一个发布版。库里可能是 schema v9 – v13 中的任一版本，升级到 v1.0.0（schema v13）时：

1. **先备份**，两条命令都要跑：
   ```bash
   systemctl stop highurl
   node src/cli.js backup /backup/before-v1.0.0.json
   node src/cli.js verify /backup/before-v1.0.0.json
   ```
2. 换代码、启动。启动日志里会看到 `schema 9 → 13` 这类迁移记录，逐版本往上走。
3. 起来后核对三件事：
   - `node src/cli.js stats` 的短链数与点击数
   - 管理台能打开，短链列表里的分组、标签、有效期都在
   - 随便挑一条链访问，302 正常、`/health` 的 `requests.errors` 不涨
4. 有问题就停服务，用 `node src/cli.js restore /backup/before-v1.0.0.json --replace --yes` 回到升级前。

跨版本升级不会补历史数据：`click_slots`（星期×小时）和 `landing_views`（建页曝光）都是后加的表，升级前没有记过就是没有，界面上显示「没数据」而不是 0。

### 从 YOURLS 迁过来

见 [migrate-yourls.md](migrate-yourls.md)，短码和点击数原样保留。

## 排错

**打不开 /install，提示已初始化**
账号已存在。忘了密码就重置：

```bash
node -e "
const {DatabaseSync}=require('node:sqlite');
const {scrypt}=require('node:crypto');
const db=new DatabaseSync('/var/lib/highurl/highurl.db');
const salt=require('node:crypto').randomBytes(16).toString('hex');
const hash=scrypt('new-password-123',salt,32,{N:16384,r:8,p:1}).toString('hex');
db.prepare('UPDATE admins SET password_hash=?').run(\`scrypt\$\${salt}\$\${hash}\`);
console.log('密码已重置');
"
```

**跳转全是 404**
检查短码是否撞了保留字（`/api`、`/admin` 等），或者在管理台看那条链接的状态是不是被停用了。也确认一下 `data/` 目录权限——库文件读不到会表现成空库。

**统计数字不动**
`/health` 看 `pendingClicks`。若一直是 0 而点击没涨，多半是反代没传真实 IP 导致所有请求被限流挡掉。

**统计涨得比预期慢**
看看系统设置里的「点击去重窗口」。设成大于 0 时，同一 IP 对同一短链在窗口内只计一次，`/health` 的 `dedupe.skipped` 和 `/metrics` 的 `highurl_clicks_deduped_total` 能看到被跳过多少次。默认 0，也就是不去重。跳转本身不受影响，去重只动计数。

**自检说「统计孤儿行」不是 0**
说明有短链被彻底删除后，点击明细还留在库里。它们不影响访问，只占空间。到管理台「系统设置 → 数据自检」点「清理孤儿统计」，或者跑 `highurl stats --collect-orphans`。

**反代后面 IP 都是 127.0.0.1**
开 `HIGHURL_TRUST_PROXY=true`（或在系统设置里打开信任代理）。

**M1/M2 Mac 上 Docker 构建慢**
正常的，QEMU 模拟。用 `--platform linux/arm64` 构建或者直接 `npm start` 跑宿主机。
