#!/usr/bin/env bash
set -euo pipefail
: "${DB_HOST:?}" "${DB_USER:?}" "${BACKUP_FILE:?}"
command -v pg_restore >/dev/null 2>&1 || exit 127
export PGPASSWORD="${DB_PASSWORD}"
DUMP="${BACKUP_FILE}.dump"
test -f "${DUMP}" || exit 2
pg_restore -h "${DB_HOST}" -p "${DB_PORT:-5432}" -U "${DB_USER}" -d postgres -c "${DUMP}"
echo "[OK] pg_restore"
