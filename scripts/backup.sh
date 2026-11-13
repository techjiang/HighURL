#!/usr/bin/env bash
# 备份 HighURL 数据目录：库文件一致性快照 + 最近自动备份，打包归档
# 用法: bash scripts/backup.sh [输出目录] [--keep 30]
set -euo pipefail

DATA_DIR="${HIGHURL_DATA_DIR:-/var/lib/highurl}"
OUT_DIR="${1:-./backups}"
KEEP=30

if [[ "${2:-}" == "--keep" ]]; then KEEP="${3:-30}"; fi
if [[ "${1:-}" == "--keep" ]]; then OUT_DIR=./backups; KEEP="${2:-30}"; fi

[[ -d "$DATA_DIR" ]] || { echo "数据目录不存在: $DATA_DIR" >&2; exit 1; }
command -v sqlite3 >/dev/null 2>&1 || echo "提示: 没装 sqlite3，将直接打包文件（建议先停服务）" >&2

mkdir -p "$OUT_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# 优先用 sqlite3 的在线备份，保证 WAL 里未 checkpoint 的数据也在里面
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DATA_DIR/highurl.db" ".backup '$TMP/highurl.db'"
else
  cp "$DATA_DIR/highurl.db" "$TMP/" 2>/dev/null || true
  cp "$DATA_DIR/highurl.db-wal" "$TMP/" 2>/dev/null || true
fi

[[ -f "$DATA_DIR/.secret" ]] && cp "$DATA_DIR/.secret" "$TMP/"

ARCHIVE="$OUT_DIR/highurl-$STAMP.tar.gz"
tar czf "$ARCHIVE" -C "$TMP" .
echo "已备份 → $ARCHIVE  ($(du -h "$ARCHIVE" | cut -f1))"

# 轮转
ls -1t "$OUT_DIR"/highurl-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old"
  echo "已清理旧备份 $(basename "$old")"
done
