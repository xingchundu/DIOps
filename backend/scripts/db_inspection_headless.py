#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Node 子进程调用：按 db_inspection 生成五类 Word（与交互版同源）。"""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import sys
import traceback
from typing import Any, Dict

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from db_inspection import (
    REPORT_TYPES,
    DBInspector,
    MySQLConnector,
    PostgreSQLConnector,
    GoldenDBConnector,
    OracleConnector,
    DaMengConnector,
)

CN_TO_EN = {
    "健康报告": "HEALTH",
    "风险报告": "RISK",
    "参数异常": "PARAMETER",
    "空间风险": "SPACE",
    "HA风险": "HA",
}


def _build_connector(cfg: Dict[str, Any]):
    dt = str(cfg.get("dbType") or "").upper()
    if dt == "MYSQL":
        return MySQLConnector()
    if dt == "GOLDENDB":
        return GoldenDBConnector()
    if dt == "POSTGRESQL":
        return PostgreSQLConnector()
    if dt == "ORACLE":
        return OracleConnector()
    if dt in ("DAMENG", "DM", "达梦", "达梦(DM)"):
        return DaMengConnector()
    raise ValueError("不支持的 dbType: %s（支持 MYSQL / GOLDENDB / POSTGRESQL / ORACLE / DAMENG）" % dt)


def _apply_conn_fields(c, cfg: Dict[str, Any]) -> None:
    c.host = str(cfg.get("host") or "127.0.0.1").strip()
    c.port = int(cfg.get("port") or 0)
    c.user = str(cfg.get("user") or "").strip()
    c.password = str(cfg.get("password") or "")
    db = str(cfg.get("database") or "").strip()
    if c.db_type in ("MySQL", "GoldenDB"):
        c.database = db or "information_schema"
    elif c.db_type == "PostgreSQL":
        c.database = db or "postgres"
    elif c.db_type == "达梦(DM)":
        c.database = db or "SYSDBA"
    elif c.db_type == "Oracle":
        svc = str(cfg.get("serviceName") or "").strip()
        sid = str(cfg.get("sid") or "").strip()
        c.service_name = svc
        c.sid = sid
        if svc:
            c.sid = ""
        elif sid:
            c.service_name = ""
        else:
            c.service_name = "XE"
        c._as_sysdba = False


def run_headless(cfg: Dict[str, Any]) -> Dict[str, Any]:
    sql_text = ""
    sql_path = cfg.get("sqlPath")
    if sql_path:
        p = os.path.abspath(str(sql_path))
        if not os.path.isfile(p):
            return {"ok": False, "error": "sqlPath 不是有效文件: %s" % p}
        with open(p, "r", encoding="utf-8", errors="ignore") as f:
            sql_text = f.read()
    else:
        sql_text = str(cfg.get("sqlText") or "")
    if not sql_text.strip():
        return {"ok": False, "error": "未提供 sqlText/sqlPath 或内容为空"}

    out_dir = os.path.abspath(str(cfg.get("outputDir") or "./reports"))
    os.makedirs(out_dir, exist_ok=True)

    connector = _build_connector(cfg)
    _apply_conn_fields(connector, cfg)

    inspector = DBInspector()
    inspector.sql_text = sql_text
    if cfg.get("inspectTimeStr"):
        inspector.inspect_time = str(cfg["inspectTimeStr"])
    if cfg.get("fileTimestamp"):
        inspector.timestamp = str(cfg["fileTimestamp"])
    inspector.connector = connector

    stderr_buf = io.StringIO()
    out_buf = io.StringIO()

    def _quiet_run():
        with contextlib.redirect_stdout(out_buf):
            inspector.parse_sections()
            inspector.init_generators()
            ok = inspector.connector.connect()
            if ok and inspector.sections:
                inspector.run_inspection()
            elif not ok:
                for sec in inspector.sections:
                    cat = sec["category"]
                    gen = inspector.generators.get(cat)
                    if gen:
                        gen.add_section(sec, [])
                        gen.sections.append(sec)
            file_list = inspector.generate_reports(out_dir)

        mapped: Dict[str, str] = {}
        for cn, fp in zip(REPORT_TYPES, file_list):
            en = CN_TO_EN.get(cn)
            if en:
                mapped[en] = os.path.abspath(fp)
        return {"ok": True, "files": mapped}

    try:
        with contextlib.redirect_stderr(stderr_buf):
            payload = _quiet_run()
        if not payload["ok"]:
            return payload
        if stderr_buf.getvalue().strip():
            payload["warn"] = stderr_buf.getvalue().strip()[:8000]
        return payload
    except Exception:
        return {
            "ok": False,
            "error": traceback.format_exc(),
            "quiet_stdout": out_buf.getvalue()[-12000:] if out_buf else "",
            "quiet_stderr": stderr_buf.getvalue()[-12000:] if stderr_buf else "",
        }
    finally:
        try:
            inspector.connector.close()
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--result", required=True)
    args = parser.parse_args()
    with open(args.config, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    res = run_headless(cfg)
    with open(args.result, "w", encoding="utf-8") as o:
        json.dump(res, o, ensure_ascii=False)
    sys.exit(0 if res.get("ok") else 2)


if __name__ == "__main__":
    main()
