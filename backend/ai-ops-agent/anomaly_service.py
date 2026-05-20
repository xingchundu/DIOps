"""
异常检测服务 —— 无阈值时序异常识别
算法：Z-Score（快速）+ 基于统计的Isolation Forest近似（轻量，不依赖sklearn）
结果写入 Oracle AI_ANOMALY_RECORD
"""
import json
import math
import random
import statistics
from datetime import datetime
from typing import Optional

import db_service as db


def _zscore_anomaly(values: list[float], threshold: float = 2.5) -> list[tuple[int, float]]:
    """
    Z-Score 异常检测。返回 [(index, z_score), ...]
    """
    if len(values) < 3:
        return []
    mean = statistics.mean(values)
    try:
        stdev = statistics.stdev(values)
    except Exception:
        stdev = 0
    if stdev < 1e-9:
        return []
    return [
        (i, abs((v - mean) / stdev))
        for i, v in enumerate(values)
        if abs((v - mean) / stdev) > threshold
    ]


def _mad_anomaly(values: list[float], threshold: float = 3.5) -> list[tuple[int, float]]:
    """
    MAD (Median Absolute Deviation) 鲁棒异常检测。
    对含有极端值的序列比Z-Score更稳健。
    """
    if len(values) < 3:
        return []
    median = statistics.median(values)
    deviations = [abs(v - median) for v in values]
    mad = statistics.median(deviations)
    if mad < 1e-9:
        return []
    modified_z = [0.6745 * (v - median) / mad for v in values]
    return [(i, abs(z)) for i, z in enumerate(modified_z) if abs(z) > threshold]


def _isolation_score_approx(values: list[float], n_trees: int = 50) -> list[float]:
    """
    Isolation Forest 近似实现（单维，不依赖sklearn）。
    返回每个点的异常分 [0, 1]，越高越异常。
    """
    n = len(values)
    if n < 4:
        return [0.5] * n

    def _path_length(val, data, current_depth, limit):
        if current_depth >= limit or len(data) <= 1:
            size = len(data)
            return current_depth + (math.log(size - 1) + 0.5772156649 - (size - 1) / size if size > 2 else 1)
        split_min, split_max = min(data), max(data)
        if split_min == split_max:
            return current_depth + 1
        split = random.uniform(split_min, split_max)
        left = [d for d in data if d < split]
        right = [d for d in data if d >= split]
        if val < split:
            return _path_length(val, left, current_depth + 1, limit)
        return _path_length(val, right, current_depth + 1, limit)

    limit = int(math.ceil(math.log2(n))) if n > 1 else 1
    scores = []
    for val in values:
        avg_path = sum(_path_length(val, values, 0, limit) for _ in range(n_trees)) / n_trees
        c = 2 * (math.log(n - 1) + 0.5772156649) - 2 * (n - 1) / n if n > 2 else 1
        score = 2 ** (-avg_path / c) if c > 0 else 0.5
        scores.append(score)
    return scores


async def detect_and_save(instance_id: int, lookback_minutes: int = 60) -> list[int]:
    """
    对某实例最近N分钟的多项指标进行异常检测，结果写入 Oracle。
    返回新建的 ANOMALY_ID 列表。
    """
    samples = await db.get_metrics_window(instance_id, minutes_before=lookback_minutes, minutes_after=0)
    if len(samples) < 5:
        return []

    # 提取各指标时序
    metrics_data: dict[str, list] = {}
    for s in samples:
        ts = str(s.get("COLLECTED_AT", ""))
        for key, val in [
            ("cpu", s.get("METRIC_CPU")),
            ("connections", s.get("METRIC_CONN")),
            ("health_score", s.get("HEALTH_SCORE")),
        ]:
            if val is not None:
                metrics_data.setdefault(key, []).append({"ts": ts, "value": float(val)})

        raw = s.get("METRICS_JSON")
        if raw:
            try:
                extra = json.loads(raw) if isinstance(raw, str) else raw
                for k in ("memory_pct", "io_read_mb", "active_sessions", "lock_waits"):
                    v = extra.get(k)
                    if v is not None:
                        metrics_data.setdefault(k, []).append({"ts": ts, "value": float(v)})
            except Exception:
                pass

    anomaly_ids = []
    for metric_name, series in metrics_data.items():
        if len(series) < 5:
            continue
        vals = [p["value"] for p in series]

        # 双算法联合
        zscore_idx = {i: z for i, z in _zscore_anomaly(vals, threshold=2.5)}
        mad_idx = {i: z for i, z in _mad_anomaly(vals, threshold=3.0)}
        iso_scores = _isolation_score_approx(vals, n_trees=30)

        for i, point in enumerate(series):
            z = zscore_idx.get(i, 0)
            mad = mad_idx.get(i, 0)
            iso = iso_scores[i]

            # 综合异常分：取多算法加权
            combined_score = min(100, (
                (z / 5) * 40 +       # ZScore 贡献
                (mad / 5) * 30 +     # MAD 贡献
                iso * 30             # IsoForest 贡献（已是0-1）
            ) * 100 / 100)

            if combined_score < 40:
                continue  # 低分忽略

            # 确定严重等级
            severity = "LOW"
            if combined_score >= 80:
                severity = "CRITICAL"
            elif combined_score >= 65:
                severity = "HIGH"
            elif combined_score >= 50:
                severity = "MEDIUM"

            mean_val = statistics.mean(vals)
            expected = mean_val

            context = {
                "series_length": len(series),
                "z_score": round(z, 3),
                "mad_score": round(mad, 3),
                "isolation_score": round(iso, 3),
                "algorithm": "ZScore+MAD+IsolationForest",
                "context_window": [
                    {"ts": series[j]["ts"], "value": series[j]["value"]}
                    for j in range(max(0, i - 3), min(len(series), i + 4))
                ],
            }

            sql = """
                INSERT INTO AI_ANOMALY_RECORD(
                    INSTANCE_ID, METRIC_NAME, DETECTED_AT,
                    METRIC_VALUE, EXPECTED_VALUE, DEVIATION,
                    ANOMALY_SCORE, ALGORITHM, SEVERITY, DETAIL
                ) VALUES(:1,:2,SYSTIMESTAMP,:3,:4,:5,:6,:7,:8,:9)
                RETURNING ANOMALY_ID INTO :10
            """
            aid = await db.insert_returning_id(sql, [
                instance_id,
                metric_name,
                round(point["value"], 4),
                round(expected, 4),
                round(point["value"] - expected, 4),
                round(combined_score, 2),
                "ZScore+MAD+IsolationForest",
                severity,
                json.dumps(context, ensure_ascii=False),
            ])
            anomaly_ids.append(aid)

    return anomaly_ids


async def get_anomalies(instance_id: Optional[int] = None, limit: int = 50) -> list[dict]:
    """查询异常记录"""
    if instance_id:
        return await db.query(
            """SELECT * FROM AI_ANOMALY_RECORD WHERE INSTANCE_ID=:1
               ORDER BY DETECTED_AT DESC FETCH FIRST :2 ROWS ONLY""",
            [instance_id, limit]
        )
    return await db.query(
        """SELECT * FROM AI_ANOMALY_RECORD
           ORDER BY DETECTED_AT DESC FETCH FIRST :1 ROWS ONLY""",
        [limit]
    )
