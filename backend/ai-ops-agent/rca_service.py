"""
根因分析（RCA）服务
- 采集告警前后15分钟多维指标（CPU/内存/IO/连接数/锁）
- 时序异常突变点检测（Z-Score）
- 结合 CMDB 拓扑判断传导路径
- 调用本地 LLM 生成根因结论 + 处置建议
- 结果写入 Oracle AI_RCA_RESULT
"""
import json
import math
import statistics
from datetime import datetime
from typing import Optional

import db_service as db
import llm_service as llm
import kg_service as kg
from kg_service import byte_trunc


def _detect_anomaly_points(metrics: list[dict]) -> dict:
    """
    使用 Z-Score 检测多个指标的突变点。
    返回: {metric_name: [{"ts": ..., "value": ..., "z": ...}, ...]}
    """
    series: dict[str, list] = {}
    for m in metrics:
        ts = str(m.get("COLLECTED_AT", ""))
        cpu = m.get("METRIC_CPU")
        conn = m.get("METRIC_CONN")
        raw = m.get("METRICS_JSON")
        extra = {}
        if raw:
            try:
                extra = json.loads(raw) if isinstance(raw, str) else raw
            except Exception:
                pass

        for key, val in [("cpu", cpu), ("connections", conn)]:
            if val is not None:
                series.setdefault(key, []).append({"ts": ts, "value": float(val)})

        # 从 METRICS_JSON 提取更多指标
        for k in ("memory_pct", "io_read_mb", "io_write_mb", "active_sessions", "lock_waits"):
            v = extra.get(k)
            if v is not None:
                try:
                    series.setdefault(k, []).append({"ts": ts, "value": float(v)})
                except Exception:
                    pass

    anomalies = {}
    for metric, points in series.items():
        if len(points) < 3:
            continue
        vals = [p["value"] for p in points]
        try:
            mean = statistics.mean(vals)
            stdev = statistics.stdev(vals) or 1e-9
        except Exception:
            continue
        for p in points:
            z = abs((p["value"] - mean) / stdev)
            if z > 2.0:  # 超过2σ视为突变
                anomalies.setdefault(metric, []).append({
                    "ts": p["ts"],
                    "value": p["value"],
                    "z_score": round(z, 2),
                    "mean": round(mean, 2),
                    "stdev": round(stdev, 2),
                })
    return anomalies


def _build_topology_path(instance: dict) -> list[dict]:
    """
    基于 CMDB_INSTANCE 的字段构建简单拓扑传导路径。
    实际生产可扩展为多跳关联查询（应用→主机→网络→数据库）。
    """
    path = []
    # 应用层（如有 BIZ_LINE）
    if instance.get("BIZ_LINE"):
        path.append({"layer": "应用层", "component": instance["BIZ_LINE"], "note": "业务线"})
    # 主机层
    path.append({
        "layer": "主机层",
        "component": instance.get("HOST_IP", "unknown"),
        "note": f"数据库主机 {instance.get('HOST_IP', '')}",
    })
    # 数据库层
    path.append({
        "layer": "数据库层",
        "component": instance.get("INSTANCE_NAME", "unknown"),
        "note": f"{instance.get('DB_TYPE', '')} {instance.get('DB_VERSION', '')}",
        "health_score": instance.get("HEALTH_SCORE"),
    })
    return path


async def run_rca(
    alert_id: int,
    instance_id: int,
    alert_content: str,
    created_by: str = "system",
) -> int:
    """
    执行 RCA，返回 RCA_ID。
    """
    # 1. 获取 CMDB 实例信息
    instance = await db.get_cmdb_instance(instance_id) or {}

    # 2. 获取前后15分钟指标样本
    metrics = await db.get_metrics_window(instance_id, minutes_before=15, minutes_after=15)

    # 3. 检测异常突变点
    anomaly_points = _detect_anomaly_points(metrics)

    # 4. 拓扑传导路径
    topo_path = _build_topology_path(instance)

    # 5. 构建 LLM Prompt
    metrics_summary = []
    for m in metrics[-10:]:  # 最近10个样本摘要
        metrics_summary.append({
            "ts": str(m.get("COLLECTED_AT", "")),
            "cpu": m.get("METRIC_CPU"),
            "conn": m.get("METRIC_CONN"),
            "health": m.get("HEALTH_SCORE"),
        })

    prompt = f"""你是一位Oracle数据库运维专家。请根据以下告警和指标数据进行根因分析。

【告警信息】
{alert_content}

【数据库实例】
名称: {instance.get('INSTANCE_NAME', 'N/A')}
类型: {instance.get('DB_TYPE', 'N/A')}
主机: {instance.get('HOST_IP', 'N/A')}
当前健康分: {instance.get('HEALTH_SCORE', 'N/A')}

【近期指标趋势（最新10条）】
{json.dumps(metrics_summary, ensure_ascii=False, indent=2)}

【检测到的异常突变点】
{json.dumps(anomaly_points, ensure_ascii=False, indent=2) if anomaly_points else '未检测到明显突变'}

请按以下格式输出（中文）：
1. 根因结论（1-2句话）
2. 详细分析（分点说明，包括指标异常关联）
3. 处置建议（3-5条可执行措施）
4. 置信度评估（0-100分，并说明理由）"""

    system_prompt = "你是专业的数据库智能运维助手，擅长Oracle/MySQL/PostgreSQL故障诊断与根因分析。回答简洁专业，中文输出。"
    used_rule = False
    try:
        llm_response = await llm.generate(prompt, system=system_prompt, max_tokens=800)
        if llm.is_llm_error_text(llm_response):
            raise llm.LLMError(llm_response)
    except llm.LLMError:
        # 无模型/模型不可用：用规则推断给出结论，避免“RCA 整体失败、什么都看不到”
        llm_response, _rule_conf = _rule_based_rca(instance, anomaly_points, alert_content)
        used_rule = True

    # 6. 解析置信度（从LLM输出中提取数字）
    confidence = 75.0  # 默认
    if used_rule:
        confidence = _rule_conf
    import re
    m = re.search(r"置信度[：:]\s*(\d+)", llm_response)
    if m:
        try:
            confidence = min(100.0, max(0.0, float(m.group(1))))
        except Exception:
            pass

    # 7. 写入 Oracle
    sql = """
        INSERT INTO AI_RCA_RESULT(
            ALERT_ID, INSTANCE_ID, ROOT_CAUSE, CONFIDENCE,
            PROPAGATION_PATH, METRICS_SNAPSHOT, ANOMALY_POINTS,
            RECOMMENDATIONS, LLM_MODEL, STATUS, CREATED_BY
        ) VALUES(:1,:2,:3,:4,:5,:6,:7,:8,:9,'DONE',:10)
        RETURNING RCA_ID INTO :11
    """
    rca_id = await db.insert_returning_id(sql, [
        alert_id,
        instance_id,
        byte_trunc(llm_response, 1000),   # ROOT_CAUSE 是 VARCHAR2(1024) 字节语义，按字节截断
        confidence,
        json.dumps(topo_path, ensure_ascii=False),
        json.dumps(metrics_summary, ensure_ascii=False),
        json.dumps(anomaly_points, ensure_ascii=False),
        llm_response,           # RECOMMENDATIONS 存完整LLM输出
        ("rule-engine" if used_rule else llm_service_model()),
        created_by,
    ])

    await kg.record_rca(rca_id, instance_id, instance.get("INSTANCE_NAME"), llm_response, llm_response)
    return rca_id


def _rule_based_rca(instance: dict, anomaly_points: dict, alert_content: str) -> tuple[str, float]:
    """没有可用大模型时的规则式 RCA：依据突变点和告警文本给出可执行的结论与建议。"""
    pts = anomaly_points or {}
    names = list(pts.keys()) if isinstance(pts, dict) else []
    text = (alert_content or "").lower()
    causes, actions = [], []
    if any("cpu" in n.lower() for n in names) or "cpu" in text:
        causes.append("CPU 使用率异常升高，疑似存在高消耗 SQL 或并发突增")
        actions += ["查看 TOP SQL（按 CPU/逻辑读排序），确认是否存在全表扫描或缺失索引", "检查是否有批处理/报表在业务高峰运行"]
    if any("conn" in n.lower() for n in names) or "连接" in text or "session" in text:
        causes.append("连接数异常，疑似连接泄漏或连接池配置过大")
        actions += ["核对应用连接池 max 配置与数据库 processes/max_connections", "排查长时间 idle in transaction / 阻塞会话"]
    if "lock" in text or "锁" in text or any("lock" in n.lower() for n in names):
        causes.append("存在锁等待/阻塞，疑似长事务未提交")
        actions += ["定位阻塞源会话与其 SQL，必要时协调业务释放或终止会话", "缩短事务范围、统一加锁顺序"]
    if any(k in text for k in ("表空间", "tablespace", "磁盘", "disk", "空间")):
        causes.append("存储空间不足或增长过快")
        actions += ["确认空间增长来源（归档/日志/大表），清理或扩容", "设置空间增长趋势告警"]
    if not causes:
        causes.append("指标出现异常波动，但规则无法确定单一根因（未配置/无法调用大模型）")
        actions += ["结合告警时间点查看同时段 TOP SQL、等待事件与变更记录", "配置大模型后可获得更详细的分析"]
    conf = 55.0 if len(causes) == 1 and "无法确定" not in causes[0] else 35.0
    body = "1. 根因结论：" + "；".join(causes) + "\n2. 详细分析：以下结论由规则引擎基于指标突变点与告警文本推断（未使用大模型）。\n3. 处置建议：\n"
    body += "\n".join(f"- {a}" for a in actions[:6])
    body += f"\n4. 置信度评估：{int(conf)}（规则推断）"
    return body, conf


class RcaFailed(RuntimeError):
    """RCA 失败（已写入 STATUS=FAILED 记录）"""

    def __init__(self, rca_id, msg: str):
        super().__init__(msg)
        self.rca_id = rca_id


def llm_service_model() -> str:
    return llm.get_model_name()
