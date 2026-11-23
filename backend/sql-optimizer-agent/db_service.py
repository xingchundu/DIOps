"""
数据库服务层
支持 Oracle (oracledb thin 模式，无需客户端) / PostgreSQL / MySQL
"""

import ipaddress
import os
import re
import socket
from typing import Dict, List


def _normalize_conn_type(db_type: str) -> str:
    t = (db_type or "").strip().lower()
    if t in ("panwei", "panweidb"):
        return "postgresql"
    if t in ("sqlserver", "mssql"):
        return "sqlserver"
    return t


# ── 目标地址校验（防 SSRF） ───────────────────────────────
_BLOCKED_NETS = [ipaddress.ip_network(n) for n in (
    "169.254.0.0/16", "fe80::/10",          # 链路本地 / 云元数据
    "0.0.0.0/8", "224.0.0.0/4", "ff00::/8",  # 非法 / 组播
)]
_BLOCKED_HOSTS = {"metadata.google.internal", "metadata.goog", "metadata"}


def check_target_host(host: str, port) -> None:
    """拒绝访问云元数据/链路本地地址；配置了 SQL_OPT_ALLOWED_HOSTS（逗号分隔的主机名、IP 或 CIDR）时只允许其中的地址。
    原来任意 host:port 都会被服务端连接，可用来探测内网端口、访问云元数据（SSRF）。"""
    h = str(host or "").strip().lower()
    if not h:
        raise ValueError("未填写数据库地址")
    if h in _BLOCKED_HOSTS:
        raise ValueError(f"不允许连接该地址: {host}")
    try:
        infos = socket.getaddrinfo(h, int(port) if str(port or "").isdigit() else None)
        addrs = {ipaddress.ip_address(i[4][0].split("%")[0]) for i in infos}
    except (socket.gaierror, ValueError):
        raise ValueError(f"无法解析数据库地址: {host}")
    for a in addrs:
        if any(a in n for n in _BLOCKED_NETS):
            raise ValueError(f"不允许连接该地址: {host}")
    allow = [x.strip().lower() for x in os.getenv("SQL_OPT_ALLOWED_HOSTS", "").split(",") if x.strip()]
    if allow:
        ok = h in allow
        for a in addrs:
            for item in allow:
                try:
                    if a in ipaddress.ip_network(item, strict=False):
                        ok = True
                except ValueError:
                    pass
        if not ok:
            raise ValueError(f"数据库地址 {host} 不在允许列表（SQL_OPT_ALLOWED_HOSTS）中")


# ── 连接工厂 ──────────────────────────────────────────────
def get_connection(config: Dict):
    db_type = _normalize_conn_type(config.get("type", ""))
    host = config.get("host", "localhost")
    check_target_host(host, config.get("port", ""))
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

    elif db_type == "sqlserver":
        import pymssql
        port = port or "1433"
        conn = pymssql.connect(
            server=host,
            port=int(port),
            user=username,
            password=password,
            database=database or "master",
            login_timeout=10,
            timeout=30,
        )
        return conn, "sqlserver"

    raise ValueError(f"不支持的数据库类型: {db_type}，请选择 oracle / postgresql / mysql / panwei / sqlserver")


def _close(conn):
    try:
        conn.close()
    except Exception:
        pass


def test_db_connection(config: Dict) -> Dict:
    try:
        conn, db_type = get_connection(config)
    except Exception as e:
        return {"ok": False, "message": str(e)}
    try:
        cursor = conn.cursor()
        if db_type == "oracle":
            cursor.execute("SELECT 1 FROM DUAL")
        else:
            cursor.execute("SELECT 1")
        cursor.close()
        return {"ok": True, "message": f"连接成功 ({db_type.upper()})"}
    except Exception as e:
        return {"ok": False, "message": str(e)}
    finally:
        _close(conn)


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
    except Exception as e:
        return {"schema": "", "tables": tables, "error": str(e)}
    try:
        cursor = conn.cursor()
        schema_parts = []

        for table in tables:
            try:
                part = _fetch_schema(cursor, db_type, table)
                schema_parts.append(part)
            except Exception as e:
                schema_parts.append(f"-- {table}: 获取失败 ({e})")

        cursor.close()
        return {"schema": "\n\n".join(schema_parts), "tables": tables}

    except Exception as e:
        return {"schema": "", "tables": tables, "error": str(e)}
    finally:
        _close(conn)   # 原来异常时连接不关闭，泄漏


def _fetch_schema(cursor, db_type: str, table: str) -> str:
    if db_type == "oracle":
        return _oracle_schema(cursor, table)
    elif db_type == "postgresql":
        return _pg_schema(cursor, table)
    elif db_type == "mysql":
        return _mysql_schema(cursor, table)
    elif db_type == "sqlserver":
        return _mssql_schema(cursor, table)
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
        cursor.execute("SHOW CREATE TABLE `" + table.replace("`", "``") + "`")
        result = cursor.fetchone()
        if not result:
            return f"-- {table}: 表不存在"
        ddl = result[1]

        try:
            cursor.execute("SHOW TABLE STATUS LIKE %s", [table])
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


def _mssql_schema(cursor, table: str) -> str:
    cursor.execute(
        """SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
           FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_NAME = %s
           ORDER BY ORDINAL_POSITION""",
        [table],
    )
    cols = cursor.fetchall()
    if not cols:
        return f"-- {table}: 表不存在或无权限"
    col_defs = [f"  {c[0]} {c[1]}" for c in cols]
    return f"-- Table: {table}\nCREATE TABLE {table} (\n" + ",\n".join(col_defs) + "\n);"


# ── 执行 EXPLAIN ──────────────────────────────────────────
def run_explain(config: Dict, sql: str) -> Dict:
    if not config.get("host"):
        return {"result": "未配置数据库连接", "ok": False}

    sql = sql.strip().rstrip(";").strip()
    if not sql:
        return {"result": "SQL 为空", "ok": False}

    # 去掉注释后判断（原来带前导注释的 SELECT 会被误拒）；只允许单条 SELECT/WITH。
    # 原来还放行 "EXPLAIN …"，且不拒绝多语句：PG 驱动会把 "SELECT 1; DELETE …" 两条都执行
    body = re.sub(r"/\*.*?\*/", " ", sql, flags=re.DOTALL)
    body = re.sub(r"--[^\n]*", " ", body).strip()
    no_str = re.sub(r"'(?:[^']|'')*'", "''", body)
    if ";" in no_str:
        return {"result": "一次只能分析一条 SQL 语句", "ok": False}
    first_word = body.split()[0].upper() if body.split() else ""
    if first_word not in ("SELECT", "WITH"):
        return {"result": "EXPLAIN 仅支持 SELECT / WITH 语句", "ok": False}
    if re.search(r"\b(INSERT|UPDATE|DELETE|MERGE|DROP|TRUNCATE|ALTER|CREATE|GRANT)\b", no_str, re.I) and first_word == "WITH":
        return {"result": "WITH 子句中包含写操作，未获取执行计划", "ok": False}

    try:
        conn, db_type = get_connection(config)
    except Exception as e:
        return {"result": f"EXPLAIN 执行失败: {e}", "ok": False}
    try:
        cursor = conn.cursor()
        lines = []
        # 双保险：只读事务（EXPLAIN 不带 ANALYZE 本身不执行语句）
        try:
            if db_type == "postgresql":
                conn.set_session(readonly=True)
            elif db_type == "mysql":
                cursor.execute("SET SESSION TRANSACTION READ ONLY")
        except Exception:
            pass

        if db_type == "oracle":
            stmt_id = "SQLOPT_" + str(abs(hash(sql)))[:8]
            try:
                cursor.execute("DELETE FROM plan_table WHERE statement_id = :1", [stmt_id])
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
                cursor.execute("DELETE FROM plan_table WHERE statement_id = :1", [stmt_id])
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

        elif db_type == "sqlserver":
            cursor.execute("SET SHOWPLAN_TEXT ON")
            cursor.execute(sql)
            rows = cursor.fetchall()
            cursor.execute("SET SHOWPLAN_TEXT OFF")
            lines = [str(r[0]) for r in rows if r and r[0] is not None]

        cursor.close()
        return {"result": "\n".join(lines), "ok": True}

    except Exception as e:
        return {"result": f"EXPLAIN 执行失败: {e}", "ok": False}
    finally:
        _close(conn)
