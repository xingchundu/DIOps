"""
Oracle 数据库访问服务
连接 DIOps 平台 Oracle 库（192.168.137.102:1521/ora19c）
"""
import os
import json
import oracledb
from dotenv import load_dotenv

load_dotenv()

ORACLE_USER = os.getenv("ORACLE_USER", "monitor")
ORACLE_PASSWORD = os.getenv("ORACLE_PASSWORD", "oracle")
ORACLE_DSN = os.getenv("ORACLE_DSN", "192.168.137.102:1521/ora19c")

_pool = None


def _sanitize_bind(val):
    """
    Oracle 普通 SQL 不能绑定 Python list（会按数组绑定 → ORA-01484）。
    嵌入向量等 list 转为 JSON 字符串；字符串列表用逗号拼接。
    numpy 等先 tolist() 再处理。
    """
    if val is None:
        return val
    if hasattr(val, "tolist") and not isinstance(val, (str, bytes, dict, list)):
        try:
            val = val.tolist()
        except Exception:
            pass
    if isinstance(val, list):
        if len(val) == 0:
            return "[]"
        try:
            return json.dumps([float(x) for x in val], ensure_ascii=False)
        except (TypeError, ValueError):
            return ",".join(str(x) for x in val)
    return val


async def get_pool():
    global _pool
    if _pool is None:
        _pool = oracledb.create_pool(
            user=ORACLE_USER,
            password=ORACLE_PASSWORD,
            dsn=ORACLE_DSN,
            min=1,
            max=5,
            increment=1,
        )
    return _pool


async def execute(sql: str, params=None, commit: bool = True):
    """执行 DML/DDL，返回 rowcount"""
    pool = await get_pool()
    binds = [_sanitize_bind(p) for p in (params or [])]
    with pool.acquire() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, binds)
            if commit:
                conn.commit()
            return cur.rowcount


async def query(sql: str, params=None) -> list[dict]:
    """执行查询，返回 list[dict]"""
    pool = await get_pool()
    with pool.acquire() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params or [])
            cols = [d[0] for d in cur.description]
            rows = cur.fetchall()
            result = []
            for row in rows:
                d = {}
                for i, col in enumerate(cols):
                    v = row[i]
                    # CLOB → str
                    if hasattr(v, "read"):
                        v = v.read()
                    d[col] = v
                result.append(d)
            return result


async def query_one(sql: str, params=None) -> dict | None:
    rows = await query(sql, params)
    return rows[0] if rows else None


async def insert_returning_id(sql: str, params=None) -> int:
    """执行 INSERT … RETURNING id INTO :id, 返回新行 ID"""
    pool = await get_pool()
    with pool.acquire() as conn:
        with conn.cursor() as cur:
            out_id = cur.var(int)
            # sql 末尾应包含  RETURNING xxx_ID INTO :out_id
            all_params = [_sanitize_bind(p) for p in (params or [])] + [out_id]
            cur.execute(sql, all_params)
            conn.commit()
            return out_id.getvalue()


async def get_metrics_window(instance_id: int, minutes_before: int = 15, minutes_after: int = 15) -> list[dict]:
    """获取某实例告警前后N分钟的指标样本"""
    sql = """
        SELECT INSTANCE_ID, COLLECTED_AT, DB_TYPE, REACHABLE,
               HEALTH_SCORE, METRIC_CPU, METRIC_CONN, METRICS_JSON
        FROM MONITOR_METRIC_SAMPLE
        WHERE INSTANCE_ID = :1
          AND COLLECTED_AT >= SYSTIMESTAMP - INTERVAL ':2' MINUTE
          AND COLLECTED_AT <= SYSTIMESTAMP + INTERVAL ':3' MINUTE
        ORDER BY COLLECTED_AT
    """
    # Oracle 不支持 INTERVAL 变量，改用 NUMTODSINTERVAL
    sql = """
        SELECT INSTANCE_ID, COLLECTED_AT, DB_TYPE, REACHABLE,
               HEALTH_SCORE, METRIC_CPU, METRIC_CONN, METRICS_JSON
        FROM MONITOR_METRIC_SAMPLE
        WHERE INSTANCE_ID = :1
          AND COLLECTED_AT >= SYSTIMESTAMP - NUMTODSINTERVAL(:2, 'MINUTE')
          AND COLLECTED_AT <= SYSTIMESTAMP + NUMTODSINTERVAL(:3, 'MINUTE')
        ORDER BY COLLECTED_AT
    """
    return await query(sql, [instance_id, minutes_before, minutes_after])


async def get_recent_alerts(instance_id: int, limit: int = 50) -> list[dict]:
    """获取实例最近告警"""
    sql = """
        SELECT ALERT_ID, RULE_NAME, SEVERITY, CONTENT, STATUS, TRIGGER_TIME
        FROM ALERT_RECORD
        WHERE INSTANCE_ID = :1
        ORDER BY TRIGGER_TIME DESC
        FETCH FIRST :2 ROWS ONLY
    """
    return await query(sql, [instance_id, limit])


async def get_cmdb_instance(instance_id: int) -> dict | None:
    """获取 CMDB 实例信息"""
    return await query_one(
        "SELECT * FROM CMDB_INSTANCE WHERE INSTANCE_ID = :1",
        [instance_id]
    )


