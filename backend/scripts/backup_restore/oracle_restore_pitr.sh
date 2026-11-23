#!/usr/bin/env bash
set -euo pipefail
: "${DB_USER:?}" "${DB_CONNECT:?}" "${TARGET_TIME:?}"
command -v rman >/dev/null 2>&1 || exit 127
[[ "${TARGET_TIME}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}[\ T][0-9]{2}:[0-9]{2}:[0-9]{2}$ ]] || { echo "目标时间格式应为 YYYY-MM-DD HH24:MI:SS" >&2; exit 2; }
TT="${TARGET_TIME/T/ }"
rman <<EOS
CONNECT TARGET '${DB_USER}/"${DB_PASSWORD}"@${DB_CONNECT}';
RUN {
  SET UNTIL TIME "to_date('${TT}','YYYY-MM-DD HH24:MI:SS')";
  RESTORE DATABASE;
  RECOVER DATABASE;
}
EOS
echo "[OK] RMAN PITR to ${TT}"
