#!/bin/bash
# 打包/发布前：把 init-merge.list 中的 migration 并入 backend/sql/init.sql
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 "$ROOT/scripts/merge-init-sql.py" "$ROOT/backend/sql"
