#!/usr/bin/env bash
set -euo pipefail
: "${DB_USER:?}" "${DB_CONNECT:?}" "${FLASHBACK_SCN:?}"
command -v sqlplus >/dev/null 2>&1 || exit 127
[[ "${FLASHBACK_SCN}" =~ ^[0-9]+$ ]] || { echo "SCN 必须是数字" >&2; exit 2; }
sqlplus -s /nolog <<EOS
WHENEVER SQLERROR EXIT FAILURE
CONNECT ${DB_USER}/"${DB_PASSWORD}"@${DB_CONNECT}
FLASHBACK DATABASE TO SCN ${FLASHBACK_SCN};
EOS
echo "[OK] Flashback to SCN ${FLASHBACK_SCN}"
