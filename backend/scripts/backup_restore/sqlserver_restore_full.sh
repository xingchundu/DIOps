#!/usr/bin/env bash
set -euo pipefail
: "${DB_HOST:?}" "${DB_USER:?}" "${BACKUP_FILE:?}"
command -v sqlcmd >/dev/null 2>&1 || exit 127
DB="${DB_CONNECT##*/}"
DB="${DB:-master}"
BF="${BACKUP_FILE}.bak"
export SQLCMDPASSWORD="${DB_PASSWORD:-}"   # 不用 -P，避免出现在进程列表
sqlcmd -S "${DB_HOST},${DB_PORT:-1433}" -U "${DB_USER}" -Q "RESTORE DATABASE [${DB}] FROM DISK=N'${BF}' WITH REPLACE"
echo "[OK] sqlcmd RESTORE <- ${BF}"
