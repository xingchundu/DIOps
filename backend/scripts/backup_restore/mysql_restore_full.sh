#!/usr/bin/env bash
set -euo pipefail
: "${DB_HOST:?}" "${DB_USER:?}" "${BACKUP_FILE:?}"
command -v mysql >/dev/null 2>&1 || exit 127
SRC="${BACKUP_FILE}.sql"
# 只有清单（未真正备份数据）时不能“恢复成功”
test -f "${SRC}" || { echo "备份数据文件不存在: ${SRC}（清单备份不含数据，无法恢复）" >&2; exit 2; }
export MYSQL_PWD="${DB_PASSWORD:-}"
mysql -h"${DB_HOST}" -P"${DB_PORT:-3306}" -u"${DB_USER}" < "${SRC}"
echo "[OK] mysql restore"
