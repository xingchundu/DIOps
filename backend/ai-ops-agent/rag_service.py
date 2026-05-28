"""
知识库 RAG 服务
- 文档上传 → 分块 → 向量化（Embedding）→ 写入 Oracle AI_KB_CHUNK
- 问答时检索最相似的 Top-K 块，注入 LLM Context
- 知识库索引（Embedding）持久化到 Oracle
"""
import json
import re
from typing import Optional

import db_service as db
import llm_service as llm


CHUNK_SIZE = 400       # 每块字符数
CHUNK_OVERLAP = 80     # 块间重叠字符数
TOP_K = 5              # 检索Top-K块


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
    # 1. 写入文档表
    sql = """
        INSERT INTO AI_KNOWLEDGE_DOC(TITLE, DOC_TYPE, CONTENT, TAGS, SOURCE, CREATED_BY)
        VALUES(:1,:2,:3,:4,:5,:6)
        RETURNING DOC_ID INTO :7
    """
    doc_id = await db.insert_returning_id(sql, [title, doc_type, content, tags, source, created_by])

    # 2. 分块 + 向量化 + 写入
    chunks = _split_chunks(content)
    for idx, chunk_text in enumerate(chunks):
        embedding = await llm.get_embedding(chunk_text)
        embedding_json = json.dumps(embedding)
        # 关键词哈希（简单提取）
        keywords = " ".join(re.findall(r"[\u4e00-\u9fff]{2,4}|[a-zA-Z]{3,}", chunk_text)[:20])

        await db.execute(
            """INSERT INTO AI_KB_CHUNK(DOC_ID, CHUNK_INDEX, CHUNK_TEXT, EMBEDDING, EMBEDDING_DIM, KEYWORD_HASH)
               VALUES(:1,:2,:3,:4,:5,:6)""",
            [doc_id, idx, chunk_text, embedding_json, len(embedding), keywords[:256]]
        )

    # 3. 更新文档分块数
    await db.execute(
        "UPDATE AI_KNOWLEDGE_DOC SET CHUNK_COUNT=:1 WHERE DOC_ID=:2",
        [len(chunks), doc_id]
    )

    return doc_id


async def search_knowledge(query: str, top_k: int = TOP_K) -> list[dict]:
    """
    RAG 向量检索：将查询向量化后与所有 KB 块做余弦相似度排序，返回 Top-K。
    为降低 Oracle 查询压力，分页拉取所有 Embedding 做客户端计算（知识库小规模可行）。
    """
    query_embedding = await llm.get_embedding(query)

    # 拉取所有有效分块的 Embedding（实际可加 WHERE DOC_ID IN (enabled docs)）
    chunks = await db.query(
        """SELECT c.CHUNK_ID, c.DOC_ID, c.CHUNK_INDEX, c.CHUNK_TEXT, c.EMBEDDING,
                  d.TITLE, d.DOC_TYPE, d.TAGS
           FROM AI_KB_CHUNK c
           JOIN AI_KNOWLEDGE_DOC d ON c.DOC_ID = d.DOC_ID
           WHERE d.ENABLED = 1""",
        []
    )

    scored = []
    for chunk in chunks:
        emb_raw = chunk.get("EMBEDDING")
        if not emb_raw:
            continue
        try:
            emb = json.loads(emb_raw) if isinstance(emb_raw, str) else emb_raw
        except Exception:
            continue
        sim = llm.cosine_similarity(query_embedding, emb)
        scored.append({
            "chunk_id": chunk["CHUNK_ID"],
            "doc_id": chunk["DOC_ID"],
            "doc_title": chunk["TITLE"],
            "doc_type": chunk["DOC_TYPE"],
            "tags": chunk["TAGS"],
            "chunk_text": chunk["CHUNK_TEXT"],
            "similarity": round(sim, 4),
        })

    scored.sort(key=lambda x: x["similarity"], reverse=True)

    # 按文档去重：同一文档只保留最高相似度的分块
    seen_docs = set()
    deduped = []
    for item in scored:
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
    if context_chunks:
        kb_section = "\n\n【相关知识库内容】\n" + "\n---\n".join(context_chunks)

    prompt = f"""用户问题: {question}{instance_info}{kb_section}

请给出专业、简洁的回答（中文）。如果问题涉及SQL优化，请提供具体示例。"""

    # 5. LLM 生成
    answer = await llm.generate(prompt, system=system_prompt, max_tokens=800)

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
    """按登录用户过滤；CREATED_BY 为空或 system（遗留）可访问；用户名与 Oracle 比较一律忽略大小写。"""
    u = (created_by or "").strip()
    blocked = await db.query_one(
        """SELECT COUNT(*) AS C FROM AI_CHAT_HISTORY
           WHERE SESSION_ID=:1 AND CREATED_BY IS NOT NULL
             AND UPPER(TRIM(CREATED_BY)) NOT IN ('SYSTEM', UPPER(:2))""",
        [session_id, u],
    )
    n_other = int(blocked["C"]) if blocked and blocked.get("C") is not None else 0
    if n_other > 0:
        raise PermissionError("无权访问该会话")

    return await db.query(
        """SELECT CHAT_ID, ROLE, CONTENT, CREATED_AT, RETRIEVED_DOCS
           FROM AI_CHAT_HISTORY
           WHERE SESSION_ID=:1
             AND (CREATED_BY IS NULL OR UPPER(TRIM(CREATED_BY)) IN ('SYSTEM', UPPER(:2)))
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
    """列出当前用户可见会话：至少存在一条 CREATED_BY 为空、system 或与当前用户（忽略大小写）一致的记录。"""
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
                 GROUP BY SESSION_ID
               ) agg
         WHERE EXISTS (
                 SELECT 1
                   FROM AI_CHAT_HISTORY a
                  WHERE a.SESSION_ID = agg.SESSION_ID
                    AND (
                         a.CREATED_BY IS NULL
                      OR UPPER(TRIM(a.CREATED_BY)) IN ('SYSTEM', UPPER(:1))
                    )
               )
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
    # 删除旧块
    await db.execute("DELETE FROM AI_KB_CHUNK WHERE DOC_ID=:1", [doc_id])
    # 重新分块索引
    content = doc.get("CONTENT", "")
    if hasattr(content, "read"):
        content = content.read()
    chunks = _split_chunks(content)
    for idx, chunk_text in enumerate(chunks):
        embedding = await llm.get_embedding(chunk_text)
        keywords = " ".join(re.findall(r"[\u4e00-\u9fff]{2,4}|[a-zA-Z]{3,}", chunk_text)[:20])
        await db.execute(
            """INSERT INTO AI_KB_CHUNK(DOC_ID, CHUNK_INDEX, CHUNK_TEXT, EMBEDDING, EMBEDDING_DIM, KEYWORD_HASH)
               VALUES(:1,:2,:3,:4,:5,:6)""",
            [doc_id, idx, chunk_text, json.dumps(embedding), len(embedding), keywords[:256]]
        )
    await db.execute(
        "UPDATE AI_KNOWLEDGE_DOC SET CHUNK_COUNT=:1, UPDATED_AT=SYSTIMESTAMP WHERE DOC_ID=:2",
        [len(chunks), doc_id]
    )
