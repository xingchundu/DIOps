"""
SQL 规则引擎 — 确定性 SQL 分析，不依赖 LLM
使用 sqlglot AST 解析 + 正则兜底
"""

import re
from typing import Any

try:
    import sqlglot
    from sqlglot import exp
    HAS_SQLGLOT = True
except ImportError:
    HAS_SQLGLOT = False


# ── 索引信息解析 ──────────────────────────────────────────

def _parse_indexes(schema_text: str) -> dict[str, list[list[str]]]:
    """从 schema 伪 DDL 中提取索引信息。
    返回: {table_name: [[col1, col2], [col3], ...]}
    """
    indexes: dict[str, list[list[str]]] = {}
    # 匹配: CREATE [UNIQUE] INDEX idx_name ON table_name (col1, col2)
    pattern = re.compile(
        r"CREATE\s+(?:UNIQUE\s+)?INDEX\s+\S+\s+ON\s+(\S+)\s*\(([^)]+)\)",
        re.IGNORECASE,
    )
    for m in pattern.finditer(schema_text):
        table = m.group(1).strip().strip('"`')
        cols = [c.strip().strip('"`') for c in m.group(2).split(",")]
        indexes.setdefault(table, []).append(cols)
    return indexes


def _extract_tables_from_schema(schema_text: str) -> set[str]:
    """从 schema 中提取表名集合。"""
    tables: set[str] = set()
    for m in re.finditer(r"CREATE\s+TABLE\s+(\S+)", schema_text, re.IGNORECASE):
        tables.add(m.group(1).strip().strip('"`'))
    return tables


# ── AST 辅助 ──────────────────────────────────────────────

def _try_parse(sql: str, db_type: str):
    """尝试用 sqlglot 解析，失败返回 None。"""
    if not HAS_SQLGLOT:
        return None
    dialect_map = {"oracle": "oracle", "postgresql": "postgres", "postgres": "postgres", "mysql": "mysql"}
    dialect = dialect_map.get(db_type.lower())
    try:
        return sqlglot.parse_one(sql, read=dialect)
    except Exception:
        try:
            return sqlglot.parse_one(sql)
        except Exception:
            return None


def _count_tables_from_sql(sql_text: str) -> int:
    """正则估算 FROM/JOIN 中的表数量。"""
    # 提取 FROM 到 WHERE/GROUP/ORDER/LIMIT 之间的内容
    from_match = re.search(
        r"\bFROM\b(.+?)(?:\bWHERE\b|\bGROUP\b|\bORDER\b|\bLIMIT\b|\bUNION\b|\bHAVING\b|$)",
        sql_text, re.IGNORECASE | re.DOTALL,
    )
    if not from_match:
        return 0
    from_body = from_match.group(1)
    # 按逗号和 JOIN 分割，过滤空串
    parts = re.split(r"\s*,\s*|\bJOIN\b", from_body, flags=re.IGNORECASE)
    return len([p for p in parts if p.strip()])


# ── 单条规则检查函数 ──────────────────────────────────────

def _check_select_star(ast, sql_text: str, db_type: str, schema_info: dict) -> list[dict] | None:
    has_select_star = False
    if ast:
        for node in ast.find_all(exp.Select):
            for col in node.expressions:
                if isinstance(col, exp.Star):
                    has_select_star = True
                    break
    else:
        has_select_star = bool(re.search(r"SELECT\s+\*\s", sql_text, re.IGNORECASE))

    if not has_select_star:
        return None

    has_where = False
    has_limit = False
    if ast:
        has_where = ast.find(exp.Where) is not None
        has_limit = ast.find(exp.Limit) is not None
    else:
        has_where = bool(re.search(r"\bWHERE\b", sql_text, re.IGNORECASE))
        has_limit = bool(re.search(r"\bLIMIT\b|\bFETCH\s+FIRST\b|\bROWNUM\b", sql_text, re.IGNORECASE))

    rules = []
    if not has_where and not has_limit:
        rules.append({
            "id": "RULE_SELECT_STAR",
            "severity": "high",
            "title": "SELECT * 无过滤条件",
            "detail": "SELECT * 且无 WHERE/LIMIT，将返回全表数据",
            "suggestion": "明确列出需要的列，或添加 WHERE/LIMIT 限制返回行数",
        })
    elif not has_where and has_limit:
        rules.append({
            "id": "RULE_SELECT_STAR_LIMIT",
            "severity": "medium",
            "title": "SELECT * 仅有 LIMIT",
            "detail": "SELECT * 有 LIMIT 但无 WHERE，每次扫描仍可能读取大量数据",
            "suggestion": "添加 WHERE 条件利用索引过滤，避免大范围扫描",
        })
    return rules or None


def _check_not_in(ast, sql_text: str, db_type: str, schema_info: dict) -> list[dict] | None:
    found = False
    if ast:
        for node in ast.find_all(exp.Not):
            if node.find(exp.In):
                found = True
                break
    if not found:
        found = bool(re.search(r"NOT\s+IN\s*\(\s*SELECT\b", sql_text, re.IGNORECASE))
    if not found:
        return None
    return [{
        "id": "RULE_NOT_IN",
        "severity": "medium",
        "title": "NOT IN (子查询) 可能导致性能问题",
        "detail": "NOT IN 子查询在 NULL 值存在时结果可能不符合预期，且优化器难以生成高效计划",
        "suggestion": "改写为 NOT EXISTS：\nNOT EXISTS (SELECT 1 FROM ... WHERE outer.col = inner.col)",
    }]


def _check_implicit_cast(ast, sql_text: str, db_type: str, schema_info: dict) -> list[dict] | None:
    # 简单正则检测：列名 = 纯数字（可能是 varchar 列与数字比较）
    if not re.search(r"\bWHERE\b", sql_text, re.IGNORECASE):
        return None
    # 检测 WHERE col = 123（无引号数字）且列名看起来像字符串列
    m = re.findall(
        r"(\w+)\s*=\s*(\d+)(?:\s|,|$|\))",
        sql_text[re.search(r"\bWHERE\b", sql_text, re.IGNORECASE).start():],
        re.IGNORECASE,
    )
    if not m:
        return None
    # 检查 schema 中是否有这些列是 varchar/char 类型
    warnings = []
    schema_lower = schema_info.get("schema_text", "").lower()
    for col_name, val in m:
        # 在 schema 中查找列定义
        col_pattern = re.compile(
            rf"{re.escape(col_name)}\s+(?:VARCHAR|VARCHAR2|CHAR|TEXT|CHARACTER)\b",
            re.IGNORECASE,
        )
        if col_pattern.search(schema_lower):
            warnings.append({
                "id": "RULE_IMPLICIT_CAST",
                "severity": "medium",
                "title": f"隐式类型转换: {col_name} = {val}",
                "detail": f"列 {col_name} 为字符串类型，但与数字 {val} 比较，可能导致索引失效",
                "suggestion": f"使用显式类型匹配：{col_name} = '{val}'",
            })
    return warnings or None


def _check_cartesian(ast, sql_text: str, db_type: str, schema_info: dict) -> list[dict] | None:
    table_count = 0
    has_join_keyword = bool(re.search(r"\bJOIN\b", sql_text, re.IGNORECASE))
    has_on_clause = bool(re.search(r"\bON\b", sql_text, re.IGNORECASE))

    if ast:
        table_count = len(list(ast.find_all(exp.Table)))
    else:
        table_count = _count_tables_from_sql(sql_text)

    if table_count < 2:
        return None

    # 多表 FROM 但没有 JOIN ON
    has_comma_join = bool(re.search(r"FROM\s+[^,]+,\s*\S+", sql_text, re.IGNORECASE))
    has_where_join = bool(re.search(r"\bWHERE\b", sql_text, re.IGNORECASE))

    if has_comma_join and not has_where_join:
        return [{
            "id": "RULE_CARTESIAN",
            "severity": "high",
            "title": "笛卡尔积：多表无关联条件",
            "detail": f"FROM 子句包含 {table_count} 个表但缺少 JOIN/ON 或 WHERE 关联条件",
            "suggestion": "添加 JOIN ON 条件或 WHERE 子句中的表关联条件",
        }]

    if has_join_keyword and not has_on_clause:
        return [{
            "id": "RULE_CARTESIAN",
            "severity": "high",
            "title": "笛卡尔积：JOIN 缺少 ON 条件",
            "detail": "使用了 JOIN 但缺少 ON 关联条件",
            "suggestion": "为每个 JOIN 添加 ON 条件",
        }]

    return None


def _check_or_index(ast, sql_text: str, db_type: str, schema_info: dict) -> list[dict] | None:
    has_or = False
    if ast:
        where = ast.find(exp.Where)
        if where:
            for node in where.find_all(exp.Or):
                has_or = True
                break
    else:
        # 正则：WHERE ... OR ...（排除 UNION ALL 等上下文）
        where_match = re.search(r"\bWHERE\b(.+?)(?:ORDER|GROUP|LIMIT|UNION|$)", sql_text, re.IGNORECASE | re.DOTALL)
        if where_match:
            has_or = bool(re.search(r"\bOR\b", where_match.group(1), re.IGNORECASE))

    if not has_or:
        return None
    return [{
        "id": "RULE_OR_INDEX",
        "severity": "medium",
        "title": "WHERE 中 OR 条件可能导致索引失效",
        "detail": "OR 条件通常使优化器无法使用单列索引",
        "suggestion": "考虑改写为 UNION ALL，或使用复合索引覆盖 OR 中的列",
    }]


def _check_subquery_to_join(ast, sql_text: str, db_type: str, schema_info: dict) -> list[dict] | None:
    # 检测 IN (SELECT ...) 或 EXISTS (SELECT ...)
    has_in_sub = bool(re.search(r"\bIN\s*\(\s*SELECT\b", sql_text, re.IGNORECASE))
    has_exists_sub = bool(re.search(r"\bEXISTS\s*\(\s*SELECT\b", sql_text, re.IGNORECASE))
    if not (has_in_sub or has_exists_sub):
        return None
    return [{
        "id": "RULE_SUBQUERY_TO_JOIN",
        "severity": "low",
        "title": "子查询可考虑改写为 JOIN",
        "detail": "IN/EXISTS 子查询在某些场景下不如 JOIN 高效",
        "suggestion": "评估是否可以改写为 INNER JOIN 或 LEFT JOIN + IS NULL/IS NOT NULL",
    }]


def _check_large_offset(ast, sql_text: str, db_type: str, schema_info: dict) -> list[dict] | None:
    offset_val = None
    if ast:
        offset_node = ast.find(exp.Offset)
        if offset_node:
            try:
                offset_val = int(offset_node.expression.this)
            except (AttributeError, ValueError, TypeError):
                pass
    if offset_val is None:
        m = re.search(r"\bOFFSET\s+(\d+)", sql_text, re.IGNORECASE)
        if m:
            offset_val = int(m.group(1))
    if offset_val is None or offset_val <= 1000:
        return None
    return [{
        "id": "RULE_LARGE_OFFSET",
        "severity": "medium",
        "title": f"OFFSET {offset_val} 过大",
        "detail": f"OFFSET {offset_val} 需要数据库先扫描并丢弃前 {offset_val} 行",
        "suggestion": "改用 keyset 分页（基于上一页最后一行的主键/排序键），例如：WHERE id > last_id ORDER BY id LIMIT N",
    }]


def _check_index_col_order(ast, sql_text: str, db_type: str, schema_info: dict) -> list[dict] | None:
    indexes = schema_info.get("indexes", {})
    if not indexes:
        return None

    # 提取 WHERE 中的等值和范围条件列
    eq_cols: list[str] = []
    range_cols: list[str] = []
    if ast:
        where = ast.find(exp.Where)
        if where:
            for pred in where.find_all(exp.Predicate):
                if isinstance(pred, exp.EQ):
                    col = pred.left
                    if isinstance(col, exp.Column):
                        eq_cols.append(col.name.upper())
                elif isinstance(pred, (exp.GT, exp.GTE, exp.LT, exp.LTE, exp.Between)):
                    col = pred.left if hasattr(pred, "left") else pred.find(exp.Column)
                    if isinstance(col, exp.Column):
                        range_cols.append(col.name.upper())
    else:
        # 简单正则
        where_match = re.search(r"\bWHERE\b(.+?)(?:ORDER|GROUP|LIMIT|UNION|$)", sql_text, re.IGNORECASE | re.DOTALL)
        if where_match:
            where_text = where_match.group(1)
            eq_cols = [m.upper() for m in re.findall(r"(\w+)\s*=", where_text)]
            range_cols = [m.upper() for m in re.findall(r"(\w+)\s*(?:>|>=|<|<=|BETWEEN)", where_text)]

    if not eq_cols or not range_cols:
        return None

    suggestions = []
    for table, idx_list in indexes.items():
        for idx_cols in idx_list:
            idx_upper = [c.upper() for c in idx_cols]
            if len(idx_upper) < 2:
                continue
            # 检查是否有范围列排在等值列前面
            for i, col in enumerate(idx_upper):
                if col in range_cols:
                    # 检查前面是否有等值列未出现在索引中
                    preceding_eq = [c for c in eq_cols if c in idx_upper[:i]]
                    if not preceding_eq:
                        for eq in eq_cols:
                            if eq in idx_upper[i + 1:]:
                                suggestions.append(
                                    f"索引 {table}({', '.join(idx_cols)}) 中范围列 {col} 在等值列 {eq} 之前"
                                )
    if not suggestions:
        return None
    return [{
        "id": "RULE_INDEX_COL_ORDER",
        "severity": "low",
        "title": "索引列顺序可优化",
        "detail": "; ".join(suggestions),
        "suggestion": "将等值条件列放在索引前部，范围条件列放在后面，以提高索引利用率",
    }]


def _check_missing_where(ast, sql_text: str, db_type: str, schema_info: dict) -> list[dict] | None:
    # 仅检查 UPDATE/DELETE
    is_update = bool(re.search(r"\bUPDATE\b", sql_text, re.IGNORECASE)) and not re.search(r"\bSELECT\b", sql_text, re.IGNORECASE)
    is_delete = bool(re.search(r"\bDELETE\s+FROM\b", sql_text, re.IGNORECASE))
    if not (is_update or is_delete):
        return None

    has_where = False
    if ast:
        has_where = ast.find(exp.Where) is not None
    else:
        has_where = bool(re.search(r"\bWHERE\b", sql_text, re.IGNORECASE))

    if has_where:
        return None
    return [{
        "id": "RULE_MISSING_WHERE",
        "severity": "high",
        "title": "UPDATE/DELETE 无 WHERE 条件",
        "detail": "将影响全表所有行，可能导致数据丢失或大量锁",
        "suggestion": "添加 WHERE 条件限定影响范围，或先用 SELECT 确认影响行数",
    }]


def _check_like_prefix(ast, sql_text: str, db_type: str, schema_info: dict) -> list[dict] | None:
    found = False
    if ast:
        for like_node in ast.find_all(exp.Like):
            pattern_node = like_node.expression
            if isinstance(pattern_node, exp.Literal):
                val = pattern_node.this
                if isinstance(val, str) and val.startswith("%"):
                    found = True
                    break
    if not found:
        found = bool(re.search(r"LIKE\s+'%", sql_text, re.IGNORECASE))
    if not found:
        return None
    return [{
        "id": "RULE_LIKE_PREFIX",
        "severity": "medium",
        "title": "LIKE 前缀通配符导致索引失效",
        "detail": "LIKE '%xxx' 无法使用 B-tree 索引，将触发全表扫描",
        "suggestion": "如果可能，改为 'xxx%' 前缀匹配；或使用全文索引（Oracle Full-Text / PG tsvector / MySQL FULLTEXT）",
    }]


def _check_func_on_index(ast, sql_text: str, db_type: str, schema_info: dict) -> list[dict] | None:
    indexes = schema_info.get("indexes", {})
    if not indexes:
        return None

    indexed_cols: set[str] = set()
    for idx_list in indexes.values():
        for idx_cols in idx_list:
            indexed_cols.update(c.upper() for c in idx_cols)

    if not indexed_cols:
        return None

    # 检测 WHERE 中对索引列使用函数：FUNC(col) op value
    func_on_col = []
    if ast:
        where = ast.find(exp.Where)
        if where:
            for func in where.find_all(exp.Func):
                for col in func.find_all(exp.Column):
                    if col.name.upper() in indexed_cols:
                        func_on_col.append(f"{func.sql_name()}({col.name})")
    else:
        # 正则兜底
        where_match = re.search(r"\bWHERE\b(.+?)(?:ORDER|GROUP|LIMIT|UNION|$)", sql_text, re.IGNORECASE | re.DOTALL)
        if where_match:
            where_text = where_match.group(1)
            for m in re.finditer(r"(\w+)\s*\(\s*(\w+)\s*\)", where_text):
                func_name, col_name = m.group(1), m.group(2)
                if col_name.upper() in indexed_cols and func_name.upper() not in ("AND", "OR", "NOT", "IN", "EXISTS"):
                    func_on_col.append(f"{func_name}({col_name})")

    if not func_on_col:
        return None
    return [{
        "id": "RULE_FUNC_ON_INDEX",
        "severity": "medium",
        "title": "索引列上使用函数导致索引失效",
        "detail": f"WHERE 中对索引列使用了函数：{', '.join(set(func_on_col))}",
        "suggestion": "将函数应用到值而非列，或创建函数索引（Oracle: CREATE INDEX idx ON t(FUNC(col))；PG: CREATE INDEX idx ON t(expression)）",
    }]


def _check_count_star_innodb(ast, sql_text: str, db_type: str, schema_info: dict) -> list[dict] | None:
    if db_type.lower() != "mysql":
        return None
    has_count_star = bool(re.search(r"COUNT\s*\(\s*\*\s*\)", sql_text, re.IGNORECASE))
    has_where = bool(re.search(r"\bWHERE\b", sql_text, re.IGNORECASE))
    if not has_count_star or has_where:
        return None
    return [{
        "id": "RULE_COUNT_STAR_INNODB",
        "severity": "low",
        "title": "MySQL InnoDB COUNT(*) 无 WHERE 较慢",
        "detail": "InnoDB 不维护行数缓存，COUNT(*) 无 WHERE 需全表扫描",
        "suggestion": "使用 SHOW TABLE STATUS 获取估算行数，或维护缓存计数表",
    }]


# ── 规则注册表 ────────────────────────────────────────────

_ALL_RULES = [
    _check_select_star,
    _check_not_in,
    _check_implicit_cast,
    _check_cartesian,
    _check_or_index,
    _check_subquery_to_join,
    _check_large_offset,
    _check_index_col_order,
    _check_missing_where,
    _check_like_prefix,
    _check_func_on_index,
    _check_count_star_innodb,
]


# ── 主入口 ────────────────────────────────────────────────

def analyze_sql(sql: str, db_type: str, schema: str = "", explain_result: str = "") -> dict:
    """
    对 SQL 做确定性规则检查。
    返回: {"rules": [...], "summary": "..."}
    """
    if not sql or not sql.strip():
        return {"rules": [], "summary": "未提供 SQL"}

    ast = _try_parse(sql, db_type)
    schema_info = {
        "schema_text": schema,
        "indexes": _parse_indexes(schema),
        "tables": _extract_tables_from_schema(schema),
    }

    all_rules: list[dict[str, Any]] = []
    for rule_fn in _ALL_RULES:
        try:
            result = rule_fn(ast, sql, db_type, schema_info)
            if result:
                all_rules.extend(result)
        except Exception:
            # 单条规则失败不影响整体
            continue

    count = len(all_rules)
    if count == 0:
        summary = "规则引擎未发现明显问题"
    else:
        high = sum(1 for r in all_rules if r["severity"] == "high")
        medium = sum(1 for r in all_rules if r["severity"] == "medium")
        low = sum(1 for r in all_rules if r["severity"] == "low")
        parts = []
        if high:
            parts.append(f"{high} 个高风险")
        if medium:
            parts.append(f"{medium} 个中风险")
        if low:
            parts.append(f"{low} 个低风险")
        summary = f"规则引擎发现 {count} 个问题（{', '.join(parts)}）"

    return {"rules": all_rules, "summary": summary}
