"""
EXPLAIN 深度分析器 — 结构化解析 Oracle/PG/MySQL 执行计划
"""

import re
import json
from typing import Any


def analyze_explain(explain_text: str, db_type: str) -> dict:
    """
    结构化解析 EXPLAIN 输出，识别高代价操作。
    返回: {"operations": [...], "issues": [...], "total_cost": int|None, "summary": "..."}
    """
    if not explain_text or not explain_text.strip():
        return {"operations": [], "issues": [], "total_cost": None, "summary": "无执行计划"}

    db = db_type.lower()
    if db == "oracle":
        return _analyze_oracle(explain_text)
    elif db in ("postgresql", "postgres"):
        return _analyze_postgresql(explain_text)
    elif db == "mysql":
        return _analyze_mysql(explain_text)
    else:
        return {"operations": [], "issues": [], "total_cost": None, "summary": f"不支持的数据库类型: {db_type}"}


# ── Oracle ────────────────────────────────────────────────

_ORACLE_LINE_RE = re.compile(
    r"^(\s*)"                          # indent
    r"([\w\s]+?)"                      # operation (+ options)
    r"(?:\s+\[([^\]]+)\])?"           # [object_name]
    r"(?:\s+Cost=(\d+))?"             # Cost=N
    r"(?:\s+Rows=(\d+))?"             # Rows=N
    r"(?:\s+Bytes=(\d+))?"            # Bytes=N
    r"\s*$",
    re.IGNORECASE,
)


def _analyze_oracle(text: str) -> dict:
    operations: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []
    total_cost = 0

    for line in text.splitlines():
        line = line.rstrip()
        if not line or line.startswith("Oracle") or line.startswith("-"):
            continue
        m = _ORACLE_LINE_RE.match(line)
        if not m:
            continue
        indent = len(m.group(1))
        op_raw = m.group(2).strip()
        table = m.group(3) or ""
        cost = int(m.group(4)) if m.group(4) else None
        rows = int(m.group(5)) if m.group(5) else None
        bytes_ = int(m.group(6)) if m.group(6) else None
        level = indent // 2

        flag = ""
        op_upper = op_raw.upper()
        if "TABLE ACCESS FULL" in op_upper:
            flag = "full_scan"
        elif "SORT" in op_upper and rows and rows > 10000:
            flag = "large_sort"
        elif "HASH JOIN" in op_upper and rows and rows > 100000:
            flag = "large_hash_join"

        op_entry = {
            "op": op_raw,
            "table": table,
            "cost": cost,
            "rows": rows,
            "bytes": bytes_,
            "level": level,
            "flag": flag,
        }
        operations.append(op_entry)

        if cost and cost > total_cost:
            total_cost = cost

    # 生成 issues
    for op in operations:
        if op["flag"] == "full_scan":
            row_desc = f"，预估 {op['rows']} 行" if op["rows"] else ""
            issues.append({
                "type": "full_scan",
                "detail": f"全表扫描 {op['table']}{row_desc}",
                "suggestion": "建议在 WHERE 条件列上创建索引",
            })
        elif op["flag"] == "large_sort":
            issues.append({
                "type": "large_sort",
                "detail": f"排序操作预估 {op['rows']} 行，可能使用临时表空间",
                "suggestion": "检查是否可以利用索引避免排序，或减小排序数据量",
            })
        elif op["flag"] == "large_hash_join":
            issues.append({
                "type": "large_hash_join",
                "detail": f"哈希连接预估 {op['rows']} 行",
                "suggestion": "确认驱动表选择正确，考虑添加索引使用 NESTED LOOPS",
            })

    summary = _build_summary(operations, issues, total_cost)
    return {"operations": operations, "issues": issues, "total_cost": total_cost or None, "summary": summary}


# ── PostgreSQL ────────────────────────────────────────────

_PG_SEQ_SCAN_RE = re.compile(r"Seq Scan\s+on\s+(\S+)", re.IGNORECASE)
_PG_COST_RE = re.compile(r"\(cost=[\d.]+..([\d.]+)\s+rows=(\d+)", re.IGNORECASE)
_PG_ACTUAL_RE = re.compile(r"actual time=[\d.]+..([\d.]+)\s+rows=(\d+)", re.IGNORECASE)
_PG_SORT_RE = re.compile(r"Sort\s+Method|Sort\s+\(", re.IGNORECASE)
_PG_HASH_JOIN_RE = re.compile(r"Hash Join", re.IGNORECASE)


def _analyze_postgresql(text: str) -> dict:
    operations: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []
    total_cost = 0.0

    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue

        # 提取层级（前导 -> 箭头数）
        level = line.count("->")

        # 提取操作名和表名
        op_name = stripped.split("(")[0].strip().lstrip("->").strip()
        table = ""
        m_table = re.search(r"on\s+(\S+)", op_name, re.IGNORECASE)
        if m_table:
            table = m_table.group(1)
            op_name = op_name[: m_table.start()].strip()

        # 提取 cost
        cost_end = None
        rows_est = None
        m_cost = _PG_COST_RE.search(stripped)
        if m_cost:
            cost_end = float(m_cost.group(1))
            rows_est = int(m_cost.group(2))
            if cost_end > total_cost:
                total_cost = cost_end

        # 提取 actual
        actual_rows = None
        m_actual = _PG_ACTUAL_RE.search(stripped)
        if m_actual:
            actual_rows = int(m_actual.group(1))

        flag = ""
        upper = stripped.upper()
        if "SEQ SCAN" in upper:
            flag = "full_scan"
        elif "SORT" in upper and (rows_est and rows_est > 10000):
            flag = "large_sort"
        elif "HASH JOIN" in upper and (rows_est and rows_est > 100000):
            flag = "large_hash_join"

        operations.append({
            "op": op_name or stripped.split()[0],
            "table": table,
            "cost": cost_end,
            "rows": actual_rows or rows_est,
            "level": level,
            "flag": flag,
        })

    for op in operations:
        if op["flag"] == "full_scan":
            row_desc = f"，预估 {op['rows']} 行" if op["rows"] else ""
            issues.append({
                "type": "full_scan",
                "detail": f"顺序扫描 {op['table']}{row_desc}",
                "suggestion": "建议在 WHERE 条件列上创建索引",
            })
        elif op["flag"] == "large_sort":
            issues.append({
                "type": "large_sort",
                "detail": f"排序操作预估 {op['rows']} 行",
                "suggestion": "考虑添加与 ORDER BY 匹配的索引",
            })
        elif op["flag"] == "large_hash_join":
            issues.append({
                "type": "large_hash_join",
                "detail": f"哈希连接预估 {op['rows']} 行",
                "suggestion": "确认连接条件列上有索引",
            })

    summary = _build_summary(operations, issues, total_cost)
    return {"operations": operations, "issues": issues, "total_cost": total_cost or None, "summary": summary}


# ── MySQL ─────────────────────────────────────────────────

_MYSQL_TYPE_SEVERITY = {
    "ALL": "full_scan",
    "index": "index_scan",
}


def _analyze_mysql(text: str) -> dict:
    operations: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []
    total_cost = None

    # 尝试解析 JSON 格式
    json_match = re.search(r"\{[\s\S]*\"query_block\"[\s\S]*\}", text)
    if json_match:
        try:
            jdata = json.loads(json_match.group(0))
            _parse_mysql_json(jdata, operations, issues)
            summary = _build_summary(operations, issues, total_cost)
            return {"operations": operations, "issues": issues, "total_cost": total_cost, "summary": summary}
        except (json.JSONDecodeError, KeyError):
            pass

    # 回退：解析表格格式
    lines = text.splitlines()
    if len(lines) < 3:
        return {"operations": [], "issues": [], "total_cost": None, "summary": "EXPLAIN 输出过短"}

    # 解析表头
    headers = [h.strip() for h in lines[0].split("|")]
    # 查找关键列索引
    type_idx = headers.index("type") if "type" in headers else None
    key_idx = headers.index("key") if "key" in headers else None
    rows_idx = headers.index("rows") if "rows" in headers else None
    extra_idx = headers.index("Extra") if "Extra" in headers else None
    table_idx = headers.index("table") if "table" in headers else None

    for line in lines[2:]:  # 跳过表头和分隔线
        if not line.strip() or line.startswith("-"):
            continue
        cols = [c.strip() for c in line.split("|")]
        if len(cols) < len(headers):
            continue

        table = cols[table_idx] if table_idx is not None and table_idx < len(cols) else ""
        scan_type = cols[type_idx] if type_idx is not None and type_idx < len(cols) else ""
        key = cols[key_idx] if key_idx is not None and key_idx < len(cols) else ""
        rows_est = None
        if rows_idx is not None and rows_idx < len(cols):
            try:
                rows_est = int(cols[rows_idx])
            except (ValueError, IndexError):
                pass
        extra = cols[extra_idx] if extra_idx is not None and extra_idx < len(cols) else ""

        flag = ""
        if scan_type.upper() == "ALL":
            flag = "full_scan"
        elif scan_type.upper() == "INDEX":
            flag = "index_scan"

        operations.append({
            "op": f"scan_type={scan_type}",
            "table": table,
            "key": key or None,
            "rows": rows_est,
            "extra": extra,
            "flag": flag,
        })

        if flag == "full_scan":
            row_desc = f"，预估 {rows_est} 行" if rows_est else ""
            issues.append({
                "type": "full_scan",
                "detail": f"全表扫描 {table}{row_desc}",
                "suggestion": "建议在 WHERE 条件列上创建索引",
            })

        if "Using filesort" in extra:
            issues.append({
                "type": "filesort",
                "detail": f"表 {table} 使用文件排序",
                "suggestion": "考虑添加与 ORDER BY 匹配的索引",
            })
        if "Using temporary" in extra:
            issues.append({
                "type": "temporary",
                "detail": f"表 {table} 使用临时表",
                "suggestion": "检查 GROUP BY/ORDER BY 是否可以利用索引",
            })

    summary = _build_summary(operations, issues, total_cost)
    return {"operations": operations, "issues": issues, "total_cost": total_cost, "summary": summary}


def _parse_mysql_json(jdata: dict, operations: list, issues: list):
    """递归解析 MySQL EXPLAIN FORMAT=JSON。"""
    qb = jdata.get("query_block", {})
    table_info = qb.get("table", {})
    if table_info:
        table_name = table_info.get("table_name", "")
        access_type = table_info.get("access_type", "")
        key = table_info.get("key", "")
        rows_examined = table_info.get("rows_examined_per_scan", None)

        flag = ""
        if access_type == "ALL":
            flag = "full_scan"
        elif access_type == "index":
            flag = "index_scan"

        operations.append({
            "op": f"access_type={access_type}",
            "table": table_name,
            "key": key or None,
            "rows": rows_examined,
            "flag": flag,
        })

        if flag == "full_scan":
            row_desc = f"，预估 {rows_examined} 行" if rows_examined else ""
            issues.append({
                "type": "full_scan",
                "detail": f"全表扫描 {table_name}{row_desc}",
                "suggestion": "建议在 WHERE 条件列上创建索引",
            })

    # 递归处理嵌套查询
    for nested in qb.get("nested_loop", []):
        if isinstance(nested, dict):
            _parse_mysql_json({"query_block": nested}, operations, issues)


# ── 通用 ──────────────────────────────────────────────────

def _build_summary(operations: list, issues: list, total_cost) -> str:
    if not operations:
        return "未解析到执行计划操作"
    full_scans = sum(1 for op in operations if op.get("flag") == "full_scan")
    parts = [f"共 {len(operations)} 个操作"]
    if full_scans:
        parts.append(f"{full_scans} 个全表扫描")
    if total_cost:
        parts.append(f"总代价 {total_cost}")
    if issues:
        parts.append(f"{len(issues)} 个潜在问题")
    return "，".join(parts)
