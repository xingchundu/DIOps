#!/usr/bin/env bash
set -euo pipefail
: "${DB_HOST:?}" "${TARGET_TIME:?}"
# MySQL 时间点恢复需要“全备 + binlog 回放”，依赖各环境的 binlog 位置与保留策略，平台不做自动回放。
echo "MySQL 时间点恢复（目标 ${TARGET_TIME}）未自动执行：请由 DBA 按环境用 mysqlbinlog 回放，或改用全量/单表恢复" >&2
exit 3
