"""
告警降噪服务 —— 相似告警聚类
使用向量相似度（基于 llm_service.get_embedding）将高度相似告警合并
目标: 减少 DBA 重复处理工作量
结果写入 Oracle AI_ALERT_CLUSTER
"""
import json
import statistics
from typing import Optional

import db_service as db
import llm_service as llm


async def cluster_open_alerts(similarity_threshold: float = 0.75) -> list[int]:
    """
    对当前所有 OPEN 状态告警做聚类，合并相似告警。
    返回新建或更新的 CLUSTER_ID 列表。
    """
    # 获取最近24小时未处理告警
    alerts = await db.query(
        """SELECT ALERT_ID, RULE_NAME, INSTANCE_NAME, SEVERITY, CONTENT, TRIGGER_TIME
           FROM ALERT_RECORD
           WHERE STATUS='OPEN'
             AND TRIGGER_TIME >= SYSTIMESTAMP - NUMTODSINTERVAL(24, 'HOUR')
           ORDER BY TRIGGER_TIME DESC
           FETCH FIRST 200 ROWS ONLY""",
        []
    )

    if len(alerts) < 2:
        return []

    # 为每个告警生成向量
    embeddings = []
    for alert in alerts:
        text = f"{alert.get('RULE_NAME', '')} {alert.get('INSTANCE_NAME', '')} {alert.get('CONTENT', '')}"
        vec = await llm.get_embedding(text)
        embeddings.append(vec)

    # 简单贪婪聚类
    n = len(alerts)
    assigned = [-1] * n  # cluster index
    cluster_count = 0
    clusters: dict[int, list[int]] = {}  # cluster_id → [alert_index]

    for i in range(n):
        if assigned[i] != -1:
            continue
        # 新簇
        cid = cluster_count
        cluster_count += 1
        assigned[i] = cid
        clusters[cid] = [i]

        for j in range(i + 1, n):
            if assigned[j] != -1:
                continue
            sim = llm.cosine_similarity(embeddings[i], embeddings[j])
            if sim >= similarity_threshold:
                assigned[j] = cid
                clusters[cid].append(j)

    # 只保存2+告警的簇（单告警无需聚类）
    result_ids = []
    for cid, indices in clusters.items():
        if len(indices) < 2:
            continue

        cluster_alerts = [alerts[i] for i in indices]
        alert_ids = [a["ALERT_ID"] for a in cluster_alerts]

        # 计算簇内平均相似度
        sims = []
        rep_idx = indices[0]
        for idx in indices[1:]:
            sims.append(llm.cosine_similarity(embeddings[rep_idx], embeddings[idx]))
        avg_sim = statistics.mean(sims) if sims else 1.0

        # 代表性告警（时间最早）
        rep_alert = cluster_alerts[0]

        # 聚类特征摘要
        rule_names = list({a.get("RULE_NAME", "") for a in cluster_alerts})
        instances = list({a.get("INSTANCE_NAME", "") for a in cluster_alerts})
        cluster_key = f"rules=[{','.join(rule_names[:3])}] instances=[{','.join(instances[:3])}]"
        cluster_reason = (
            f"共 {len(alert_ids)} 条相似告警，平均相似度 {avg_sim:.0%}，"
            f"涉及规则: {', '.join(rule_names[:3])}，"
            f"涉及实例: {', '.join(instances[:3])}"
        )

        # 写入 Oracle（UPSERT 用 DELETE + INSERT 模拟）
        # 先检查是否已存在相同代表告警的簇
        existing = await db.query(
            "SELECT CLUSTER_ID FROM AI_ALERT_CLUSTER WHERE REPRESENTATIVE_ALERT_ID=:1 AND STATUS='ACTIVE'",
            [rep_alert["ALERT_ID"]]
        )
        if existing:
            # 更新现有簇
            cluster_id = existing[0]["CLUSTER_ID"]
            await db.execute(
                """UPDATE AI_ALERT_CLUSTER
                   SET ALERT_IDS=:1, ALERT_COUNT=:2, SIMILARITY_AVG=:3,
                       CLUSTER_REASON=:4, UPDATED_AT=SYSTIMESTAMP
                   WHERE CLUSTER_ID=:5""",
                [
                    json.dumps(alert_ids),
                    len(alert_ids),
                    round(avg_sim * 100, 2),
                    cluster_reason,
                    cluster_id,
                ]
            )
            result_ids.append(cluster_id)
        else:
            sql = """
                INSERT INTO AI_ALERT_CLUSTER(
                    CLUSTER_KEY, ALERT_IDS, ALERT_COUNT, SIMILARITY_AVG,
                    REPRESENTATIVE_ALERT_ID, CLUSTER_REASON, STATUS
                ) VALUES(:1,:2,:3,:4,:5,:6,'ACTIVE')
                RETURNING CLUSTER_ID INTO :7
            """
            cid_new = await db.insert_returning_id(sql, [
                cluster_key[:256],
                json.dumps(alert_ids),
                len(alert_ids),
                round(avg_sim * 100, 2),
                rep_alert["ALERT_ID"],
                cluster_reason[:1024],
            ])
            result_ids.append(cid_new)

    return result_ids


async def get_clusters(status: str = "ACTIVE", limit: int = 50) -> list[dict]:
    return await db.query(
        """SELECT * FROM AI_ALERT_CLUSTER WHERE STATUS=:1
           ORDER BY CREATED_AT DESC FETCH FIRST :2 ROWS ONLY""",
        [status, limit]
    )
