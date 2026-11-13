#!/usr/bin/env bash
# 整机迁移：把数据目录同步到另一台机器
# 用法: bash scripts/transfer.sh user@new-host [/var/lib/highurl]
set -euo pipefail

TARGET="${1:?用法: bash scripts/transfer.sh user@host [远端数据目录]}"
REMOTE_DIR="${2:-/var/lib/highurl}"
DATA_DIR="${HIGHURL_DATA_DIR:-./data}"

[[ -d "$DATA_DIR" ]] || { echo "数据目录不存在: $DATA_DIR" >&2; exit 1; }

echo "▸ 检查目标机"
ssh "$TARGET" "command -v node >/dev/null || { echo '目标机没有 node，请先安装 Node.js 22.5+'; exit 1; }; node -v"

echo "▸ 打包 $DATA_DIR"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DATA_DIR/highurl.db" ".backup '$TMP/highurl.db'"
else
  echo "! 未安装 sqlite3，直接复制文件。请确保源服务已停止，否则可能丢最近 1 秒的计数。" >&2
  cp "$DATA_DIR/highurl.db" "$TMP/" 2>/dev/null || true
  cp "$DATA_DIR/highurl.db-wal" "$TMP/" 2>/dev/null || true
fi
[[ -f "$DATA_DIR/.secret" ]] && cp "$DATA_DIR/.secret" "$TMP/"
tar czf "$TMP/data.tgz" -C "$TMP" .

echo "▸ 上传到 $TARGET:$REMOTE_DIR"
ssh "$TARGET" "mkdir -p '$REMOTE_DIR'"
scp -q "$TMP/data.tgz" "$TARGET:/tmp/highurl-transfer.tgz"
ssh "$TARGET" "tar xzf /tmp/highurl-transfer.tgz -C '$REMOTE_DIR' && rm -f /tmp/highurl-transfer.tgz"
ssh "$TARGET" "ls -la '$REMOTE_DIR'"

cat <<DONE

迁移完成。在目标机执行：

  node /opt/highurl/src/cli.js doctor --data $REMOTE_DIR
  node /opt/highurl/src/cli.js stats  --data $REMOTE_DIR
  systemctl restart highurl

别忘了把 DNS 切过来。切换前先在旧机上停掉写入，避免两边都收计数。

DONE
