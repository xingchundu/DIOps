#!/usr/bin/env bash
set -euo pipefail
: "${DB_USER:?}" "${DB_CONNECT:?}" "${TARGET_TIME:?}"
command -v rman >/dev/null 2>&1 || exit 127
rman target "${DB_USER}/${DB_PASSWORD}@${DB_CONNECT}" <<EOF
RUN {
  SET UNTIL TIME "to_date('${TARGET_TIME}','YYYY-MM-DD HH24:MI:SS')";
  RESTORE DATABASE;
  RECOVER DATABASE;
}
EOF
echo "[OK] RMAN PITR to ${TARGET_TIME}"
