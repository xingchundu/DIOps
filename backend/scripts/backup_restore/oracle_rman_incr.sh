#!/usr/bin/env bash
set -euo pipefail
: "${DB_USER:?}" "${DB_CONNECT:?}" "${BACKUP_FILE:?}"
command -v rman >/dev/null 2>&1 || exit 127
rman <<EOS
CONNECT TARGET '${DB_USER}/"${DB_PASSWORD}"@${DB_CONNECT}';
RUN {
  BACKUP INCREMENTAL LEVEL 1 DATABASE FORMAT '${BACKUP_FILE}_%U' TAG 'DIOps_INCR';
}
EOS
echo "[OK] RMAN incremental backup"
