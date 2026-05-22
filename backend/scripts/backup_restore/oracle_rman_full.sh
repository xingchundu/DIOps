#!/usr/bin/env bash
# Oracle 全量备份（RMAN）
set -euo pipefail
: "${DB_USER:?}" "${DB_CONNECT:?}" "${BACKUP_FILE:?}"
command -v rman >/dev/null 2>&1 || exit 127
export NLS_LANG=AMERICAN_AMERICA.AL32UTF8
rman target "${DB_USER}/${DB_PASSWORD}@${DB_CONNECT}" <<EOF
RUN {
  BACKUP DATABASE FORMAT '${BACKUP_FILE}_%U' TAG 'DIOps_FULL';
}
EOF
echo "[OK] RMAN full backup -> ${BACKUP_FILE}"
