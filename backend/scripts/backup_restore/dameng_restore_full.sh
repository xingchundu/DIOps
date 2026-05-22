#!/usr/bin/env bash
set -euo pipefail
: "${DB_HOST:?}" "${DB_USER:?}" "${BACKUP_FILE:?}"
command -v dimp >/dev/null 2>&1 || exit 127
dimp "${DB_USER}/${DB_PASSWORD}@${DB_HOST}:${DB_PORT:-5236}" FILE="${BACKUP_FILE}.dmp" FULL=Y
echo "[OK] DM import restore"
