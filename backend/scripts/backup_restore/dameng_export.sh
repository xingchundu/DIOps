#!/usr/bin/env bash
set -euo pipefail
: "${DB_HOST:?}" "${DB_USER:?}" "${BACKUP_FILE:?}"
command -v dexp >/dev/null 2>&1 || exit 127
dexp "${DB_USER}/${DB_PASSWORD}@${DB_HOST}:${DB_PORT:-5236}" FILE="${BACKUP_FILE}.dmp" LOG="${BACKUP_FILE}.log" FULL=Y
echo "[OK] DM export backup"
