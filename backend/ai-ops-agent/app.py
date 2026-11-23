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
import hmac
import json
import logging
import os
import uuid
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException, UploadFile, File, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.middleware.base import BaseHTTPMiddleware

import db_service as db
import rca_service
import anomaly_service
import cluster_service
import rag_service
import llm_service

llm_errors = (llm_service.LLMError, llm_service.EmbeddingError)

AI_OPS_HOST = os.getenv("AI_OPS_HOST", "127.0.0.1")
# 与 Node 共用 AI_INTERNAL_TOKEN（start-all 自动生成）；兼容旧变量名 AI_OPS_INTERNAL_TOKEN
AI_OPS_INTERNAL_TOKEN = (os.getenv("AI_INTERNAL_TOKEN", "") or os.getenv("AI_OPS_INTERNAL_TOKEN", "")).strip()
log = logging.getLogger("ai-ops")

app = FastAPI(
    title="DIOps AI 智能分析服务",
    description="根因分析 / 异常检测 / 告警聚类 / ChatOps / 知识库 RAG",
    version="1.4.0",
)

# 不再开放 CORS：浏览器只访问平台（Node 代理转发），不直连本服务。
# 原来 allow_origins=["*"] + credentials，配合“本机回环即放行”，任意网页都能让浏览器去调 127.0.0.1:8001 删知识库。
_cors = [o.strip() for o in os.getenv("AI_OPS_CORS_ORIGINS", "").split(",") if o.strip()]
if _cors:
    app.add_middleware(CORSMiddleware, allow_origins=_cors, allow_credentials=False,
                       allow_methods=["GET", "POST", "DELETE"], allow_headers=["Content-Type"])


class InternalAuthMiddleware(BaseHTTPMiddleware):
    """只接受平台（Node）转发的请求：校验内部令牌；未配置令牌时仅允许本机且拒绝一切浏览器请求。"""

    async def dispatch(self, request: Request, call_next):
        if request.url.path == "/health":
            return await call_next(request)

        if AI_OPS_INTERNAL_TOKEN:
            token = request.headers.get("X-DIOps-Internal-Token", "")
            if not hmac.compare_digest(token, AI_OPS_INTERNAL_TOKEN):
                return JSONResponse(
                    status_code=401,
                    content={"code": 401, "msg": "未授权：缺少或无效的内部访问令牌", "data": None},
                )
        else:
            client_host = request.client.host if request.client else ""
            loopback = client_host in ("127.0.0.1", "::1", "localhost")
            # 浏览器发起的请求一定带 Origin 或 Sec-Fetch-Site；Node 代理不带
            from_browser = bool(request.headers.get("origin") or request.headers.get("sec-fetch-site"))
            if not loopback or from_browser:
                return JSONResponse(
                    status_code=403,
                    content={"code": 403, "msg": "禁止直连 AI 服务，请通过平台访问（并配置 AI_INTERNAL_TOKEN）", "data": None},
                )

        return await call_next(request)


app.add_middleware(InternalAuthMiddleware)

if not AI_OPS_INTERNAL_TOKEN:
    log.warning("未配置 AI_INTERNAL_TOKEN：AI 服务只接受本机非浏览器请求。生产环境请配置（start-all 会自动生成）")


def _user(x_diops_user: Optional[str]) -> str:
    """当前用户：由平台在转发时设置 X-DIOps-User（客户端自带的同名头会被平台去掉）"""
    return (x_diops_user or "").strip()


@app.on_event("shutdown")
async def _shutdown():
    await asyncio.to_thread(db.close_pool)


@app.on_event("startup")
async def _startup_check():
    await asyncio.to_thread(db._require_oracle_config)


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


def _err(msg: str, code: int = 500, data=None):
    """错误返回真实 HTTP 状态码（原来一律 HTTP 200）"""
    status = code if 400 <= code < 600 else 500
    return JSONResponse(status_code=status, content={"code": code, "msg": msg, "data": data})


def _fail(e: Exception, what: str = "操作"):
    """未预期异常：详细信息只写日志，不把原始异常文本（含 ORA 错误、连接串等）返回给前端"""
    if isinstance(e, PermissionError):
        return _err(str(e), 403)
    if isinstance(e, (ValueError, KeyError)):
        return _err(f"{what}失败：参数错误 {e}", 400)
    if isinstance(e, (llm_errors)):
        return _err(f"{what}失败：{e}", 502)
    ref = uuid.uuid4().hex[:8]
    log.exception("[%s] %s失败", ref, what)
    return _err(f"{what}失败（错误编号 {ref}，详见 AI 服务日志）", 500)


# ─── 健康检查 ───────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "service": "DIOps AI Ops Agent", "version": "1.4.0"}


# ─── RCA 根因分析 ────────────────────────────────────────────────

@app.post("/ai/rca")
async def trigger_rca(req: RcaRequest, x_diops_user: Optional[str] = Header(None, alias="X-DIOps-User")):
    """触发根因分析，同步执行（可改为异步任务队列）"""
    try:
        rca_id = await rca_service.run_rca(
            alert_id=req.alert_id,
            instance_id=req.instance_id,
            alert_content=req.alert_content,
            created_by=_user(x_diops_user) or req.created_by,
        )
        return _ok({"rca_id": rca_id}, "RCA分析完成")
    except rca_service.RcaFailed as e:
        return _err(str(e), 502, {"rca_id": e.rca_id, "status": "FAILED"})
    except Exception as e:
        return _fail(e, "RCA分析")


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
        return _fail(e)


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
        return _fail(e)


# ─── 异常检测 ────────────────────────────────────────────────────

@app.post("/ai/anomaly/detect")
async def detect_anomaly(req: AnomalyDetectRequest):
    """对指定实例触发异常检测"""
    try:
        ids = await anomaly_service.detect_and_save(req.instance_id, req.lookback_minutes)
        return _ok({"detected_count": len(ids), "anomaly_ids": ids})
    except Exception as e:
        return _fail(e)


@app.get("/ai/anomaly")
async def list_anomalies(instance_id: Optional[int] = None, limit: int = 50):
    """查询异常记录"""
    try:
        rows = await anomaly_service.get_anomalies(instance_id, limit)
        return _ok(rows)
    except Exception as e:
        return _fail(e)


# ─── 告警聚类降噪 ─────────────────────────────────────────────────

@app.post("/ai/cluster")
async def cluster_alerts(req: ClusterRequest):
    """触发告警聚类"""
    try:
        ids = await cluster_service.cluster_open_alerts(req.similarity_threshold)
        return _ok({"cluster_count": len(ids), "cluster_ids": ids}, "聚类完成")
    except Exception as e:
        return _fail(e)


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
        return _fail(e)


# ─── ChatOps 智能问答 ─────────────────────────────────────────────

# 须在 /ai/chat/{session_id} 之前注册，避免 "sessions" 被当成 session_id
@app.get("/ai/chat/sessions")
async def list_chat_sessions_api(
    limit: int = 30,
    x_diops_user: Optional[str] = Header(None, alias="X-DIOps-User"),
):
    """ChatOps 会话列表（左侧历史），仅当前登录用户"""
    try:
        user = _user(x_diops_user)
        if not user:
            return _err("缺少用户信息", 401)
        rows = await rag_service.list_chat_sessions(limit, user)
        return _ok(rows)
    except Exception as e:
        return _fail(e)


@app.post("/ai/chat")
async def chat(
    req: ChatRequest,
    x_diops_user: Optional[str] = Header(None, alias="X-DIOps-User"),
):
    """自然语言问答（RAG + LLM）；created_by 优先与 GET 会话列表一致（请求头 X-DIOps-User）。"""
    session_id = req.session_id or str(uuid.uuid4())
    created_by = _user(x_diops_user)
    if not created_by:
        return _err("缺少用户信息", 401)
    try:
        result = await rag_service.chat_with_rag(
            session_id=session_id,
            question=req.question,
            instance_id=req.instance_id,
            created_by=created_by,
        )
        return _ok(result)
    except Exception as e:
        return _fail(e)


@app.get("/ai/chat/{session_id}")
async def get_chat_history(
    session_id: str,
    limit: int = 20,
    x_diops_user: Optional[str] = Header(None, alias="X-DIOps-User"),
):
    """获取对话历史（仅当前用户自己的会话）"""
    try:
        user = _user(x_diops_user)
        if not user:
            return _err("缺少用户信息", 401)
        rows = await rag_service.get_chat_history(session_id, limit, user)
        return _ok(list(reversed(rows)))  # 正序返回
    except PermissionError as e:
        return _err(str(e), 403)
    except Exception as e:
        return _fail(e)


# ─── 知识库管理 ──────────────────────────────────────────────────

@app.get("/ai/knowledge")
async def list_knowledge(doc_type: Optional[str] = None):
    """知识库文档列表"""
    try:
        rows = await rag_service.list_documents(doc_type)
        return _ok(rows)
    except Exception as e:
        return _fail(e)


@app.post("/ai/knowledge")
async def add_knowledge(req: KnowledgeAddRequest, x_diops_user: Optional[str] = Header(None, alias="X-DIOps-User")):
    """新增知识文档（文本方式）"""
    try:
        doc_id = await rag_service.add_document(
            title=req.title,
            content=req.content,
            doc_type=req.doc_type,
            tags=req.tags,
            source=req.source,
            created_by=_user(x_diops_user) or "system",
        )
        return _ok({"doc_id": doc_id}, "知识文档添加成功，已完成向量化索引")
    except Exception as e:
        return _fail(e)


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
    x_diops_user: Optional[str] = Header(None, alias="X-DIOps-User"),
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
            created_by=_user(x_diops_user) or "system",
        )
        return _ok({"doc_id": doc_id, "filename": title, "size": len(content)}, "文件上传并索引成功")
    except Exception as e:
        return _fail(e, "上传")


@app.delete("/ai/knowledge/{doc_id}")
async def delete_knowledge(doc_id: int):
    """删除知识文档及其向量块"""
    try:
        await rag_service.delete_document(doc_id)
        return _ok(msg="删除成功")
    except Exception as e:
        return _fail(e)


@app.post("/ai/knowledge/{doc_id}/reindex")
async def reindex_knowledge(doc_id: int):
    """重新向量化指定文档（内容更新后使用）"""
    try:
        await rag_service.reindex_document(doc_id)
        return _ok(msg="重建索引完成")
    except Exception as e:
        return _fail(e)


@app.get("/ai/knowledge/search")
async def search_knowledge(q: str, top_k: int = 5):
    """知识库语义检索（调试用）"""
    try:
        results = await rag_service.search_knowledge(q, top_k)
        return _ok(results)
    except Exception as e:
        return _fail(e)


# ─── 启动 ────────────────────────────────────────────────────────

if __name__ == "__main__":
    port = int(os.getenv("AI_OPS_PORT", "8001"))
    host = os.getenv("AI_OPS_HOST", "127.0.0.1")
    uvicorn.run("app:app", host=host, port=port, reload=False)
