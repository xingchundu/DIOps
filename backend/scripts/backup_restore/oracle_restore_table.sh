#!/usr/bin/env bash
set -euo pipefail
: "${DB_USER:?}" "${DB_CONNECT:?}" "${TARGET_TABLE:?}" "${BACKUP_FILE:?}"
command -v impdp >/dev/null 2>&1 || exit 127
source "$(dirname "$0")/_secret.sh"
diops_tmpfile
printf 'USERID="%s/\\"%s\\"@%s"\nDIRECTORY=DATA_PUMP_DIR\nTABLES=%s\nDUMPFILE=%s.dmp\nTABLE_EXISTS_ACTION=REPLACE\n' \
  "${DB_USER}" "${DB_PASSWORD}" "${DB_CONNECT}" "${TARGET_TABLE}" "$(basename "${BACKUP_FILE}")" > "$PAR"
impdp PARFILE="$PAR"
echo "[OK] impdp table ${TARGET_TABLE}"
