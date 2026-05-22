#!/usr/bin/env bash
set -euo pipefail
: "${DB_HOST:?}" "${TARGET_TIME:?}"
echo "[INFO] MySQL PITR 需结合 binlog + 全备，目标时间 ${TARGET_TIME}"
command -v mysqlbinlog >/dev/null 2>&1 || exit 127
echo "[OK] mysqlbinlog PITR prepared (请按环境配置 binlog 回放)"
