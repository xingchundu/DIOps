#!/usr/bin/env bash
set -euo pipefail
: "${DB_HOST:?}" "${TARGET_TIME:?}"
echo "[INFO] PostgreSQL PITR 目标 ${TARGET_TIME}，需 WAL 归档与 recovery_target_time"
command -v psql >/dev/null 2>&1 || exit 127
echo "[OK] PITR script checkpoint (请配置 recovery.conf / postgresql.conf)"
