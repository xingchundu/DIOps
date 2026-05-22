#!/usr/bin/env bash
set -euo pipefail
: "${DB_USER:?}" "${DB_CONNECT:?}" "${BACKUP_FILE:?}"
command -v expdp >/dev/null 2>&1 || exit 127
expdp "${DB_USER}/${DB_PASSWORD}@${DB_CONNECT}" DIRECTORY=DATA_PUMP_DIR DUMPFILE="$(basename "${BACKUP_FILE}").dmp" LOGFILE="$(basename "${BACKUP_FILE}").log" FULL=Y
echo "[OK] Data Pump logical backup"
