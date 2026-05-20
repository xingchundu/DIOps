"""
数据库服务层
支持 Oracle (oracledb thin 模式，无需客户端) / PostgreSQL / MySQL
"""

import re
from typing import Dict, List


# ── 连接工厂 ──────────────────────────────────────────────
def get_connection(config: Dict):
    db_type = config.get("type", "").lower()
    host = config.get("host", "localhost")
    port = config.get("port", "")
    database = config.get("database", "")
    username = config.get("username", "")
    password = config.get("password", "")

    if db_type == "oracle":
        import oracledb
        port = port or "1521"
        # thin 模式：无需安装 Oracle Instant Client
        conn = oracledb.connect(
            user=username,
            password=password,
            dsn=f"{host}:{port}/{database}",
            mode=oracledb.DEFAULT_AUTH,
        )
        return conn, "oracle"

    elif db_type == "postgresql":
        import psycopg2
        port = port or "5432"
        conn = psycopg2.connect(
            host=host,
            port=int(port),
            dbname=database,
            user=username,
            password=password,
            connect_timeout=10,
        )
        return conn, "postgresql"

    elif db_type == "mysql":
        import pymysql
        port = port or "3306"
        conn = pymysql.connect(
            host=host,
            port=int(port),
            db=database,
            user=username,
            password=password,
            charset="utf8mb4",
            connect_timeout=10,
        )
        return conn, "mysql"

    raise ValueError(f"不支持的数据库类型: {db_type}，请选择 oracle / postgresql / mysql")


def test_db_connection(config: Dict) -> Dict:
    try:
        conn, db_type = get_connection(config)
        cursor = conn.cursor()
        if db_type == "oracle":
            cursor.execute("SELECT 1 FROM DUAL")
        else:
            cursor.execute("SELECT 1")
        cursor.close()
        conn.close()
        return {"ok": True, "message": f"连接成功 ({db_type.upper()})"}
    except Exception as e:
        return {"ok": False, "message": str(e)}


# ── SQL 解析：提取表名 ────────────────────────────────────
def extract_table_names(sql: str) -> List[str]:
    # 去掉注释
    sql_clean = re.sub(r"--[^\n]*", "", sql, flags=re.MULTILINE)
    sql_clean = re.sub(r"/\*.*?\*/", "", sql_clean, flags=re.DOTALL)

    patterns = [
        r"\bFROM\s+([\w$.\"]+)",
        r"\bJOIN\s+([\w$.\"]+)",
        r"\bINTO\s+([\w$.\"]+)",
        r"\bUPDATE\s+([\w$.\"]+)",
        r"\bTABLE\s+([\w$.\"]+)",
    ]

    RESERVED = {
        "SELECT", "WHERE", "ON", "SET", "VALUES", "DUAL",
        "LATERAL", "UNNEST", "PIVOT", "UNPIVOT",
    }

    tables: set = set()
    for pattern in patterns:
        for m in re.findall(pattern, sql_clean, re.IGNORECASE):
            name = m.strip('"\'`').split(".")[-1].upper()
            if name and name not in RESERVED and not name.isdigit():
                tables.add(name)

    return list(tables)


# ── 获取表结构 ────────────────────────────────────────────
def get_table_schema(config: Dict, sql: str) -> Dict:
    if not config.get("host"):
        return {"schema": "", "tables": [], "error": "未配置数据库连接"}

    tables = extract_table_names(sql)
    if not tables:
        return {"schema": "(未从 SQL 中识别到表名)", "tables": []}

    try:
        conn, db_type = get_connection(config)
        cursor = conn.cursor()
        schema_parts = []

        for table in tables:
            try:
                part = _fetch_schema(cursor, db_type, table)
                schema_parts.append(part)
            except Exception as e:
                schema_parts.append(f"-- {table}: 获取失败 ({e})")

        cursor.close()
        conn.close()
        return {"schema": "\n\n".join(schema_parts), "tables": tables}

    except Exception as e:
        return {"schema": "", "tables": tables, "error": str(e)}


def _fetch_schema(cursor, db_type: str, table: str) -> str:
    if db_type == "oracle":
        return _oracle_schema(cursor, table)
    elif db_type == "postgresql":
        return _pg_schema(cursor, table)
    elif db_type == "mysql":
        return _mysql_schema(cursor, table)
    return f"-- {table}: 未知数据库类型"


def _oracle_schema(cursor, table: str) -> str:
    table_upper = table.upper()

    # 列信息
    cursor.execute(
        """SELECT column_name, data_type,
                  NVL(data_precision, data_length) len,
                  data_scale, nullable, data_default
           FROM user_tab_columns
           WHERE table_name = :1
           ORDER BY column_id""",
        [table_upper],
    )
    cols = cursor.fetchall()
    if not cols:
        return f"-- {table}: 表不存在或无权限"

    col_defs = []
    for c in cols:
        tp = c[1]
        if c[3] is not None:
            tp += f"({c[2]},{c[3]})"
        elif c[2] and tp in ("VARCHAR2", "CHAR", "NVARCHAR2"):
            tp += f"({c[2]})"
        null_str = "" if c[4] == "Y" else " NOT NULL"
        col_defs.append(f"  {c[0]} {tp}{null_str}")

    # 索引
    cursor.execute(
        """SELECT i.index_name, i.uniqueness,
                  LISTAGG(ic.column_name, ', ')
                    WITHIN GROUP (ORDER BY ic.column_position)
           FROM user_indexes i
           JOIN user_ind_columns ic ON i.index_name = ic.index_name
           WHERE i.table_name = :1
           GROUP BY i.index_name, i.uniqueness""",
        [table_upper],
    )
    indexes = cursor.fetchall()

    # 行数估算
    cursor.execute(
        "SELECT num_rows FROM user_tables WHERE table_name = :1", [table_upper]
    )
    row_info = cursor.fetchone()
    row_str = f" (约 {int(row_info[0]):,} 行)" if row_info and row_info[0] else ""

    lines = [f"-- Table: {table_upper}{row_str}"]
    lines.append(f"CREATE TABLE {table_upper} (")
    lines.append(",\n".join(col_defs))
    lines.append(");")

    for idx in indexes:
        uniq = "UNIQUE " if idx[1] == "UNIQUE" else ""
        lines.append(f"CREATE {uniq}INDEX {idx[0]} ON {table_upper}({idx[2]});")

    return "\n".join(lines)


def _pg_schema(cursor, table: str) -> str:
    table_lower = table.lower()

    cursor.execute(
        """SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
           WHERE table_name = %s
           ORDER BY ordinal_position""",
        [table_lower],
    )
    cols = cursor.fetchall()
    if not cols:
        return f"-- {table}: 表不存在或无权限"

    col_defs = [f"  {c[0]} {c[1]}" for c in cols]

    cursor.execute(
        "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = %s",
        [table_lower],
    )
    indexes = cursor.fetchall()

    cursor.execute(
        "SELECT reltuples::bigint FROM pg_class WHERE relname = %s", [table_lower]
    )
    row_info = cursor.fetchone()
    row_str = f" (约 {int(row_info[0]):,} 行)" if row_info and row_info[0] else ""

    lines = [f"-- Table: {table_lower}{row_str}"]
    lines.append(f"CREATE TABLE {table_lower} (")
    lines.append(",\n".join(col_defs))
    lines.append(");")
    for idx in indexes:
        lines.append(f"{idx[1]};")

    return "\n".join(lines)


def _mysql_schema(cursor, table: str) -> str:
    try:
        cursor.execute(f"SHOW CREATE TABLE `{table}`")
        result = cursor.fetchone()
        if not result:
            return f"-- {table}: 表不存在"
        ddl = result[1]

        try:
            cursor.execute(f"SHOW TABLE STATUS LIKE '{table}'")
            status = cursor.fetchone()
            if status:
                # Rows 字段是 InnoDB 估算值，比 COUNT(*) 快得多
                col_names = [d[0] for d in cursor.description]
                rows_idx = col_names.index("Rows") if "Rows" in col_names else None
                cnt = status[rows_idx] if rows_idx is not None and status[rows_idx] else None
                row_str = f" (约 {cnt:,} 行)" if cnt else ""
            else:
                row_str = ""
        except Exception:
            row_str = ""

        return f"-- Table: {table}{row_str}\n{ddl};"
    except Exception as e:
        return f"-- {table}: 获取失败 ({e})"


# ── 执行 EXPLAIN ──────────────────────────────────────────
def run_explain(config: Dict, sql: str) -> Dict:
    if not config.get("host"):
        return {"result": "未配置数据库连接", "ok": False}

    sql = sql.strip().rstrip(";")
    if not sql:
        return {"result": "SQL 为空", "ok": False}

    # 只允许 SELECT/WITH 语句
    first_word = sql.split()[0].upper() if sql.split() else ""
    if first_word not in ("SELECT", "WITH", "EXPLAIN"):
        return {"result": "EXPLAIN 仅支持 SELECT / WITH 语句", "ok": False}

    try:
        conn, db_type = get_connection(config)
        cursor = conn.cursor()
        lines = []

        if db_type == "oracle":
            stmt_id = "SQLOPT_" + str(abs(hash(sql)))[:8]
            try:
                cursor.execute(f"DELETE FROM plan_table WHERE statement_id='{stmt_id}'")
                conn.commit()
            except Exception:
                pass
            cursor.execute(f"EXPLAIN PLAN SET STATEMENT_ID='{stmt_id}' FOR {sql}")
            cursor.execute(
                """SELECT LPAD(' ', level*2) ||
                          RTRIM(operation ||
                                DECODE(options, NULL, '', ' '||options) ||
                                DECODE(object_name, NULL, '', ' ['||object_name||']') ||
                                DECODE(cost, NULL, '', '  Cost='||cost) ||
                                DECODE(cardinality, NULL, '', ' Rows='||cardinality) ||
                                DECODE(bytes, NULL, '', ' Bytes='||bytes)
                               ) AS plan_line
                   FROM plan_table
                   WHERE statement_id = :1
                   CONNECT BY PRIOR id = parent_id
                              AND statement_id = :2
                   START WITH id = 0 AND statement_id = :3
                   ORDER SIBLINGS BY id""",
                [stmt_id, stmt_id, stmt_id],
            )
            rows = cursor.fetchall()
            lines = ["Oracle Execution Plan:", "-" * 60]
            lines += [r[0] for r in rows]
            try:
                cursor.execute(f"DELETE FROM plan_table WHERE statement_id='{stmt_id}'")
                conn.commit()
            except Exception:
                pass

        elif db_type == "postgresql":
            cursor.execute(f"EXPLAIN (FORMAT TEXT) {sql}")
            rows = cursor.fetchall()
            lines = [r[0] for r in rows]

        elif db_type == "mysql":
            cursor.execute(f"EXPLAIN {sql}")
            col_names = [d[0] for d in cursor.description]
            rows = cursor.fetchall()
            lines = [" | ".join(col_names)]
            lines.append("-" * max(len(lines[0]), 40))
            for row in rows:
                lines.append(" | ".join(str(v) if v is not None else "NULL" for v in row))
            # Extended explain
            try:
                cursor.execute(f"EXPLAIN FORMAT=JSON {sql}")
                json_row = cursor.fetchone()
                if json_row:
                    lines.append("\n-- JSON Format:")
                    lines.append(json_row[0])
            except Exception:
                pass

        cursor.close()
        conn.close()
        return {"result": "\n".join(lines), "ok": True}

    except Exception as e:
        return {"result": f"EXPLAIN 执行失败: {e}", "ok": False}
