#!/usr/bin/env bash
# HighURL 一键安装：建用户、放代码、装 systemd 服务
# 用法: sudo bash scripts/install.sh [--port 8080] [--domain https://s.example.com]
set -euo pipefail

PORT=8080
DOMAIN=""
PREFIX=/opt/highurl
DATA_DIR=/var/lib/highurl
SERVICE_USER=highurl
INSTALL_SERVICE=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --data) DATA_DIR="$2"; shift 2 ;;
    --no-service) INSTALL_SERVICE=0; shift ;;
    -h|--help) sed -n '2,4p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

say() { printf '\033[1;35m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 运行（sudo bash scripts/install.sh）"

# ---------- Node.js ----------
say "检查 Node.js"
need_install=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
  NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]')
  if [[ "$NODE_MAJOR" -lt 22 || ( "$NODE_MAJOR" -eq 22 && "$NODE_MINOR" -lt 5 ) ]]; then
    warn "当前 Node $(node -v) 版本过低，需要 22.5+（内置 node:sqlite）"
    need_install=1
  else
    say "Node $(node -v) 可用"
  fi
else
  need_install=1
fi

if [[ $need_install -eq 1 ]]; then
  say "安装 Node.js 22 LTS"
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    dnf install -y nodejs
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache nodejs
  else
    die "无法自动安装 Node.js，请手动安装 22.5+ 后重试"
  fi
fi

node -e "import('node:sqlite').then(()=>process.exit(0)).catch(()=>process.exit(1))" \
  || die "当前 Node 不支持 node:sqlite，请升级到 22.5+"

# ---------- 用户与目录 ----------
say "准备运行用户 $SERVICE_USER"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd -r -s /usr/sbin/nologin -d "$DATA_DIR" "$SERVICE_USER" 2>/dev/null \
    || adduser -S -H -s /sbin/nologin "$SERVICE_USER"
fi

say "复制代码到 $PREFIX"
mkdir -p "$PREFIX"
SRC_DIR=$(cd "$(dirname "$0")/.." && pwd)
if [[ "$SRC_DIR" != "$PREFIX" ]]; then
  for item in src public assets package.json LICENSE README.md; do
    [[ -e "$SRC_DIR/$item" ]] && cp -R "$SRC_DIR/$item" "$PREFIX/"
  done
fi

mkdir -p "$DATA_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$PREFIX" "$DATA_DIR"
chmod 750 "$DATA_DIR"

# ---------- systemd ----------
if [[ $INSTALL_SERVICE -eq 1 ]]; then
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "没有 systemd，跳过服务安装。手动启动："
    warn "  sudo -u $SERVICE_USER node $PREFIX/src/cli.js serve --port $PORT --data $DATA_DIR"
    exit 0
  fi

  say "写入 /etc/systemd/system/highurl.service"
  cat > /etc/systemd/system/highurl.service <<UNIT
[Unit]
Description=HighURL 短链接服务
Documentation=https://github.com/techjiang/HighURL
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$PREFIX
Environment=HIGHURL_PORT=$PORT
Environment=HIGHURL_DATA_DIR=$DATA_DIR
Environment=HIGHURL_TRUST_PROXY=true
$( [[ -n "$DOMAIN" ]] && echo "Environment=HIGHURL_BASE_URL=$DOMAIN" )
ExecStart=$(command -v node) $PREFIX/src/cli.js serve
Restart=always
RestartSec=3
LimitNOFILE=65535

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable --now highurl
  sleep 1
  systemctl --no-pager --lines=0 status highurl || true
fi

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
cat <<DONE

  HighURL 安装完成

    访问   http://${IP:-127.0.0.1}:$PORT/install  创建管理员
    数据   $DATA_DIR
    配置   /etc/systemd/system/highurl.service
    日志   journalctl -u highurl -f

  建议下一步：
    · 用 Nginx / Caddy 套上 HTTPS，并把 X-Forwarded-* 传给本服务
    · 在「系统设置」里填好站点地址，短链分享卡片才正常

DONE
