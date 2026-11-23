"""
SQL 规则检查 → Java 规则优化引擎（dbops-server /api/sql-insight/optimize，Druid AST）。

规则优先：统一审核 + 执行计划分析 + 索引建议 + 等价改写 的结论由 Java 规则引擎给出（可复现），
大模型只在这些结论的基础上做解释和深度改写，不推翻规则结论。旧服务没有 /optimize 时回退到 /audit。

原 sql_rule_engine.py（SQLGlot 规则 12 条、511 行）已删除：同一条 SQL 在 AI 优化、SQL 审核、治理中心、发布预审
得到不同结论。现在 AI 优化与其它入口共用同一套规则与阈值（DI_SQL_RULE）。
SQLGlot 仍保留在 sql_validator.py，只用于校验大模型改写后的 SQL 能否解析（AI 输出护栏）。

返回结构与原 analyze_sql 一致：{"rules": [{id, severity(high/medium/low), title, detail, suggestion}], "summary": "..."}
"""
from __future__ import annotations

import os
from typing import Any

import httpx

JAVA_SERVER_URL = os.getenv("JAVA_SERVER_URL", "http://127.0.0.1:3000").rstrip("/")
TIMEOUT_SEC = float(os.getenv("SQL_INSIGHT_TIMEOUT_SEC", "30"))

_SEVERITY = {"CRITICAL": "high", "ERROR": "high", "WARNING": "medium", "WARN": "medium", "INFO": "low"}


def to_rules(audit: dict) -> list[dict[str, Any]]:
    """Java 审核结果 → 原规则引擎格式（纯函数，便于单测）"""
    rules: list[dict[str, Any]] = []
    for i in audit.get("issues") or []:
        sev = _SEVERITY.get(str(i.get("severity", "")).upper(), "low")
        rules.append({
            "id": i.get("code", ""),
            "severity": sev,
            "title": i.get("title") or i.get("code", ""),
            "detail": i.get("message", ""),
            "suggestion": i.get("suggestion") or "",
        })
    for s in audit.get("skipped") or []:
        rules.append({
            "id": f"SKIPPED_{s.get('code', '')}",
            "severity": "low",
            "title": "规则未执行",
            "detail": s.get("reason", ""),
            "suggestion": "未执行的规则不代表通过，请结合执行计划人工确认",
        })
    return rules


def optimize_rules(opt: dict) -> list[dict[str, Any]]:
    """规则优化结果中的索引建议、改写 → 规则列表（纯函数）"""
    rules: list[dict[str, Any]] = []
    for n, x in enumerate(opt.get("indexAdvice") or [], 1):
        cols = ", ".join(x.get("columns") or [])
        if x.get("ddl"):
            rules.append({
                "id": f"IDX-{n}",
                "severity": "high" if x.get("confidence") == "HIGH" else "medium" if x.get("confidence") == "MEDIUM" else "low",
                "title": f"建议索引 {x.get('table')}({cols})",
                "detail": x.get("reason") or "",
                "suggestion": x.get("ddl"),
            })
        else:
            rules.append({"id": f"IDX-{n}", "severity": "low", "title": f"{x.get('table')} 索引", "detail": x.get("reason") or "",
                          "suggestion": "已有索引可覆盖，检查统计信息或选择性"})
    for r in opt.get("rewrites") or []:
        rules.append({
            "id": r.get("code", ""),
            "severity": "medium",
            "title": r.get("title", "") + ("（已自动改写）" if r.get("applied") else ""),
            "detail": r.get("reason", ""),
            "suggestion": r.get("suggestion") or "",
        })
    for f in (opt.get("plan") or {}).get("findings") or []:
        rules.append({"id": f.get("code", ""), "severity": _SEVERITY.get(str(f.get("severity", "")).upper(), "low"),
                      "title": f.get("title", ""), "detail": f.get("detail", ""), "suggestion": ""})
    return rules


def summarize(rules: list[dict[str, Any]], audit: dict | None = None) -> str:
    real = [r for r in rules if not str(r["id"]).startswith("SKIPPED_")]
    if not real:
        return "统一审核引擎未发现明显问题"
    high = sum(1 for r in real if r["severity"] == "high")
    medium = sum(1 for r in real if r["severity"] == "medium")
    low = sum(1 for r in real if r["severity"] == "low")
    parts = [f"{n} 个{label}" for n, label in ((high, "高风险"), (medium, "中风险"), (low, "低风险")) if n]
    score = f"，评分 {audit.get('score')}（{audit.get('risk')}）" if audit and audit.get("score") is not None else ""
    return f"统一审核引擎发现 {len(real)} 个问题（{', '.join(parts)}）{score}"


def analyze_sql(sql: str, db_type: str, schema: str = "", explain_result: str = "",
                authorization: str | None = None, instance_id: int | None = None) -> dict:
    """调用 Java 统一审核；服务不可用时返回空规则并在 summary 中说明（不影响大模型优化流程）"""
    if not sql or not sql.strip():
        return {"rules": [], "summary": "未提供 SQL"}
    headers = {"Content-Type": "application/json"}
    if authorization:
        headers["Authorization"] = authorization
    payload = {"sqlText": sql, "dbType": db_type, "instanceId": instance_id,
               "instanceCheck": bool(instance_id), "linkAsset": True}
    opt: dict | None = None
    try:
        with httpx.Client(timeout=TIMEOUT_SEC) as client:
            resp = client.post(f"{JAVA_SERVER_URL}/api/sql-insight/optimize", json=payload, headers=headers)
            body = resp.json() if resp.status_code != 404 else {"code": 404}
            if body.get("code") == 200:
                opt = body.get("data") or {}
                audit = opt.get("audit") or {}
            elif body.get("code") == 404:
                resp = client.post(f"{JAVA_SERVER_URL}/api/sql-insight/audit", json=payload, headers=headers)
                body = resp.json()
                if body.get("code") != 200:
                    return {"rules": [], "summary": f"统一审核服务返回错误：{body.get('msg')}"}
                audit = body.get("data") or {}
            else:
                return {"rules": [], "summary": f"规则优化服务返回错误：{body.get('msg')}"}
    except Exception as e:  # noqa: BLE001
        return {"rules": [], "summary": f"规则优化服务不可用（{JAVA_SERVER_URL}）：{e}"}
    rules = to_rules(audit) + (optimize_rules(opt) if opt else [])
    out = {"rules": rules, "summary": summarize(rules, audit), "score": audit.get("score"), "risk": audit.get("risk")}
    if opt:
        out["engine"] = "rule-optimize"
        out["actions"] = opt.get("actions") or []
        if opt.get("rewrittenSql"):
            out["rewrittenSql"] = opt["rewrittenSql"]
            out["summary"] += "；规则引擎已给出等价改写 SQL"
    if audit.get("assetId") is not None:
        out["assetId"] = audit.get("assetId")
        out["fingerprint"] = audit.get("fingerprint")
    if audit.get("runtime"):
        out["runtime"] = audit.get("runtime")
    return out
