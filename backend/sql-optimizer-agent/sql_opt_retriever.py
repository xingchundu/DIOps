"""
SQL 优化 Agent — 向量检索抽象与实现（Oracle 为主；Milvus / pgvector 预留）。

环境变量：
  SQL_OPT_VECTOR_BACKEND = none | oracle | milvus | pgvector   （默认 none）
  SQL_OPT_RAG_TOP_K      整数，默认 5

Oracle 路径：从当前请求同一 Oracle 连接读取 SQL_OPT_KB_CHUNK（须先执行 migration_sql_opt_kb_chunk.sql）。
备选 Milvus/pgvector：仅占位实现，返回空列表，接入时实现 search() 并配置相应连接。
"""
from __future__ import annotations

import asyncio
import json
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from db_service import get_connection
from llm_service import cosine_similarity, get_embedding


def _read_clob(v: Any) -> str:
    if v is None:
        return ""
    if hasattr(v, "read"):
        return str(v.read())
    return str(v)


def _backend() -> str:
    return (os.getenv("SQL_OPT_VECTOR_BACKEND") or "none").strip().lower()


def _top_k() -> int:
    try:
        return max(1, min(20, int(os.getenv("SQL_OPT_RAG_TOP_K", "5"))))
    except ValueError:
        return 5


@dataclass
class RetrievedChunk:
    chunk_id: int | None
    text: str
    score: float | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


class SqlOptRetriever(ABC):
    """向量检索抽象：统一 search(query, db_type, top_k) -> chunks。"""

    @abstractmethod
    async def search(
        self,
        query: str,
        *,
        db_type: str,
        top_k: int | None = None,
    ) -> list[RetrievedChunk]:
        raise NotImplementedError


class NullSqlOptRetriever(SqlOptRetriever):
    async def search(
        self,
        query: str,
        *,
        db_type: str,
        top_k: int | None = None,
    ) -> list[RetrievedChunk]:
        return []


class OracleSqlOptRetriever(SqlOptRetriever):
    """主路径：Embedding 存 Oracle JSON，应用侧余弦相似度（与 ai-ops RAG 模式一致）。"""

    def __init__(self, db_config: dict[str, Any]) -> None:
        self._cfg = db_config

    def _fetch_rows(self) -> list[dict[str, Any]]:
        conn, db_type = get_connection(self._cfg)
        if db_type != "oracle":
            return []
        rows: list[dict[str, Any]] = []
        cursor = conn.cursor()
        try:
            cursor.execute(
                """
                SELECT c.CHUNK_ID, c.CHUNK_TEXT, c.EMBEDDING, c.DB_TYPE
                FROM SQL_OPT_KB_CHUNK c
                JOIN SQL_OPT_KB_DOC d ON c.DOC_ID = d.DOC_ID
                WHERE d.ENABLED = 1 AND c.EMBEDDING IS NOT NULL
                """
            )
            for r in cursor.fetchall():
                rows.append(
                    {
                        "chunk_id": r[0],
                        "chunk_text": _read_clob(r[1]),
                        "embedding": _read_clob(r[2]),
                        "db_type": r[3],
                    }
                )
        except Exception:
            rows = []
        finally:
            cursor.close()
            conn.close()
        return rows

    def _match_dialect(self, user_db: str, chunk_db: str | None) -> bool:
        if chunk_db is None or str(chunk_db).strip().upper() in ("", "ALL"):
            return True
        u = _norm_sql_opt_dialect(user_db)
        c = str(chunk_db).strip().upper()
        return c == "ALL" or c == u

    async def search(
        self,
        query: str,
        *,
        db_type: str,
        top_k: int | None = None,
    ) -> list[RetrievedChunk]:
        k = top_k if top_k is not None else _top_k()
        qvec = await get_embedding(query)
        rows = await asyncio.to_thread(self._fetch_rows)
        scored: list[tuple[float, dict[str, Any]]] = []
        for row in rows:
            if not self._match_dialect(db_type, row.get("db_type")):
                continue
            raw = row.get("embedding")
            if not raw:
                continue
            try:
                emb = json.loads(raw) if isinstance(raw, str) else raw
            except (json.JSONDecodeError, TypeError):
                continue
            if not isinstance(emb, list):
                continue
            sim = cosine_similarity(qvec, [float(x) for x in emb])
            scored.append(
                (
                    sim,
                    {
                        "chunk_id": row.get("chunk_id"),
                        "text": (row.get("chunk_text") or "")[:12000],
                        "metadata": {"source": "oracle:SQL_OPT_KB_CHUNK"},
                    },
                )
            )
        scored.sort(key=lambda x: x[0], reverse=True)
        out: list[RetrievedChunk] = []
        for sim, meta in scored[:k]:
            out.append(
                RetrievedChunk(
                    chunk_id=meta.get("chunk_id"),
                    text=meta["text"],
                    score=sim,
                    metadata=meta.get("metadata", {}),
                )
            )
        return out


class MilvusSqlOptRetriever(SqlOptRetriever):
    """备选：Milvus 独立向量库（预留）。接入 pymilvus 后实现 search，并配置 MILVUS_URI 等。"""

    async def search(
        self,
        query: str,
        *,
        db_type: str,
        top_k: int | None = None,
    ) -> list[RetrievedChunk]:
        return []


class PgVectorSqlOptRetriever(SqlOptRetriever):
    """备选：PostgreSQL + pgvector（预留）。接入后实现 search，并配置 PGVECTOR_DSN。"""

    async def search(
        self,
        query: str,
        *,
        db_type: str,
        top_k: int | None = None,
    ) -> list[RetrievedChunk]:
        return []


def _norm_sql_opt_dialect(db_type: str) -> str:
    t = (db_type or "").strip().lower()
    if t in ("pg", "postgresql", "postgres"):
        return "POSTGRESQL"
    if t in ("mysql", "mariadb"):
        return "MYSQL"
    return "ORACLE"


def get_sql_opt_retriever(db_config: dict[str, Any] | None) -> SqlOptRetriever:
    """
    根据 SQL_OPT_VECTOR_BACKEND 与 db_config 构造检索器。
    Oracle 主路径：backend=oracle 且连接为 Oracle 且已配置 host 时使用 SQL_OPT_KB_* 表。
    """
    cfg = db_config or {}
    b = _backend()
    if b == "none":
        return NullSqlOptRetriever()
    if b == "milvus":
        return MilvusSqlOptRetriever()
    if b == "pgvector":
        return PgVectorSqlOptRetriever()
    if b == "oracle":
        if (cfg.get("type") or "").strip().lower() != "oracle":
            return NullSqlOptRetriever()
        if not cfg.get("host"):
            return NullSqlOptRetriever()
        return OracleSqlOptRetriever(cfg)
    return NullSqlOptRetriever()


async def retrieve_sql_opt_context(
    db_config: dict[str, Any] | None,
    sql: str,
    db_type: str,
    user_question: str,
) -> str:
    """执行检索并格式化为可拼入 Prompt 的文本；无结果则返回空串。"""
    retriever = get_sql_opt_retriever(db_config)
    query = f"{_norm_sql_opt_dialect(db_type)}\n{user_question}\n{sql.strip()[:4000]}"
    chunks = await retriever.search(query, db_type=db_type, top_k=_top_k())
    if not chunks:
        return ""
    lines = [
        "**【检索参考（SQL 优化知识库；须与上方执行计划与 Schema 核对，冲突以当前库为准）】**"
    ]
    for i, c in enumerate(chunks, 1):
        sc = f"{c.score:.4f}" if c.score is not None else "n/a"
        lines.append(f"{i}. （相似度≈{sc}）\n{c.text}")
    return "\n\n".join(lines)
