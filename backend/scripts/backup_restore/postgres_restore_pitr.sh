#!/usr/bin/env bash
set -euo pipefail
: "${DB_HOST:?}" "${TARGET_TIME:?}"
# PostgreSQL 时间点恢复需要基础备份 + WAL 归档并重启实例（recovery_target_time），平台不做自动操作。
echo "PostgreSQL 时间点恢复（目标 ${TARGET_TIME}）未自动执行：需基础备份与 WAL 归档并重启实例，请由 DBA 人工操作" >&2
exit 3
