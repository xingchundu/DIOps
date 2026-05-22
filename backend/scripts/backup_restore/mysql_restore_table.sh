#!/usr/bin/env bash
set -euo pipefail
: "${DB_HOST:?}" "${DB_USER:?}" "${TARGET_TABLE:?}" "${BACKUP_FILE:?}"
command -v mysql >/dev/null 2>&1 || exit 127
SRC="${BACKUP_FILE}.sql"
test -f "${SRC}" || exit 2
mysql -h"${DB_HOST}" -P"${DB_PORT:-3306}" -u"${DB_USER}" -p"${DB_PASSWORD}" -e "SOURCE ${SRC}" 2>/dev/null || mysql -h"${DB_HOST}" -P"${DB_PORT:-3306}" -u"${DB_USER}" -p"${DB_PASSWORD}" < "${SRC}"
echo "[OK] restore table ${TARGET_TABLE}"
