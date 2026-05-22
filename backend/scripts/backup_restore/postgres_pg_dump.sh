#!/usr/bin/env bash
set -euo pipefail
: "${DB_HOST:?}" "${DB_USER:?}" "${BACKUP_FILE:?}"
command -v pg_dump >/dev/null 2>&1 || exit 127
export PGPASSWORD="${DB_PASSWORD}"
OUT="${BACKUP_FILE}.dump"
pg_dump -h "${DB_HOST}" -p "${DB_PORT:-5432}" -U "${DB_USER}" -Fc -f "${OUT}" postgres
echo "[OK] pg_dump -> ${OUT}"
