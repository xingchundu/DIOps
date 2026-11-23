#!/usr/bin/env python3
"""One-off helper: assemble consolidated init.sql from migration fragments."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SQL = ROOT / "sql"
OUT = SQL / "init.sql"

# Fragment files appended in dependency order (DDL + seeds only; menus merged in main seed section)
FRAGMENTS = [
    "fragments/_header.sql",  # written inline below if missing
]

# We'll build the file as string sections
HEADER = """-- ============================================================
-- 数据库智能平台 - Oracle 平台库完整初始化脚本
-- 执行用户: monitor（或具备建表权限的业务用户）
-- Oracle 版本: 19c+
-- 说明: 已合并全部 migration_*.sql 建表与种子数据；新库仅需执行本脚本
-- ============================================================

"""

def read(name):
    p = SQL / name
    return p.read_text(encoding="utf-8") if p.exists() else ""

# The consolidated body is maintained in init.sql; this script validates line count
if __name__ == "__main__":
    text = OUT.read_text(encoding="utf-8")
    print("init.sql lines:", text.count("\n") + 1)
    print("CREATE TABLE count:", text.upper().count("CREATE TABLE"))
