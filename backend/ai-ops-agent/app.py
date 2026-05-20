"""
DIOps AI 智能分析微服务
端口: 8001
功能:
  - POST /ai/rca          根因分析（RCA）
  - GET  /ai/rca/{id}     查询RCA结果
  - GET  /ai/rca/list     RCA结果列表
  - POST /ai/anomaly/detect   触发异常检测
  - GET  /ai/anomaly      查询异常记录
  - POST /ai/cluster      触发告警聚类
  - GET  /ai/cluster      查询聚类结果
  - POST /ai/chat         ChatOps 问答
  - GET  /ai/chat/{session_id}  对话历史
  - GET  /ai/knowledge    知识库列表
  - POST /ai/knowledge    新增知识（文本）
  - POST /ai/knowledge/upload  上传文件
  - DELETE /ai/knowledge/{id}  删除
  - POST /ai/knowledge/{id}/reindex  重建索引
  - GET  /health          健康检查
"""
import asyncio
import json
import os
import uuid
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException, UploadFile, File, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import db_service as db
import rca_service
import anomaly_service
import cluster_service
import rag_service

app = FastAPI(
    title="DIOps AI 智能分析服务",
    description="根因分析 / 异常检测 / 告警聚类 / ChatOps / 知识库 RAG",
    version="1.4.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── 数据模型 ──────────────────────────────────────────────────

class RcaRequest(BaseModel):
    alert_id: int
    instance_id: int
    alert_content: str
    created_by: Optional[str] = "system"


class AnomalyDetectRequest(BaseModel):
    instance_id: int
    lookback_minutes: Optional[int] = 60


class ClusterRequest(BaseModel):
    similarity_threshold: Optional[float] = 0.75


class ChatRequest(BaseModel):
    question: str
    session_id: Optional[str] = None
    instance_id: Optional[int] = None
    created_by: Optional[str] = "system"


class KnowledgeAddRequest(BaseModel):
    title: str
    content: str
    doc_type: Optional[str] = "EXPERIENCE"
    tags: Optional[str] = ""
    source: Optional[str] = ""
    created_by: Optional[str] = "system"


# ─── 工具 ──────────────────────────────────────────────────────

def _ok(data=None, msg="success"):
    return {"code": 200, "msg": msg, "data": data}


def _err(msg: str, code: int = 500):
    return {"code": code, "msg": msg, "data": None}


# ─── 健康检查 ───────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "service": "DIOps AI Ops Agent", "version": "1.4.0"}


# ─── RCA 根因分析 ────────────────────────────────────────────────

@app.post("/ai/rca")
async def trigger_rca(req: RcaRequest):
    """触发根因分析，同步执行（可改为异步任务队列）"""
    try:
        rca_id = await rca_service.run_rca(
            alert_id=req.alert_id,
            instance_id=req.instance_id,
            alert_content=req.alert_content,
            created_by=req.created_by,
        )
        return _ok({"rca_id": rca_id}, "RCA分析完成")
    except Exception as e:
        return _err(f"RCA分析失败: {e}")


@app.get("/ai/rca/list")
async def list_rca(instance_id: Optional[int] = None, limit: int = 20):
    """查询RCA结果列表"""
    try:
        if instance_id:
            rows = await db.query(
                """SELECT RCA_ID, ALERT_ID, INSTANCE_ID, ROOT_CAUSE, CONFIDENCE,
                          ANALYSIS_TIME, STATUS, CREATED_BY
                   FROM AI_RCA_RESULT WHERE INSTANCE_ID=:1
                   ORDER BY ANALYSIS_TIME DESC FETCH FIRST :2 ROWS ONLY""",
                [instance_id, limit]
            )
        else:
            rows = await db.query(
                """SELECT RCA_ID, ALERT_ID, INSTANCE_ID, ROOT_CAUSE, CONFIDENCE,
                          ANALYSIS_TIME, STATUS, CREATED_BY
                   FROM AI_RCA_RESULT ORDER BY ANALYSIS_TIME DESC FETCH FIRST :1 ROWS ONLY""",
                [limit]
            )
        return _ok(rows)
    except Exception as e:
        return _err(str(e))


@app.get("/ai/rca/{rca_id}")
async def get_rca(rca_id: int):
    """查询单条RCA详情"""
    try:
        row = await db.query_one(
            "SELECT * FROM AI_RCA_RESULT WHERE RCA_ID=:1", [rca_id]
        )
        if not row:
            raise HTTPException(status_code=404, detail="RCA结果不存在")
        # 解析 JSON 字段
        for f in ("PROPAGATION_PATH", "METRICS_SNAPSHOT", "ANOMALY_POINTS"):
            v = row.get(f)
            if v:
                try:
                    row[f] = json.loads(v) if isinstance(v, str) else v
                except Exception:
                    pass
        return _ok(row)
    except HTTPException:
        raise
    except Exception as e:
        return _err(str(e))


# ─── 异常检测 ────────────────────────────────────────────────────

@app.post("/ai/anomaly/detect")
async def detect_anomaly(req: AnomalyDetectRequest):
    """对指定实例触发异常检测"""
    try:
        ids = await anomaly_service.detect_and_save(req.instance_id, req.lookback_minutes)
        return _ok({"detected_count": len(ids), "anomaly_ids": ids})
    except Exception as e:
        return _err(str(e))


@app.get("/ai/anomaly")
async def list_anomalies(instance_id: Optional[int] = None, limit: int = 50):
    """查询异常记录"""
    try:
        rows = await anomaly_service.get_anomalies(instance_id, limit)
        return _ok(rows)
    except Exception as e:
        return _err(str(e))


# ─── 告警聚类降噪 ─────────────────────────────────────────────────

@app.post("/ai/cluster")
async def cluster_alerts(req: ClusterRequest):
    """触发告警聚类"""
    try:
        ids = await cluster_service.cluster_open_alerts(req.similarity_threshold)
        return _ok({"cluster_count": len(ids), "cluster_ids": ids}, "聚类完成")
    except Exception as e:
        return _err(str(e))


@app.get("/ai/cluster")
async def list_clusters(status: str = "ACTIVE", limit: int = 50):
    """查询聚类结果"""
    try:
        rows = await cluster_service.get_clusters(status, limit)
        for row in rows:
            v = row.get("ALERT_IDS")
            if v:
                try:
                    row["ALERT_IDS"] = json.loads(v) if isinstance(v, str) else v
                except Exception:
                    pass
        return _ok(rows)
    except Exception as e:
        return _err(str(e))


# ─── ChatOps 智能问答 ─────────────────────────────────────────────

# 须在 /ai/chat/{session_id} 之前注册，避免 "sessions" 被当成 session_id
@app.get("/ai/chat/sessions")
async def list_chat_sessions_api(
    limit: int = 30,
    x_diops_user: Optional[str] = Header(None, alias="X-DIOps-User"),
):
    """ChatOps 会话列表（左侧历史），仅当前登录用户"""
    try:
        user = (x_diops_user or "").strip()
        if not user:
            return _err("缺少用户信息", 401)
        rows = await rag_service.list_chat_sessions(limit, user)
        return _ok(rows)
    except Exception as e:
        return _err(str(e))


@app.post("/ai/chat")
async def chat(
    req: ChatRequest,
    x_diops_user: Optional[str] = Header(None, alias="X-DIOps-User"),
):
    """自然语言问答（RAG + LLM）；created_by 优先与 GET 会话列表一致（请求头 X-DIOps-User）。"""
    session_id = req.session_id or str(uuid.uuid4())
    created_by = (x_diops_user or req.created_by or "system").strip() or "system"
    try:
        result = await rag_service.chat_with_rag(
            session_id=session_id,
            question=req.question,
            instance_id=req.instance_id,
            created_by=created_by,
        )
        return _ok(result)
    except Exception as e:
        return _err(str(e))


@app.get("/ai/chat/{session_id}")
async def get_chat_history(
    session_id: str,
    limit: int = 20,
    x_diops_user: Optional[str] = Header(None, alias="X-DIOps-User"),
):
    """获取对话历史（仅当前用户自己的会话）"""
    try:
        user = (x_diops_user or "").strip()
        if not user:
            return _err("缺少用户信息", 401)
        rows = await rag_service.get_chat_history(session_id, limit, user)
        return _ok(list(reversed(rows)))  # 正序返回
    except PermissionError as e:
        return _err(str(e), 403)
    except Exception as e:
        return _err(str(e))


# ─── 知识库管理 ──────────────────────────────────────────────────

@app.get("/ai/knowledge")
async def list_knowledge(doc_type: Optional[str] = None):
    """知识库文档列表"""
    try:
        rows = await rag_service.list_documents(doc_type)
        return _ok(rows)
    except Exception as e:
        return _err(str(e))


@app.post("/ai/knowledge")
async def add_knowledge(req: KnowledgeAddRequest):
    """新增知识文档（文本方式）"""
    try:
        doc_id = await rag_service.add_document(
            title=req.title,
            content=req.content,
            doc_type=req.doc_type,
            tags=req.tags,
            source=req.source,
            created_by=req.created_by,
        )
        return _ok({"doc_id": doc_id}, "知识文档添加成功，已完成向量化索引")
    except Exception as e:
        return _err(str(e))


def _extract_file_content(filename: str, raw: bytes) -> str:
    """根据文件扩展名提取文本内容"""
    ext = (filename or "").rsplit(".", 1)[-1].lower() if "." in (filename or "") else ""
    if ext == "pdf":
        from pypdf import PdfReader
        import io
        reader = PdfReader(io.BytesIO(raw))
        pages = [page.extract_text() or "" for page in reader.pages]
        return "\n".join(pages)
    elif ext == "docx":
        from docx import Document
        import io
        doc = Document(io.BytesIO(raw))
        return "\n".join(p.text for p in doc.paragraphs if p.text.strip())
    else:
        return raw.decode("utf-8", errors="replace")


@app.post("/ai/knowledge/upload")
async def upload_knowledge(
    file: UploadFile = File(...),
    doc_type: str = "MANUAL",
    tags: str = "",
    created_by: str = "system",
):
    """上传文件到知识库（支持 txt/md/log/pdf/docx）"""
    try:
        raw = await file.read()
        content = _extract_file_content(file.filename, raw)
        title = file.filename or "uploaded_doc"
        doc_id = await rag_service.add_document(
            title=title,
            content=content,
            doc_type=doc_type,
            tags=tags,
            source=f"upload:{title}",
            created_by=created_by,
        )
        return _ok({"doc_id": doc_id, "filename": title, "size": len(content)}, "文件上传并索引成功")
    except Exception as e:
        return _err(str(e))


@app.delete("/ai/knowledge/{doc_id}")
async def delete_knowledge(doc_id: int):
    """删除知识文档及其向量块"""
    try:
        await rag_service.delete_document(doc_id)
        return _ok(msg="删除成功")
    except Exception as e:
        return _err(str(e))


@app.post("/ai/knowledge/{doc_id}/reindex")
async def reindex_knowledge(doc_id: int):
    """重新向量化指定文档（内容更新后使用）"""
    try:
        await rag_service.reindex_document(doc_id)
        return _ok(msg="重建索引完成")
    except Exception as e:
        return _err(str(e))


@app.get("/ai/knowledge/search")
async def search_knowledge(q: str, top_k: int = 5):
    """知识库语义检索（调试用）"""
    try:
        results = await rag_service.search_knowledge(q, top_k)
        return _ok(results)
    except Exception as e:
        return _err(str(e))


# ─── 启动 ────────────────────────────────────────────────────────

if __name__ == "__main__":
    port = int(os.getenv("AI_OPS_PORT", "8001"))
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=False)
