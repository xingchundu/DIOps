#!/usr/bin/env python3
# 将 init-merge.list 中的 migration 并入 backend/sql/init.sql（去掉 DI_EXEC_IGNORE 删表块）
# 用法: python3 scripts/merge-init-sql.py [backend/sql 目录]
import os
import re
import sys
from pathlib import Path

EXCLUDE_WARN = frozenset({
    "migration_platform_ops_upgrade.sql",
    "migration_phase1_delivery.sql",
    "migration_phase2_ops.sql",
    "migration_phase3_delivery.sql",
})

MARKER_RE = re.compile(r"-- \[init-merge\] (migration_\S+\.sql)")

# 仅去掉「删表」类 DI_EXEC_IGNORE，保留 ALTER/CREATE INDEX 等（migration_sql_insight 依赖）
DROP_BLOCK_RE = re.compile(
    r"BEGIN\s+DI_EXEC_IGNORE\s*\(\s*'DROP\s+TABLE[^']*'\s*\)\s*;\s*END\s*;\s*/\s*",
    re.IGNORECASE | re.DOTALL,
)

BROKEN_MERGE_RE = re.compile(
    r"ON \(t\.CONFIG_KEY = s\.k\)\s*\n(?!\s*WHEN )",
    re.MULTILINE,
)


def filter_greenfield(text: str) -> str:
    return DROP_BLOCK_RE.sub("", text).strip()


def validate_init_sql(init_text):
    errs = []
    if BROKEN_MERGE_RE.search(init_text):
        errs.append("init.sql 存在残缺 MERGE（ON 后缺少 WHEN NOT MATCHED/WHEN MATCHED）")
    if re.search(
        r"INSERT INTO ALERT_SUPPRESSION_RULE \([^)]+\)\s*\n(?!VALUES)",
        init_text,
        re.MULTILINE,
    ):
        errs.append("init.sql 存在无 VALUES 的 ALERT_SUPPRESSION_RULE INSERT")
    return errs


DEFINE_OFF_MARKER = "SET DEFINE OFF"


def ensure_sqlplus_define_off(text: str) -> str:
    """SQL*Plus / PL/SQL Developer：种子 JSON 含 && 等字符，须关闭 & 替换变量。"""
    head = text[:4000].upper()
    if DEFINE_OFF_MARKER in head:
        return text
    block = (
        "--\n"
        "-- SQL*Plus / PL/SQL Developer：执行前关闭 & 替换（避免弹出 Enter value for）\n"
        "SET DEFINE OFF\n"
        "SET SCAN OFF\n\n"
    )
    lines = text.splitlines(keepends=True)
    insert_at = 0
    for i, line in enumerate(lines):
        if line.strip() and not line.lstrip().startswith("--"):
            insert_at = i
            break
    return "".join(lines[:insert_at]) + block + "".join(lines[insert_at:])


CREATE_TABLE_RE = re.compile(r"CREATE TABLE\s+([A-Za-z0-9_]+)\s*\(", re.IGNORECASE)


def verify_migration_tables_in_init(sql_dir: Path, init_path: Path, to_merge: list) -> list:
    """任一 migration 的 CREATE TABLE 若不在 init.sql 中则报错（供打包门禁）。"""
    init_text = init_path.read_text(encoding="utf-8")
    init_tables = set(CREATE_TABLE_RE.findall(init_text))
    errs = []
    checked = set(to_merge) | set(MARKER_RE.findall(init_text))
    for p in sorted(sql_dir.glob("migration_*.sql")):
        if p.name in EXCLUDE_WARN:
            continue
        mig_tables = set(CREATE_TABLE_RE.findall(p.read_text(encoding="utf-8")))
        if not mig_tables:
            continue
        missing = mig_tables - init_tables
        if missing:
            hint = (
                f"加入 {sql_dir / 'init-merge.list'}"
                if p.name not in checked
                else "init-merge 已引用但仍缺表，请检查合并是否失败"
            )
            errs.append(
                f"{p.name} 的表 {sorted(missing)} 不在 init.sql（{hint}）"
            )
    return errs


def load_list(list_path):
    if not list_path.is_file():
        return []
    out = []
    for line in list_path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            out.append(line)
    return out


def main() -> int:
    sql_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "backend/sql").resolve()
    init_path = sql_dir / "init.sql"
    list_path = sql_dir / "init-merge.list"
    if not init_path.is_file():
        print(f"[ERROR] 缺少 {init_path}", file=sys.stderr)
        return 1

    initial = init_path.read_text(encoding="utf-8")
    init = initial
    merged_names = set(MARKER_RE.findall(init))
    to_merge = load_list(list_path)
    changed = False

    for name in to_merge:
        marker = f"-- [init-merge] {name}"
        if marker in init or name in merged_names:
            continue
        mig = sql_dir / name
        if not mig.is_file():
            print(f"[WARN] init-merge.list 引用不存在: {name}", file=sys.stderr)
            continue
        body = filter_greenfield(mig.read_text(encoding="utf-8"))
        if not body:
            print(f"[WARN] 跳过空脚本: {name}", file=sys.stderr)
            continue
        block = (
            f"\n\n{marker}\n"
            f"-- 由 scripts/merge-init-sql 并入（pack-offline 打包前自动执行）\n"
            f"{body}\n"
        )
        init += block
        merged_names.add(name)
        changed = True
        print(f"[merge-init-sql] 并入 {name}")

    errs = validate_init_sql(init)
    if errs:
        for e in errs:
            print(f"[ERROR] {e}", file=sys.stderr)
        return 1

    init = ensure_sqlplus_define_off(init)
    if init != initial:
        init_path.write_text(init, encoding="utf-8")
        print(f"[merge-init-sql] 已更新 {init_path}")
        if DEFINE_OFF_MARKER not in initial.upper()[:4000]:
            print("[merge-init-sql] 已补充 SET DEFINE OFF / SET SCAN OFF（PL/SQL Developer 执行必备）")
    elif changed:
        init_path.write_text(init, encoding="utf-8")
        print(f"[merge-init-sql] 已更新 {init_path}")
    else:
        print("[merge-init-sql] init.sql 已包含列表中的全部脚本")

    table_errs = verify_migration_tables_in_init(sql_dir, init_path, to_merge)
    if table_errs:
        for e in table_errs:
            print(f"[ERROR] {e}", file=sys.stderr)
        return 1

    if os.environ.get("INIT_MERGE_WARN_UNLISTED") == "1":
        listed = set(to_merge)
        marked = set(MARKER_RE.findall(init_path.read_text(encoding="utf-8")))
        for p in sorted(sql_dir.glob("migration_*.sql")):
            if p.name in EXCLUDE_WARN or p.name in listed or p.name in marked:
                continue
            print(
                f"[WARN] 未并入 init.sql: {p.name} "
                f"（加入 {list_path.name} 或仅作存量升级脚本）",
                file=sys.stderr,
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
