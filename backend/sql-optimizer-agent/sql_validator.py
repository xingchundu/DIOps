"""
AI 输出后的自动校验：方言解析、非法关键字、谓词是否相对原始 SQL 被改写。
"""
from __future__ import annotations

import re
from typing import Any

from sqlglot import exp, parse_one
from sqlglot.errors import ParseError

_SQL_BLOCK_RE = re.compile(r"```(?:sql)?\s*([\s\S]*?)```", re.IGNORECASE)


def extract_sql_blocks(markdown: str) -> list[str]:
    """从 Markdown 中提取 ``` / ```sql 代码块内容。"""
    if not markdown:
        return []
    return [m.group(1).strip() for m in _SQL_BLOCK_RE.finditer(markdown) if m.group(1).strip()]


def _normalize_db_type(db_type: str) -> str:
    t = (db_type or "").strip().lower()
    if t in ("pg", "postgresql", "postgres"):
        return "postgres"
    if t in ("oracle", "ora"):
        return "oracle"
    if t in ("mysql", "mariadb"):
        return "mysql"
    return t or "oracle"


def _sqlglot_dialect_name(db_type: str) -> str:
    n = _normalize_db_type(db_type)
    return "postgres" if n == "postgres" else n


def _parse_one_safe(sql: str, dialect: str) -> exp.Expression | None:
    s = (sql or "").strip()
    if not s:
        return None
    try:
        return parse_one(s, dialect=dialect)
    except ParseError:
        try:
            return parse_one(s)
        except ParseError:
            return None


def _dialect_parse_check(sql: str, db_type: str) -> list[str]:
    """1. 方言检查（SQLGlot）：能否按目标方言解析。"""
    errors: list[str] = []
    dialect = _sqlglot_dialect_name(db_type)
    s = (sql or "").strip()
    if not s:
        return ["SQL 为空"]
    try:
        parse_one(s, dialect=dialect)
    except ParseError as e:
        errors.append(f"按 {dialect} 方言解析失败: {e}")
    return errors


_ILLEGAL = {
    "oracle": [
        (re.compile(r"(?i)\bLIMIT\b"), "Oracle 不应使用 MySQL 风格的 LIMIT"),
        (re.compile(r"(?i)\bOFFSET\s+\d+\s*,\s*\d+"), "不应使用 MySQL 风格的 OFFSET,n（双参数）"),
        (re.compile(r"::\s*(?:varchar|int|bigint|numeric|number|text|bool)\b"), "不应使用 PostgreSQL 风格的 ::类型 转换"),
    ],
    "mysql": [
        (re.compile(r"(?i)\bROWNUM\b"), "MySQL 不应使用 Oracle 的 ROWNUM"),
        (re.compile(r"(?i)\bFETCH\s+FIRST\b"), "MySQL 不应使用 FETCH FIRST（请用 LIMIT）"),
    ],
    "postgres": [
        (re.compile(r"(?i)\bROWNUM\b"), "PostgreSQL 不应使用 Oracle 的 ROWNUM"),
    ],
}


def _illegal_keyword_check(sql: str, db_type: str) -> list[str]:
    """2. 是否包含对当前方言明显非法的关键字/写法。"""
    errors: list[str] = []
    n = _normalize_db_type(db_type)
    patterns = _ILLEGAL.get(n, [])
    for rx, msg in patterns:
        if rx.search(sql or ""):
            errors.append(msg)
    return errors


def _predicate_check(
    original_sql: str | None,
    optimized_sql: str,
    db_type: str,
) -> list[str]:
    """3. 是否改写了原始谓词（启发式：比对顶层 WHERE）。"""
    warnings: list[str] = []
    if not (original_sql or "").strip():
        return warnings

    dialect = _sqlglot_dialect_name(db_type)
    orig = _parse_one_safe(original_sql or "", dialect)
    opt = _parse_one_safe(optimized_sql, dialect)
    if orig is None or opt is None:
        return warnings

    if isinstance(opt, exp.Create):
        return warnings

    if not isinstance(orig, exp.Select) or not isinstance(opt, exp.Select):
        return warnings

    w_orig = orig.args.get("where")
    w_opt = opt.args.get("where")

    if w_orig is None and w_opt is not None:
        warnings.append("优化 SQL 新增了 WHERE 条件，请核对是否为业务所需")
        return warnings
    if w_orig is not None and w_opt is None:
        warnings.append("优化 SQL 移除了原有 WHERE 条件，请核对语义是否等价")
        return warnings
    if w_orig is not None and w_opt is not None:
        s1 = w_orig.sql(dialect=dialect).upper()
        s2 = w_opt.sql(dialect=dialect).upper()
        if s1 != s2:
            warnings.append("WHERE 谓词与原始 SQL 不完全一致，请人工核对等价性")
    return warnings


def validate_sql(
    sql: str,
    db_type: str,
    *,
    original_sql: str | None = None,
) -> dict[str, Any]:
    """
    校验单段 SQL（通常为从 AI 回复中抽出的代码块）。

    1. 方言检查（SQLGlot）
    2. 非法关键字（如 Oracle 出现 LIMIT）
    3. 若提供 original_sql：比对顶层 WHERE 是否被改写
    """
    errors: list[str] = []
    warnings: list[str] = []

    s = (sql or "").strip()
    if not s:
        return {"ok": False, "errors": ["SQL 为空"], "warnings": []}

    errors.extend(_dialect_parse_check(s, db_type))
    errors.extend(_illegal_keyword_check(s, db_type))
    warnings.extend(_predicate_check(original_sql, s, db_type))

    ok = len(errors) == 0
    return {"ok": ok, "errors": errors, "warnings": warnings}
