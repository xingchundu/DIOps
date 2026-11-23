#!/usr/bin/env bash
set -euo pipefail
: "${DB_HOST:?}" "${DB_USER:?}" "${BACKUP_FILE:?}"
command -v mysqldump >/dev/null 2>&1 || exit 127
export MYSQL_PWD="${DB_PASSWORD:-}"   # 不用 -p<密码>，避免出现在进程列表
OUT="${BACKUP_FILE}.sql"
mysqldump -h"${DB_HOST}" -P"${DB_PORT:-3306}" -u"${DB_USER}" --single-transaction --routines --triggers --all-databases > "${OUT}"
echo "[OK] mysqldump -> ${OUT}"
