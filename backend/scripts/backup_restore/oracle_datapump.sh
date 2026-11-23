#!/usr/bin/env bash
set -euo pipefail
: "${DB_USER:?}" "${DB_CONNECT:?}" "${BACKUP_FILE:?}"
command -v expdp >/dev/null 2>&1 || exit 127
source "$(dirname "$0")/_secret.sh"
diops_tmpfile
printf 'USERID="%s/\\"%s\\"@%s"\nDIRECTORY=DATA_PUMP_DIR\nDUMPFILE=%s.dmp\nLOGFILE=%s.log\nFULL=Y\n' \
  "${DB_USER}" "${DB_PASSWORD}" "${DB_CONNECT}" "$(basename "${BACKUP_FILE}")" "$(basename "${BACKUP_FILE}")" > "$PAR"
expdp PARFILE="$PAR"
echo "[OK] Data Pump logical backup"
