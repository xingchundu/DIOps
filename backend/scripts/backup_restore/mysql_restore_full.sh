#!/usr/bin/env bash
set -euo pipefail
: "${DB_HOST:?}" "${DB_USER:?}" "${BACKUP_FILE:?}"
command -v mysql >/dev/null 2>&1 || exit 127
SRC="${BACKUP_FILE}.sql"
test -f "${SRC}" || test -f "${BACKUP_FILE}.manifest.json" || exit 2
if [ -f "${SRC}" ]; then
  mysql -h"${DB_HOST}" -P"${DB_PORT:-3306}" -u"${DB_USER}" -p"${DB_PASSWORD}" < "${SRC}"
fi
echo "[OK] mysql restore"
