"""
Oracle 数据库访问服务（同步 oracledb + asyncio.to_thread，避免阻塞事件循环）
连接参数通过环境变量 ORACLE_USER / ORACLE_PASSWORD / ORACLE_DSN 配置，无硬编码默认值。
"""
from __future__ import annotations

import asyncio
import json
import threading
import os

import oracledb
from dotenv import load_dotenv
from pathlib import Path

_agent_dir = Path(__file__).resolve().parent
_backend_dir = _agent_dir.parent
# 先 ai-ops-agent/.env，再 backend/.env（与 Node 平台库配置一致）
load_dotenv(_agent_dir / ".env")
load_dotenv(_backend_dir / ".env")

_pool = None


def _build_dsn_from_db_env() -> str:
    """与 backend/src/config/db.js buildConnectString 对齐。"""
    cs = os.getenv("DB_CONNECT_STRING", "").strip()
    if cs:
        return cs
    host = os.getenv("DB_HOST", "").strip()
    if not host:
        return ""
    port = os.getenv("DB_PORT", "1521").strip() or "1521"
    svc = os.getenv("DB_SERVICE_NAME", "").strip()
    sid = os.getenv("DB_SID", "").strip()
    if svc:
        return f"{host}:{port}/{svc}"
    if sid:
        return f"{host}:{port}/{sid}"
    return ""


def _require_oracle_config() -> tuple[str, str, str]:
    user = os.getenv("ORACLE_USER", "").strip() or os.getenv("DB_USER", "").strip()
    password = os.getenv("ORACLE_PASSWORD", "").strip() or os.getenv("DB_PASSWORD", "").strip()
    dsn = os.getenv("ORACLE_DSN", "").strip() or _build_dsn_from_db_env()
    missing = []
    if not user:
        missing.append("ORACLE_USER 或 DB_USER")
    if not password:
        missing.append("ORACLE_PASSWORD 或 DB_PASSWORD")
    if not dsn:
        missing.append("ORACLE_DSN 或 DB_CONNECT_STRING / DB_HOST+DB_SID|DB_SERVICE_NAME")
    if missing:
        raise RuntimeError(
            f"缺少 Oracle 连接配置: {', '.join(missing)}。"
            "请在 backend/.env 或 backend/ai-ops-agent/.env 中设置。"
        )
    return user, password, dsn


_pool_lock = threading.Lock()


def _ensure_pool():
    # 多个 to_thread 并发首次调用时原来会各建一个池（旧池泄漏）：双重检查加锁
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                user, password, dsn = _require_oracle_config()
                _pool = oracledb.create_pool(
                    user=user,
                    password=password,
                    dsn=dsn,
                    min=1,
                    max=5,
                    increment=1,
                )
    return _pool


def close_pool():
    """进程退出时关闭连接池"""
    global _pool
    with _pool_lock:
        if _pool is not None:
            try:
                _pool.close(force=True)
            except Exception:
                pass
            _pool = None


def _sanitize_bind(val):
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


def _execute_sync(sql: str, params=None, commit: bool = True) -> int:
    pool = _ensure_pool()
    binds = [_sanitize_bind(p) for p in (params or [])]
    with pool.acquire() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, binds)
            if commit:
                conn.commit()
            return cur.rowcount


def _query_sync(sql: str, params=None) -> list[dict]:
    pool = _ensure_pool()
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
                    if hasattr(v, "read"):
                        v = v.read()
                    d[col] = v
                result.append(d)
            return result


def _insert_returning_id_sync(sql: str, params=None) -> int:
    pool = _ensure_pool()
    with pool.acquire() as conn:
        with conn.cursor() as cur:
            out_id = cur.var(int)
            all_params = [_sanitize_bind(p) for p in (params or [])] + [out_id]
            cur.execute(sql, all_params)
            conn.commit()
            val = out_id.getvalue()
            return val[0] if isinstance(val, list) and val else val


async def execute(sql: str, params=None, commit: bool = True) -> int:
    return await asyncio.to_thread(_execute_sync, sql, params, commit)


async def query(sql: str, params=None) -> list[dict]:
    return await asyncio.to_thread(_query_sync, sql, params or [])


async def query_one(sql: str, params=None) -> dict | None:
    rows = await query(sql, params)
    return rows[0] if rows else None


async def insert_returning_id(sql: str, params=None) -> int:
    return await asyncio.to_thread(_insert_returning_id_sync, sql, params)


async def get_metrics_window(instance_id: int, minutes_before: int = 15, minutes_after: int = 15) -> list[dict]:
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
    sql = """
        SELECT ALERT_ID, RULE_NAME, SEVERITY, CONTENT, STATUS, TRIGGER_TIME
        FROM ALERT_RECORD
        WHERE INSTANCE_ID = :1
        ORDER BY TRIGGER_TIME DESC
        FETCH FIRST :2 ROWS ONLY
    """
    return await query(sql, [instance_id, limit])


async def get_cmdb_instance(instance_id: int) -> dict | None:
    return await query_one(
        "SELECT * FROM CMDB_INSTANCE WHERE INSTANCE_ID = :1",
        [instance_id],
    )
