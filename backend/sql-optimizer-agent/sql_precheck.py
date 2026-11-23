"""
优化前的 SQL 预检：先判断“这条语句按所选数据库类型是否正确”，再决定是否进入优化。

输出 {
  ok:            能否进入优化（无阻断错误）
  dbType/dialect:所选类型 / 校验方言
  statements:    语句条数（多条时只优化第一条，其余提示）
  stmtType:      SELECT / INSERT / UPDATE / DELETE / DDL / OTHER
  errors:        阻断性问题（语法错误、方言不匹配）
  warnings:      非阻断提示（多语句、DML 只做规则检查等）
  likelyDialect: 语法错误时，推测更像哪种数据库的写法
  sql:           清理后用于优化的单条语句
}
只做静态判断，不连库、不执行。
"""
from __future__ import annotations

import re

from sqlglot import exp, parse
from sqlglot.errors import ParseError, TokenError

from sql_validator import _ILLEGAL, _normalize_db_type, _sqlglot_dialect_name

_CANDIDATES = ("oracle", "mysql", "postgres", "tsql")
_PLSQL_RE = re.compile(r"(?is)^\s*(DECLARE|BEGIN|CREATE\s+(OR\s+REPLACE\s+)?(PROCEDURE|FUNCTION|PACKAGE|TRIGGER))\b")


def _strip_comments(sql: str) -> str:
    s = re.sub(r"/\*.*?\*/", " ", sql or "", flags=re.S)
    s = re.sub(r"(?m)--[^\n]*", " ", s)
    return s.strip()


def _split_statements(sql: str) -> list[str]:
    """按分号切分（忽略引号内分号）。简单状态机，够用于预检。"""
    out, cur, q = [], [], None
    for ch in sql or "":
        if q:
            cur.append(ch)
            if ch == q:
                q = None
        elif ch in ("'", '"', "`"):
            q = ch
            cur.append(ch)
        elif ch == ";":
            t = "".join(cur).strip()
            if t:
                out.append(t)
            cur = []
        else:
            cur.append(ch)
    t = "".join(cur).strip()
    if t:
        out.append(t)
    return out


def _try(sql: str, dialect: str) -> bool:
    try:
        parse(sql, dialect=dialect)
        return True
    except (ParseError, TokenError):
        return False
    except Exception:  # noqa: BLE001
        return False


def _stmt_type(sql: str) -> str:
    head = re.match(r"(?is)^\s*\(?\s*(\w+)", _strip_comments(sql))
    w = head.group(1).upper() if head else ""
    if w in ("SELECT", "WITH"):
        return "SELECT"
    if w in ("INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE"):
        return w if w != "REPLACE" else "INSERT"
    if w in ("CREATE", "ALTER", "DROP", "TRUNCATE"):
        return "DDL"
    return "OTHER"


def precheck(sql: str, db_type: str) -> dict:
    """对外入口：保证永不抛异常（接口层不会因 SQL 文本 500）。"""
    try:
        return _precheck(sql, db_type)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "dbType": db_type, "dialect": None, "errors": [f"SQL 预检异常: {str(e)[:120]}"],
                "warnings": [], "statements": 0, "stmtType": "OTHER", "likelyDialect": None, "sql": (sql or "").strip()}


def _precheck(sql: str, db_type: str) -> dict:
    raw = (sql or "").strip()
    dialect = _sqlglot_dialect_name(db_type)
    res: dict = {"ok": True, "dbType": db_type, "dialect": dialect, "errors": [], "warnings": [],
                 "statements": 0, "stmtType": "OTHER", "likelyDialect": None, "sql": raw}
    if not raw:
        res.update(ok=False, errors=["SQL 为空"])
        return res
    if _PLSQL_RE.match(raw):
        res.update(ok=False, stmtType="PLSQL",
                   errors=["检测到存储过程/匿名块（PL/SQL、PL/pgSQL 等），不属于单条 SQL 优化范围，请提取其中的 SQL 语句分别优化"])
        return res

    stmts = _split_statements(raw)
    res["statements"] = len(stmts)
    if not stmts or not _strip_comments(stmts[0]):
        res.update(ok=False, errors=["SQL 为空（仅含注释）"])
        return res
    if len(stmts) > 1:
        res["warnings"].append(f"检测到 {len(stmts)} 条语句，仅对第 1 条进行优化")
    first = stmts[0]
    res["sql"] = first
    res["stmtType"] = _stmt_type(first)

    # 1) 语法：按所选数据库的方言解析
    if not _try(first, dialect):
        res["ok"] = False
        res["errors"].append(f"SQL 按「{db_type}」语法解析失败，请检查括号/引号/关键字")
        others = [d for d in _CANDIDATES if d != dialect and _try(first, d)]
        if others:
            res["likelyDialect"] = others[0]
            res["errors"].append(f"该语句可以按 {', '.join(others)} 语法解析，更像是其它数据库的写法，请确认所选数据库类型是否正确")
    # 2) 方言专有写法（即便能解析，也可能在目标库不可用）
    for rx, msg in _ILLEGAL.get(_normalize_db_type(db_type), []):
        if rx.search(first):
            res["ok"] = False
            res["errors"].append(msg)
    # 3) 语句类型
    t = res["stmtType"]
    if t in ("INSERT", "UPDATE", "DELETE", "MERGE"):
        res["warnings"].append(f"{t} 语句：只做规则检查与索引建议，不生成改写 SQL，也不会执行")
    elif t == "DDL":
        res["warnings"].append("DDL 语句不属于性能优化范围，仅做语法检查")
    elif t == "OTHER":
        res["warnings"].append("无法识别语句类型，请确认输入的是 SELECT/DML 语句")
    # 4) 无 WHERE 的更新/删除
    if t in ("UPDATE", "DELETE") and not re.search(r"(?i)\bWHERE\b", first):
        res["warnings"].append(f"{t} 没有 WHERE 条件，将影响全表数据，请务必确认")
    return res
