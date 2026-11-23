#!/usr/bin/env bash
set -euo pipefail
: "${DB_HOST:?}" "${DB_USER:?}" "${BACKUP_FILE:?}"
command -v dexp >/dev/null 2>&1 || exit 127
source "$(dirname "$0")/_secret.sh"
diops_tmpfile
printf 'USERID=%s/"%s"@%s:%s\nFILE=%s.dmp\nLOG=%s.log\nFULL=Y\n' "${DB_USER}" "${DB_PASSWORD}" "${DB_HOST}" "${DB_PORT:-5236}" "${BACKUP_FILE}" "${BACKUP_FILE}" > "$PAR"
dexp PARFILE="$PAR"
echo "[OK] DM export backup"
