#!/usr/bin/env bash
set -euo pipefail
: "${DB_HOST:?}" "${DB_USER:?}" "${BACKUP_FILE:?}"
command -v dimp >/dev/null 2>&1 || exit 127
test -f "${BACKUP_FILE}.dmp" || { echo "备份文件不存在: ${BACKUP_FILE}.dmp" >&2; exit 2; }
source "$(dirname "$0")/_secret.sh"
diops_tmpfile
printf 'USERID=%s/"%s"@%s:%s\nFILE=%s.dmp\nFULL=Y\n' "${DB_USER}" "${DB_PASSWORD}" "${DB_HOST}" "${DB_PORT:-5236}" "${BACKUP_FILE}" > "$PAR"
dimp PARFILE="$PAR"
echo "[OK] DM import restore"
