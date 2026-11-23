#!/usr/bin/env bash
set -euo pipefail
: "${DB_HOST:?}" "${DB_USER:?}" "${TARGET_TABLE:?}" "${BACKUP_FILE:?}"
command -v pg_restore >/dev/null 2>&1 || exit 127
export PGPASSWORD="${DB_PASSWORD}"
pg_restore -h "${DB_HOST}" -p "${DB_PORT:-5432}" -U "${DB_USER}" -d postgres -t "${TARGET_TABLE}" "${BACKUP_FILE}.dump"
echo "[OK] pg_restore table ${TARGET_TABLE}"
