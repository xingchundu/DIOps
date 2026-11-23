"""
知识图谱（Python 侧）：与 Node kgService 共用 AI_KG_NODE / AI_KG_EDGE 表。
- record_rca：RCA 结果写入图谱（失败只记日志，不影响主流程）
- kg_context：为 ChatOps 提供与问题相关的历史事实（实例问题、根因、处置建议）
"""
import hashlib
import json
import logging
import re

import db_service as db

log = logging.getLogger("kg")


def byte_trunc(s, max_bytes: int) -> str:
    """Oracle VARCHAR2 默认按字节计长；中文 3 字节，直接 [:n] 会 ORA-12899。"""
    s = "" if s is None else str(s)
    b = s.encode("utf-8")
    if len(b) <= max_bytes:
        return s
    return b[:max_bytes].decode("utf-8", errors="ignore")


def _md5(s: str) -> str:
    return hashlib.md5((s or "").encode("utf-8")).hexdigest()


async def _upsert_node(ntype: str, key: str, label: str, props=None, source=None, ref_id=None, bump=True) -> int:
    key = byte_trunc(key, 400)
    label = byte_trunc(label or key, 400)
    p = json.dumps(props, ensure_ascii=False) if props is not None else None
    await db.execute(
        """MERGE INTO AI_KG_NODE t
             USING (SELECT :1 NODE_TYPE, :2 NODE_KEY FROM dual) s
                ON (t.NODE_TYPE = s.NODE_TYPE AND t.NODE_KEY = s.NODE_KEY)
           WHEN MATCHED THEN UPDATE SET t.LABEL = :3, t.PROPS = NVL(:4, t.PROPS),
                t.WEIGHT = t.WEIGHT + :5, t.UPDATED_AT = SYSTIMESTAMP
           WHEN NOT MATCHED THEN INSERT (NODE_TYPE, NODE_KEY, LABEL, PROPS, WEIGHT, SOURCE, REF_ID)
                VALUES (:6, :7, :8, :9, 1, :10, :11)""",
        [ntype, key, label, p, 1 if bump else 0, ntype, key, label, p, source, ref_id],
    )
    row = await db.query_one("SELECT NODE_ID FROM AI_KG_NODE WHERE NODE_TYPE=:1 AND NODE_KEY=:2", [ntype, key])
    return row["NODE_ID"]


async def _upsert_edge(src: int, dst: int, rel: str):
    if not src or not dst or src == dst:
        return
    await db.execute(
        """MERGE INTO AI_KG_EDGE t
             USING (SELECT :1 SRC_ID, :2 DST_ID, :3 REL_TYPE FROM dual) s
                ON (t.SRC_ID = s.SRC_ID AND t.DST_ID = s.DST_ID AND t.REL_TYPE = s.REL_TYPE)
           WHEN MATCHED THEN UPDATE SET t.WEIGHT = t.WEIGHT + 1, t.UPDATED_AT = SYSTIMESTAMP
           WHEN NOT MATCHED THEN INSERT (SRC_ID, DST_ID, REL_TYPE) VALUES (:4, :5, :6)""",
        [src, dst, rel, src, dst, rel],
    )


def _split_points(text: str, limit: int = 5) -> list[str]:
    """从 LLM/规则输出里粗略拆出条目（编号/短横线开头的行）。"""
    out = []
    for line in (text or "").splitlines():
        line = line.strip()
        m = re.match(r"^(?:\d+[.、)）]|[-*•])\s*(.+)$", line)
        if m and len(m.group(1)) >= 4:
            out.append(m.group(1).strip())
        if len(out) >= limit:
            break
    return out


async def record_rca(rca_id, instance_id, instance_name, root_cause: str, recommendations: str):
    try:
        title = (root_cause or "").strip().splitlines()[0][:80] if root_cause else f"RCA {rca_id}"
        rn = await _upsert_node("RCA", f"RCA:{rca_id}", f"根因分析 {title}",
                                {"summary": (root_cause or "")[:800]}, "RCA", rca_id)
        if instance_id is not None:
            inst = await _upsert_node("INSTANCE", f"INSTANCE:{instance_id}", instance_name or f"实例{instance_id}",
                                      None, "RCA", instance_id, bump=False)
            await _upsert_edge(rn, inst, "OF_INSTANCE")
        cn = await _upsert_node("CAUSE", f"CAUSE:{_md5(title)[:16]}", title, {"text": root_cause[:800]}, "RCA")
        await _upsert_edge(rn, cn, "CAUSED_BY")
        for a in _split_points(recommendations, 5):
            an = await _upsert_node("ACTION", f"ACTION:{_md5(a)[:16]}", byte_trunc(a, 200), {"text": a}, "RCA")
            await _upsert_edge(cn, an, "FIXED_BY")
    except Exception as e:  # noqa: BLE001
        log.warning("KG record_rca 失败（忽略）: %s", e)


async def kg_context(question: str, max_chars: int = 1500) -> str:
    """按关键词找图谱节点 + 一跳关系，压成一小段文字。表不存在/出错时返回空串。"""
    try:
        terms = re.findall(r"[一-鿿]{2,6}|[A-Za-z_]{3,}", question or "")[:5]
        if not terms:
            return ""
        likes = " OR ".join(f"LOWER(LABEL) LIKE :{i + 1}" for i in range(len(terms)))
        rows = await db.query(
            f"""SELECT NODE_ID, NODE_TYPE, LABEL, WEIGHT FROM AI_KG_NODE
                 WHERE NODE_TYPE IN ('FINDING','CAUSE','ACTION','RCA','OPT','DIAG') AND ({likes})
                 ORDER BY WEIGHT DESC, UPDATED_AT DESC FETCH FIRST 8 ROWS ONLY""",
            [f"%{t.lower()}%" for t in terms],
        )
        lines = []
        for r in rows:
            rel = await db.query(
                """SELECT e.REL_TYPE, n.NODE_TYPE, n.LABEL FROM AI_KG_EDGE e
                     JOIN AI_KG_NODE n ON n.NODE_ID = CASE WHEN e.SRC_ID = :1 THEN e.DST_ID ELSE e.SRC_ID END
                    WHERE e.SRC_ID = :2 OR e.DST_ID = :3 FETCH FIRST 4 ROWS ONLY""",
                [r["NODE_ID"], r["NODE_ID"], r["NODE_ID"]],
            )
            rel_txt = "；".join(f"{x['REL_TYPE']}→{x['LABEL']}" for x in rel)
            lines.append(f"- [{r['NODE_TYPE']}] {r['LABEL']}（出现{r['WEIGHT']}次）" + (f" 关联: {rel_txt}" if rel_txt else ""))
        return byte_trunc("\n".join(lines), max_chars)
    except Exception as e:  # noqa: BLE001
        log.debug("kg_context 失败: %s", e)
        return ""
