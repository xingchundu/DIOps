"""
知识库 RAG 服务
"""
import asyncio
import heapq
import json
import os
import re
from typing import Optional

import db_service as db
import llm_service as llm
import kg_service as kg
from llm_service import LLMError

CHUNK_SIZE = 400
CHUNK_OVERLAP = 80
TOP_K = 5
RAG_BATCH_SIZE = int(os.getenv("RAG_BATCH_SIZE", "200"))


def _split_chunks(text: str, chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """将文本按固定大小分块，带重叠"""
    if not text:
        return []
    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunk = text[start:end]
        chunks.append(chunk.strip())
        start += chunk_size - overlap
    return [c for c in chunks if len(c) > 30]  # 过滤过短块


async def add_document(
    title: str,
    content: str,
    doc_type: str = "EXPERIENCE",
    tags: str = "",
    source: str = "",
    created_by: str = "system",
) -> int:
    """
    新增知识库文档：写入 AI_KNOWLEDGE_DOC + 分块向量化写入 AI_KB_CHUNK
    返回 DOC_ID
    """
    # 1. 先完成全部分块的向量化（并发、有上限），全部成功后再写库。
    #    原来逐块串行 embedding（大文档要很久）且边算边写：中途失败留下“半索引”的脏文档
    chunks = _split_chunks(content)
    sem = asyncio.Semaphore(int(os.getenv("EMBED_CONCURRENCY", "4")))

    async def _embed(t: str):
        async with sem:
            try:
                return await llm.get_embedding(t)
            except Exception:  # noqa: BLE001  未配置向量模型：保留文本，走关键词检索
                return None

    embeddings = await asyncio.gather(*[_embed(c) for c in chunks])

    # 2. 写入文档与分块；任何一步失败都删除已写入部分
    sql = """
        INSERT INTO AI_KNOWLEDGE_DOC(TITLE, DOC_TYPE, CONTENT, TAGS, SOURCE, CREATED_BY)
        VALUES(:1,:2,:3,:4,:5,:6)
        RETURNING DOC_ID INTO :7
    """
    doc_id = await db.insert_returning_id(sql, [title, doc_type, content, tags, source, created_by])
    try:
        for idx, (chunk_text, embedding) in enumerate(zip(chunks, embeddings)):
            keywords = " ".join(re.findall(r"[\u4e00-\u9fff]{2,4}|[a-zA-Z]{3,}", chunk_text)[:20])
            await db.execute(
                """INSERT INTO AI_KB_CHUNK(DOC_ID, CHUNK_INDEX, CHUNK_TEXT, EMBEDDING, EMBEDDING_DIM, KEYWORD_HASH)
                   VALUES(:1,:2,:3,:4,:5,:6)""",
                [doc_id, idx, chunk_text, json.dumps(embedding) if embedding else None, len(embedding) if embedding else 0, kg.byte_trunc(keywords, 256)]
            )
        await db.execute(
            "UPDATE AI_KNOWLEDGE_DOC SET CHUNK_COUNT=:1 WHERE DOC_ID=:2",
            [len(chunks), doc_id]
        )
    except Exception:
        try:
            await db.execute("DELETE FROM AI_KB_CHUNK WHERE DOC_ID=:1", [doc_id])
            await db.execute("DELETE FROM AI_KNOWLEDGE_DOC WHERE DOC_ID=:1", [doc_id])
        except Exception:
            pass
        raise

    return doc_id


async def search_knowledge(query: str, top_k: int = TOP_K) -> list[dict]:
    """RAG 向量检索：关键词预筛 + 分页批次 + Top-K 堆，避免全量载入内存。"""
    try:
        query_embedding = await llm.get_embedding(query)
    except Exception:  # noqa: BLE001
        query_embedding = None  # 无向量模型：降级为关键词打分
    terms = [t.lower() for t in re.findall(r"[\u4e00-\u9fff]{2,}|[a-zA-Z]{3,}", query)[:6]]

    where_extra = ""
    params_base: list = []
    if terms:
        likes = [f"UPPER(c.CHUNK_TEXT) LIKE '%' || UPPER(:{i + 1}) || '%'" for i in range(len(terms))]
        where_extra = " AND (" + " OR ".join(likes) + ")"
        params_base = terms

    heap: list[tuple[float, int, dict]] = []
    seq = 0
    offset = 0
    max_candidates = max(top_k * 20, 500)
    off_bind = len(params_base) + 1
    lim_bind = len(params_base) + 2

    while offset < max_candidates:
        binds = params_base + [offset, RAG_BATCH_SIZE]
        sql = f"""
            SELECT c.CHUNK_ID, c.DOC_ID, c.CHUNK_INDEX, c.CHUNK_TEXT, c.EMBEDDING,
                   d.TITLE, d.DOC_TYPE, d.TAGS
            FROM AI_KB_CHUNK c
            JOIN AI_KNOWLEDGE_DOC d ON c.DOC_ID = d.DOC_ID
            WHERE d.ENABLED = 1{where_extra}
            ORDER BY c.CHUNK_ID
            OFFSET :{off_bind} ROWS FETCH NEXT :{lim_bind} ROWS ONLY
        """
        chunks = await db.query(sql, binds)
        if not chunks:
            break

        for chunk in chunks:
            emb_raw = chunk.get("EMBEDDING")
            if query_embedding is None or not emb_raw:
                # 关键词命中率作为相似度（0~1），保证没有向量模型时知识库依旧可用
                text_up = str(chunk.get("CHUNK_TEXT") or "").upper()
                hit = sum(1 for t in terms if t.upper() in text_up)
                if not terms or hit == 0:
                    continue
                sim = hit / len(terms)
            else:
                try:
                    emb = json.loads(emb_raw) if isinstance(emb_raw, str) else emb_raw
                except Exception:
                    continue
                sim = llm.cosine_similarity(query_embedding, emb)
            item = {
                "chunk_id": chunk["CHUNK_ID"],
                "doc_id": chunk["DOC_ID"],
                "doc_title": chunk["TITLE"],
                "doc_type": chunk["DOC_TYPE"],
                "tags": chunk["TAGS"],
                "chunk_text": chunk["CHUNK_TEXT"],
                "similarity": round(sim, 4),
            }
            seq += 1
            if len(heap) < top_k * 3:
                heapq.heappush(heap, (sim, seq, item))
            elif sim > heap[0][0]:
                heapq.heapreplace(heap, (sim, seq, item))

        offset += len(chunks)
        if len(chunks) < RAG_BATCH_SIZE:
            break

    scored_items = [x[2] for x in sorted(heap, key=lambda x: x[0], reverse=True)]
    seen_docs = set()
    deduped = []
    for item in scored_items:
        if item["doc_id"] not in seen_docs:
            seen_docs.add(item["doc_id"])
            deduped.append(item)
    return deduped[:top_k]


async def chat_with_rag(
    session_id: str,
    question: str,
    instance_id: Optional[int] = None,
    history: list[dict] = None,
    created_by: str = "system",
) -> dict:
    """
    ChatOps 问答主入口：RAG检索 + LLM生成答案 + 写入历史
    返回: {answer, retrieved_docs, session_id}
    """
    # 1. 记录用户消息（用户消息不记录LLM模型）
    await db.execute(
        """INSERT INTO AI_CHAT_HISTORY(SESSION_ID, ROLE, CONTENT, INSTANCE_ID, CREATED_BY)
           VALUES(:1,'user',:2,:3,:4)""",
        [session_id, question, instance_id, created_by]
    )

    # 2. RAG 检索相关知识
    retrieved = await search_knowledge(question, top_k=TOP_K)
    context_chunks = [
        f"【{r['doc_title']}】\n{r['chunk_text']}"
        for r in retrieved
        if r["similarity"] > 0.2
    ][:3]  # 最多3条注入，避免超出LLM上下文

    # 3. 获取实例信息（可选）
    instance_info = ""
    if instance_id:
        inst = await db.get_cmdb_instance(instance_id)
        if inst:
            instance_info = f"\n当前关联实例: {inst.get('INSTANCE_NAME')} ({inst.get('DB_TYPE')}) IP: {inst.get('HOST_IP')}"
        # 附加最近指标摘要
        recent = await db.get_metrics_window(instance_id, minutes_before=30, minutes_after=0)
        if recent:
            last = recent[-1]
            instance_info += (
                f"\n最近指标: CPU={last.get('METRIC_CPU')}%, "
                f"连接数={last.get('METRIC_CONN')}, "
                f"健康分={last.get('HEALTH_SCORE')}"
            )

    # 4. 构建 Prompt
    system_prompt = (
        "你是专业的数据库智能运维助手（DIOps），擅长Oracle/MySQL/PostgreSQL的性能调优、"
        "故障排查、SQL优化。请基于知识库内容和运维经验，用中文给出清晰专业的回答。"
    )

    kb_section = ""
    kg_text = await kg.kg_context(question)
    if kg_text:
        kb_section += "\n\n【知识图谱：历史相关问题/根因/处置】\n" + kg_text
    if context_chunks:
        kb_section += "\n\n【相关知识库内容】\n" + "\n---\n".join(context_chunks)

    prompt = f"""用户问题: {question}{instance_info}{kb_section}

请给出专业、简洁的回答（中文）。如果问题涉及SQL优化，请提供具体示例。"""

    # 5. LLM 生成（失败时不写入 assistant 消息）
    try:
        answer = await llm.generate(prompt, system=system_prompt, max_tokens=800)
    except LLMError as e:
        raise RuntimeError(f"LLM 生成失败: {e}") from e

    # 6. 写入助手消息
    await db.execute(
        """INSERT INTO AI_CHAT_HISTORY(SESSION_ID, ROLE, CONTENT, INSTANCE_ID, RETRIEVED_DOCS, LLM_MODEL, CREATED_BY)
           VALUES(:1,'assistant',:2,:3,:4,:5,:6)""",
        [
            session_id,
            answer,
            instance_id,
            json.dumps([{"title": r["doc_title"], "sim": r["similarity"]} for r in retrieved[:5]], ensure_ascii=False),
            llm.get_model_name(),
            created_by,
        ]
    )

    return {
        "session_id": session_id,
        "answer": answer,
        "retrieved_docs": [
            {
                "title": r["doc_title"],
                "doc_type": r["doc_type"],
                "similarity": r["similarity"],
                "snippet": r["chunk_text"][:200],
            }
            for r in retrieved[:3]
        ],
    }


async def get_chat_history(session_id: str, limit: int, created_by: str) -> list[dict]:
    """仅返回当前用户自己的会话消息（CREATED_BY 必须精确匹配，NULL 不可见）。"""
    u = (created_by or "").strip()
    owner = await db.query_one(
        """SELECT COUNT(*) AS C FROM AI_CHAT_HISTORY
           WHERE SESSION_ID=:1 AND UPPER(TRIM(CREATED_BY))=UPPER(:2)""",
        [session_id, u],
    )
    if not owner or int(owner.get("C") or 0) == 0:
        raise PermissionError("无权访问该会话")

    foreign = await db.query_one(
        """SELECT COUNT(*) AS C FROM AI_CHAT_HISTORY
           WHERE SESSION_ID=:1
             AND CREATED_BY IS NOT NULL
             AND UPPER(TRIM(CREATED_BY)) <> UPPER(:2)""",
        [session_id, u],
    )
    if foreign and int(foreign.get("C") or 0) > 0:
        raise PermissionError("无权访问该会话")

    return await db.query(
        """SELECT CHAT_ID, ROLE, CONTENT, CREATED_AT, RETRIEVED_DOCS
           FROM AI_CHAT_HISTORY
           WHERE SESSION_ID=:1 AND UPPER(TRIM(CREATED_BY))=UPPER(:2)
           ORDER BY CREATED_AT DESC FETCH FIRST :3 ROWS ONLY""",
        [session_id, u, limit],
    )


def _normalize_chat_session_row(row: dict) -> dict:
    """统一键名（Oracle 驱动可能返回小写列名），供前端使用 SESSION_ID / LAST_TIME / PREVIEW。"""
    if not row:
        return {}
    sid = row.get("SESSION_ID") or row.get("session_id")
    lt = row.get("LAST_TIME") or row.get("last_time")
    pv = row.get("PREVIEW") or row.get("preview")
    return {"SESSION_ID": sid, "LAST_TIME": lt, "PREVIEW": pv}


async def list_chat_sessions(limit: int, created_by: str) -> list[dict]:
    """列出当前用户自己的会话（CREATED_BY 精确匹配，不含 NULL/system 公共会话）。"""
    u = (created_by or "").strip()
    rows = await db.query(
        """
        SELECT agg.SESSION_ID,
               agg.last_at AS LAST_TIME,
               (SELECT SUBSTR(CAST(h.CONTENT AS VARCHAR2(4000)), 1, 100)
                  FROM AI_CHAT_HISTORY h
                 WHERE h.SESSION_ID = agg.SESSION_ID AND h.ROLE = 'user'
                 ORDER BY h.CREATED_AT ASC
                 FETCH FIRST 1 ROW ONLY) AS PREVIEW
          FROM (
                SELECT SESSION_ID, MAX(CREATED_AT) AS last_at
                  FROM AI_CHAT_HISTORY
                 WHERE UPPER(TRIM(CREATED_BY)) = UPPER(:1)
                 GROUP BY SESSION_ID
               ) agg
         ORDER BY agg.last_at DESC
         FETCH FIRST :2 ROWS ONLY
        """,
        [u, limit],
    )
    return [_normalize_chat_session_row(r) for r in rows]


async def list_documents(doc_type: Optional[str] = None) -> list[dict]:
    if doc_type:
        return await db.query(
            """SELECT DOC_ID, TITLE, DOC_TYPE, TAGS, SOURCE, CHUNK_COUNT, ENABLED, CREATED_AT
               FROM AI_KNOWLEDGE_DOC WHERE DOC_TYPE=:1 ORDER BY CREATED_AT DESC""",
            [doc_type]
        )
    return await db.query(
        """SELECT DOC_ID, TITLE, DOC_TYPE, TAGS, SOURCE, CHUNK_COUNT, ENABLED, CREATED_AT
           FROM AI_KNOWLEDGE_DOC ORDER BY CREATED_AT DESC""",
        []
    )


async def delete_document(doc_id: int):
    await db.execute("DELETE FROM AI_KB_CHUNK WHERE DOC_ID=:1", [doc_id])
    await db.execute("DELETE FROM AI_KNOWLEDGE_DOC WHERE DOC_ID=:1", [doc_id])


async def reindex_document(doc_id: int):
    """重新对已存在文档做向量化（文档内容更新后调用）"""
    doc = await db.query_one("SELECT * FROM AI_KNOWLEDGE_DOC WHERE DOC_ID=:1", [doc_id])
    if not doc:
        return
    # 先算完新向量再删旧块：中途失败不会把原有索引弄丢；无向量模型时降级为无向量（关键词检索）
    content = doc.get("CONTENT", "")
    if hasattr(content, "read"):
        content = content.read()
    chunks = _split_chunks(content)
    embeddings = []
    for chunk_text in chunks:
        try:
            embeddings.append(await llm.get_embedding(chunk_text))
        except Exception:  # noqa: BLE001
            embeddings.append(None)
    await db.execute("DELETE FROM AI_KB_CHUNK WHERE DOC_ID=:1", [doc_id])
    for idx, (chunk_text, embedding) in enumerate(zip(chunks, embeddings)):
        keywords = " ".join(re.findall(r"[\u4e00-\u9fff]{2,4}|[a-zA-Z]{3,}", chunk_text)[:20])
        await db.execute(
            """INSERT INTO AI_KB_CHUNK(DOC_ID, CHUNK_INDEX, CHUNK_TEXT, EMBEDDING, EMBEDDING_DIM, KEYWORD_HASH)
               VALUES(:1,:2,:3,:4,:5,:6)""",
            [doc_id, idx, chunk_text, json.dumps(embedding) if embedding else None, len(embedding) if embedding else 0, kg.byte_trunc(keywords, 256)]
        )
    await db.execute(
        "UPDATE AI_KNOWLEDGE_DOC SET CHUNK_COUNT=:1, UPDATED_AT=SYSTIMESTAMP WHERE DOC_ID=:2",
        [len(chunks), doc_id]
    )
