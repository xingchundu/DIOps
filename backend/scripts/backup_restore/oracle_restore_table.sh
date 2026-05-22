#!/usr/bin/env bash
set -euo pipefail
: "${DB_USER:?}" "${DB_CONNECT:?}" "${TARGET_TABLE:?}" "${BACKUP_FILE:?}"
command -v impdp >/dev/null 2>&1 || exit 127
impdp "${DB_USER}/${DB_PASSWORD}@${DB_CONNECT}" TABLES="${TARGET_TABLE}" DUMPFILE="$(basename "${BACKUP_FILE}").dmp" TABLE_EXISTS_ACTION=REPLACE
echo "[OK] impdp table ${TARGET_TABLE}"
