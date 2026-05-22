#!/usr/bin/env bash
set -euo pipefail
: "${DB_USER:?}" "${DB_CONNECT:?}" "${BACKUP_FILE:?}"
command -v rman >/dev/null 2>&1 || exit 127
rman target "${DB_USER}/${DB_PASSWORD}@${DB_CONNECT}" <<EOF
RESTORE DATABASE FROM TAG 'DIOps_FULL';
RECOVER DATABASE;
EOF
echo "[OK] RMAN full restore"
