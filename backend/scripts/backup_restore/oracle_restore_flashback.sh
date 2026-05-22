#!/usr/bin/env bash
set -euo pipefail
: "${DB_USER:?}" "${DB_CONNECT:?}" "${FLASHBACK_SCN:?}"
sqlplus -s "${DB_USER}/${DB_PASSWORD}@${DB_CONNECT}" <<EOF
WHENEVER SQLERROR EXIT FAILURE
FLASHBACK DATABASE TO SCN ${FLASHBACK_SCN};
EOF
echo "[OK] Flashback to SCN ${FLASHBACK_SCN}"
