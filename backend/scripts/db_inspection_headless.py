#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Node 子进程调用：按 db_inspection 生成五类 Word（与交互版同源）。"""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import re
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
    SQLServerConnector,
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
    if dt == "POSTGRESQL" or dt == "PANWEI":
        return PostgreSQLConnector()
    if dt == "ORACLE":
        return OracleConnector()
    if dt in ("DAMENG", "DM", "达梦", "达梦(DM)"):
        return DaMengConnector()
    if dt in ("SQLSERVER", "MSSQL"):
        return SQLServerConnector()
    raise ValueError("不支持的 dbType: %s（支持 MYSQL / GOLDENDB / POSTGRESQL / PANWEI / SQLSERVER / ORACLE / DAMENG）" % dt)


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
    elif c.db_type == "SQL Server":
        c.database = db or "master"
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

    # 连接器构建失败（dbType 不支持 / 端口非数字）原来直接抛到 main：
    # 结果文件不会落盘，Node 侧只看到「未生成结果文件」，无法定位原因。
    try:
        connector = _build_connector(cfg)
        _apply_conn_fields(connector, cfg)
    except Exception:
        return {"ok": False, "error": "构建数据库连接配置失败: " + traceback.format_exc()}

    inspector = DBInspector()
    inspector.sql_text = sql_text
    if cfg.get("inspectTimeStr"):
        inspector.inspect_time = str(cfg["inspectTimeStr"])
    if cfg.get("fileTimestamp"):
        inspector.timestamp = str(cfg["fileTimestamp"])
    # [fix] 任务/实例唯一标识进入报告文件名，防止批量巡检同 IP 多实例互相覆盖
    inspector.file_scope = str(cfg.get("fileScope") or "").strip()
    inspector.connector = connector

    stderr_buf = io.StringIO()
    out_buf = io.StringIO()

    def _collect_stats() -> Dict[str, int]:
        """汇总 5 个生成器的执行结果，供 Node 侧判定报告是否有效。"""
        st = {
            "sections": len(inspector.sections),
            "okQueries": 0,
            "errorQueries": 0,
            "totalRows": 0,
            "renderedSections": 0,
        }
        for gen in inspector.generators.values():
            s = getattr(gen, "_stats", {}) or {}
            st["okQueries"]       += int(s.get("ok_queries", 0))
            st["errorQueries"]    += int(s.get("collect_errors", 0))
            st["totalRows"]       += int(s.get("total_rows", 0))
            st["renderedSections"] += len(getattr(gen, "sections", []) or [])
        return st

    def _quiet_run():
        with contextlib.redirect_stdout(out_buf):
            inspector.parse_sections()
            # [fix] 模板 SQL 与库类型不匹配 / 无 >>SECTION 标记时，原来照样生成 5 份只有封面目录的报告
            if not inspector.sections:
                return {
                    "ok": False,
                    "error": "巡检 SQL 未解析出任何巡检节（>>SECTION 标记缺失，或模板与数据库类型不匹配），已停止生成以免产出空壳报告",
                    "quiet_stdout": out_buf.getvalue()[-4000:],
                }
            inspector.init_generators()
            ok = inspector.connector.connect()
            if not ok:
                # 连接失败不再生成“全空”的报告冒充巡检成功
                return {"ok": False, "error": "目标数据库连接失败，未执行巡检（请检查实例地址、账号与网络）"}

            inspector.run_inspection()
            stats = _collect_stats()
            # [fix] 全部语句执行失败（典型：被管账号无字典视图权限）时，
            #       5 份 Word 全是无数据的空壳，原来仍返回 ok=True 并标记巡检成功。
            if stats["okQueries"] == 0:
                return {
                    "ok": False,
                    "error": (
                        f"本次巡检没有任何语句成功返回结果：共 {stats['sections']} 个巡检节、"
                        f"{stats['errorQueries']} 条语句执行失败。通常是被管账号缺少字典视图权限、"
                        "或巡检模板与数据库类型不匹配，已停止生成空壳报告。"
                    ),
                    "stats": stats,
                    "quiet_stdout": out_buf.getvalue()[-8000:],
                }
            file_list = inspector.generate_reports(out_dir)

        mapped: Dict[str, str] = {}
        for cn, fp in zip(REPORT_TYPES, file_list):
            en = CN_TO_EN.get(cn)
            if en:
                mapped[en] = os.path.abspath(fp)
        # [fix] 校验报告确实落盘且不是空文件；docx 为空壳 zip 时体积会明显偏小
        for en, fp in mapped.items():
            size = os.path.getsize(fp) if os.path.isfile(fp) else 0
            if size < 8192:
                return {
                    "ok": False,
                    "error": f"{en} 报告文件缺失或体积异常（{size} bytes），疑似生成失败: {fp}",
                    "stats": stats,
                }
        payload: Dict[str, Any] = {"ok": True, "files": mapped, "stats": stats}
        if stats["errorQueries"]:
            payload["warn"] = (
                f"{stats['errorQueries']} 条巡检语句执行失败（权限不足 / 视图不存在），"
                "已在报告评分中扣分，建议检查被管账号授权"
            )
        return payload

    try:
        with contextlib.redirect_stderr(stderr_buf):
            payload = _quiet_run()
        if not payload["ok"]:
            return payload
        # [fix] tqdm 用 \r 覆盖同一行刷新进度条，原样塞进 warn 会变成几千字无意义文本，
        #       把真正需要的告警/错误淹没；这里只保留非进度条行。
        raw_err = stderr_buf.getvalue()
        noise = []
        for ln in re.split(r"[\r\n]+", raw_err):
            s = ln.strip()
            if not s or "%|" in s:
                continue
            if re.match(r"^(执行SQL巡检|生成Word报告|连接数据库|加载SQL文件|解析SQL节)\s*:", s):
                continue
            noise.append(s)
        tail = "\n".join(noise)[:4000]
        if tail:
            payload["warn"] = (payload.get("warn", "") + "\n" + tail).strip()
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
