"""
SQL 优化 Agent - 后端服务
支持 Oracle / PostgreSQL / MySQL + Ollama 本地 LLM
"""

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import json
import uuid
import os
from pathlib import Path

app = FastAPI(title="SQL Optimizer Agent", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# 内存会话存储  {session_id: [messages]}
sessions: dict = {}


def _frontend_index_path() -> Path:
    """DIOps 仓库内页面：frontend/public/sql-optimizer/index.html"""
    repo_root = Path(__file__).resolve().parent.parent.parent
    return repo_root / "frontend" / "public" / "sql-optimizer" / "index.html"


# ── 静态文件 ──────────────────────────────────────────────
@app.get("/")
async def root():
    html_path = _frontend_index_path()
    return HTMLResponse(html_path.read_text(encoding="utf-8"))


# ── API: 测试数据库连接 ────────────────────────────────────
@app.post("/api/connect")
async def test_connection(request: Request):
    data = await request.json()
    from db_service import test_db_connection
    return test_db_connection(data)


# ── API: 获取表结构 ───────────────────────────────────────
@app.post("/api/schema")
async def get_schema(request: Request):
    data = await request.json()
    from db_service import get_table_schema
    return get_table_schema(data["config"], data["sql"])


# ── API: 执行 EXPLAIN ─────────────────────────────────────
@app.post("/api/explain")
async def explain_sql(request: Request):
    data = await request.json()
    from db_service import run_explain
    return run_explain(data["config"], data["sql"])


# ── API: 开始优化（SSE 流式） ─────────────────────────────
@app.post("/api/optimize")
async def optimize_sql(request: Request):
    data = await request.json()
    session_id = data.get("session_id") or str(uuid.uuid4())
    db_config = data.get("config", {})
    sql = (data.get("sql") or "").strip()
    if not sql:
        return StreamingResponse(
            iter([f"data: {json.dumps({'error': 'sql 参数不能为空'})}\n\n"]),
            media_type="text/event-stream",
        )
    user_question = data.get("question", "请优化这条 SQL，给出详细建议")
    llm_config = data.get("llm_config")

    from db_service import get_table_schema, run_explain
    from llm_service import stream_chat
    from prompt_builder import build_optimize_prompt, SYSTEM_PROMPT
    from sql_opt_retriever import retrieve_sql_opt_context
    from sql_rule_engine import analyze_sql as rule_analyze_sql
    from explain_analyzer import analyze_explain

    db_type = db_config.get("type", "Oracle")

    # 自动拉取 Schema 和执行计划
    schema_info = get_table_schema(db_config, sql) if db_config.get("host") else {"schema": ""}
    explain_info = run_explain(db_config, sql) if db_config.get("host") else {"result": ""}

    # 规则引擎分析
    rule_result = rule_analyze_sql(
        sql, db_type,
        schema=schema_info.get("schema", ""),
        explain_result=explain_info.get("result", ""),
    )

    # EXPLAIN 深度分析
    explain_analysis = {}
    if explain_info.get("ok") and explain_info.get("result"):
        try:
            explain_analysis = analyze_explain(explain_info["result"], db_type)
        except Exception:
            explain_analysis = {}

    rag_context = ""
    if db_config.get("host"):
        try:
            rag_context = await retrieve_sql_opt_context(
                db_config, sql, db_type, user_question
            )
        except Exception:
            rag_context = ""

    # 格式化规则引擎结果注入 prompt
    rule_text = ""
    if rule_result.get("rules"):
        rule_text = "\n".join(
            f"- [{r['severity'].upper()}] {r['title']}: {r['detail']} → {r['suggestion']}"
            for r in rule_result["rules"]
        )

    prompt = build_optimize_prompt(
        sql=sql,
        schema=schema_info.get("schema", ""),
        explain=explain_info.get("result", ""),
        db_type=db_type,
        user_question=user_question,
        rag_context=rag_context if rag_context else None,
        rule_context=rule_text or None,
    )

    # 初始化或复用会话
    if session_id not in sessions:
        sessions[session_id] = [{"role": "system", "content": SYSTEM_PROMPT}]

    sessions[session_id].append({"role": "user", "content": prompt})

    async def event_stream():
        full_reply = ""
        try:
            async for chunk in stream_chat(sessions[session_id], llm_config=llm_config):
                full_reply += chunk
                yield f"data: {json.dumps({'text': chunk, 'session_id': session_id})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        finally:
            payload = {"done": True, "session_id": session_id}
            if rule_result.get("rules"):
                payload["rule_engine"] = rule_result
            if explain_analysis.get("operations"):
                payload["explain_analysis"] = explain_analysis
            if full_reply:
                sessions[session_id].append({"role": "assistant", "content": full_reply})
                try:
                    from sql_validator import extract_sql_blocks, validate_sql

                    blocks = extract_sql_blocks(full_reply)
                    if blocks:
                        db_t = db_config.get("type", "Oracle")
                        payload["validation"] = [
                            validate_sql(b, db_t, original_sql=sql) for b in blocks
                        ]
                except Exception as e:
                    payload["validation_error"] = str(e)
            # 保存优化记录到 Node.js 后端
            opt_id = await _save_opt_record(
                sql, full_reply, db_config, rule_result,
                explain_info, explain_analysis, llm_config,
            )
            if opt_id:
                payload["opt_id"] = opt_id
            yield f"data: {json.dumps(payload)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


import hashlib
import httpx as _httpx


async def _save_opt_record(
    sql_text: str, optimized_sql: str, db_config: dict,
    rule_result: dict, explain_info: dict, explain_analysis: dict,
    llm_config: dict | None,
) -> int | None:
    """保存优化记录到 Node.js 后端，返回 opt_id。"""
    node_base = os.getenv("NODE_BACKEND_URL", "http://127.0.0.1:3000")
    sql_hash = hashlib.md5((sql_text or "").encode()).hexdigest()
    provider = (llm_config or {}).get("provider", "ollama")
    model = (llm_config or {}).get("model", "")
    payload = {
        "sqlHash": sql_hash,
        "sqlText": sql_text,
        "dbType": db_config.get("type", ""),
        "optimizedSql": optimized_sql,
        "ruleEngine": rule_result,
        "explainBefore": explain_info.get("result", ""),
        "explainAfter": json.dumps(explain_analysis) if explain_analysis else None,
        "llmProvider": provider,
        "llmModel": model,
    }
    try:
        async with _httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(f"{node_base}/api/sql-opt/save", json=payload)
            if resp.status_code == 200:
                data = resp.json()
                if data.get("code") == 200:
                    return data.get("data", {}).get("optId")
    except Exception:
        pass
    return None


# ── API: 多轮追问（SSE 流式） ─────────────────────────────
@app.post("/api/chat")
async def chat(request: Request):
    data = await request.json()
    session_id = data.get("session_id")
    message = data.get("message", "")

    from llm_service import stream_chat
    from prompt_builder import (
        SYSTEM_PROMPT,
        SYSTEM_PROMPT_CHAT_GENERAL,
        is_likely_sql_statement,
        should_use_sql_optimizer_system,
    )
    from sql_rule_engine import analyze_sql as rule_analyze_sql

    db_config = data.get("config") or {}
    db_type = db_config.get("type", "Oracle")
    llm_config = data.get("llm_config")

    use_opt = should_use_sql_optimizer_system(message)
    sys_content = SYSTEM_PROMPT if use_opt else SYSTEM_PROMPT_CHAT_GENERAL

    # 对 SQL 语句运行规则引擎
    chat_rule_result = None
    if use_opt and is_likely_sql_statement(message):
        try:
            chat_rule_result = rule_analyze_sql(message.strip(), db_type)
        except Exception:
            chat_rule_result = None

    if not session_id or session_id not in sessions:
        session_id = str(uuid.uuid4())
        sessions[session_id] = [{"role": "system", "content": sys_content}]
    else:
        sessions[session_id][0] = {"role": "system", "content": sys_content}

    user_content = message
    if use_opt and is_likely_sql_statement(message):
        user_content = (
            message.strip()
            + "\n\n【约束】请严格基于上述 SQL 字面；**禁止**声称原 SQL 为 `FROM DUAL`；**禁止**将 `SELECT *` 默认改为 `SELECT 1`；引用原句须与用户输入一致。"
        )

    sessions[session_id].append({"role": "user", "content": user_content})

    async def event_stream():
        full_reply = ""
        try:
            async for chunk in stream_chat(sessions[session_id], llm_config=llm_config):
                full_reply += chunk
                yield f"data: {json.dumps({'text': chunk})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        finally:
            payload = {"done": True}
            if chat_rule_result and chat_rule_result.get("rules"):
                payload["rule_engine"] = chat_rule_result
            if full_reply:
                sessions[session_id].append({"role": "assistant", "content": full_reply})
                try:
                    from sql_validator import extract_sql_blocks, validate_sql

                    blocks = extract_sql_blocks(full_reply)
                    if blocks:
                        payload["validation"] = [
                            validate_sql(b, db_type, original_sql=None) for b in blocks
                        ]
                except Exception as e:
                    payload["validation_error"] = str(e)
            yield f"data: {json.dumps(payload)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── API: 清空会话 ─────────────────────────────────────────
@app.delete("/api/session/{session_id}")
async def clear_session(session_id: str):
    sessions.pop(session_id, None)
    return {"ok": True}


# ── API: 获取 Ollama 可用模型 ─────────────────────────────
@app.get("/api/models")
async def get_models(provider: str = None):
    from llm_service import list_models
    return await list_models(provider=provider)


# ── API: 测试 LLM 连接 ───────────────────────────────────
@app.post("/api/llm/test")
async def test_llm(request: Request):
    data = await request.json()
    from llm_service import test_llm_connection
    return await test_llm_connection(llm_config=data)


# ── API: 健康检查 ─────────────────────────────────────────
@app.get("/api/health")
async def health():
    return {"status": "ok", "sessions": len(sessions)}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=False)
