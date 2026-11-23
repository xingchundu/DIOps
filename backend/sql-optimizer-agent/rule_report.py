"""
无大模型时的“规则优化”：
  1) 优先 Java 统一规则引擎（含索引建议/等价改写）；
  2) Java 不可达或无结果时，回退到本地 sql_rule_engine（SQLGlot 12 条规则，仅给建议、不改写）；
  3) 把规则结论整理成 Markdown 报告，格式与 AI 回复一致，前端可复用同一渲染。
"""
from __future__ import annotations

import asyncio

from sql_rule_client import analyze_sql as java_rules

_SEV_ORDER = {"high": 0, "medium": 1, "low": 2}
_SEV_LABEL = {"high": "🔴 高风险", "medium": "🟠 中风险", "low": "🔵 提示"}


def _local_rules(sql: str, db_type: str, schema: str, explain: str) -> dict:
    from sql_rule_engine import analyze_sql as local
    r = local(sql, db_type, schema=schema, explain_result=explain)
    r["engine"] = "local-rules"
    return r


def run_rules(sql: str, db_type: str, schema: str = "", explain: str = "",
              authorization: str | None = None, instance_id: int | None = None) -> dict:
    """同步函数（内部有 HTTP 调用），调用方用 asyncio.to_thread。"""
    r = java_rules(sql, db_type, schema=schema, explain_result=explain,
                   authorization=authorization, instance_id=instance_id)
    real = [x for x in r.get("rules", []) if not str(x.get("id", "")).startswith("SKIPPED_")]
    if real or r.get("rewrittenSql"):
        r.setdefault("engine", "rule-optimize")
        return r
    java_note = r.get("summary", "")
    try:
        loc = _local_rules(sql, db_type, schema, explain)
    except Exception as e:  # noqa: BLE001
        loc = {"rules": [], "summary": f"本地规则引擎异常：{e}", "engine": "local-rules"}
    # Java 是“不可用”（而不是“没发现问题”）时，在 summary 里说明回退原因
    if "不可用" in java_note or "错误" in java_note:
        loc["summary"] = f"{loc.get('summary', '')}（统一规则服务不可用，已使用本地规则：{java_note[:80]}）"
    return loc


def build_markdown(sql: str, db_type: str, rule_result: dict, precheck: dict | None = None,
                   explain_text: str = "") -> str:
    rules = [r for r in rule_result.get("rules", []) if not str(r.get("id", "")).startswith("SKIPPED_")]
    rules.sort(key=lambda r: _SEV_ORDER.get(r.get("severity"), 3))
    L: list[str] = [f"## 规则优化报告（未使用大模型）", "",
                    f"- 数据库类型：**{db_type}**",
                    f"- 规则引擎：{rule_result.get('engine', 'rule-optimize')}",
                    f"- 结论：{rule_result.get('summary', '')}"]
    if rule_result.get("score") is not None:
        L.append(f"- 评分：{rule_result.get('score')}（{rule_result.get('risk', '')}）")
    for w in (precheck or {}).get("warnings", []):
        L.append(f"- ⚠ {w}")
    L.append("")
    if rules:
        L += ["### 发现的问题与建议", ""]
        for i, r in enumerate(rules, 1):
            L.append(f"{i}. {_SEV_LABEL.get(r.get('severity'), '提示')} **{r.get('title', r.get('id'))}**")
            if r.get("detail"):
                L.append(f"   - 原因：{r['detail']}")
            if r.get("suggestion"):
                sug = str(r["suggestion"]).strip()
                L.append(f"   - 建议：{sug}" if "\n" not in sug else "   - 建议：\n     " + sug.replace("\n", "\n     "))
        L.append("")
    else:
        L += ["未发现明显的规则问题。", ""]
    if rule_result.get("rewrittenSql"):
        L += ["### 规则引擎等价改写", "", "```sql", rule_result["rewrittenSql"].strip(), "```", ""]
    else:
        L += ["> 规则引擎没有生成改写 SQL（仅给出建议）。配置大模型后可获得针对该语句的深度改写。", ""]
    if explain_text:
        L += ["### 执行计划（原始）", "", "```", explain_text.strip()[:3000], "```", ""]
    return "\n".join(L)


async def probe_llm(llm_config: dict | None, timeout: float = 4.0) -> dict:
    """探测大模型是否可用，用于 mode=auto 的决策。永不抛异常。"""
    from llm_service import test_llm_connection
    try:
        return await asyncio.wait_for(test_llm_connection(llm_config), timeout=timeout)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}
