#!/usr/bin/env bash
set -euo pipefail
: "${DB_HOST:?}" "${DB_USER:?}" "${TARGET_TABLE:?}" "${BACKUP_FILE:?}"
# mysqldump --all-databases 的备份无法安全地只恢复一张表（原脚本会把整库导回去）
echo "MySQL 单表恢复未自动执行：当前备份为全库 mysqldump，直接导入会覆盖所有表。请从备份中抽取 ${TARGET_TABLE} 后人工导入" >&2
exit 3
