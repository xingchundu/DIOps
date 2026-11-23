"""
SQL 优化 Agent - 后端服务
支持 Oracle / PostgreSQL / MySQL + Ollama 本地 LLM
"""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, HTMLResponse, JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
import uvicorn
import asyncio
import hmac
import json
import logging
import time
import uuid
import os
from collections import OrderedDict
from pathlib import Path

# 读取 backend/.env（与 Node 共用 AI_INTERNAL_TOKEN、LLM 配置等）；已有环境变量优先
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=False)
    load_dotenv(Path(__file__).resolve().parent / ".env", override=False)
except ImportError:
    pass

log = logging.getLogger("sql-optimizer")
INTERNAL_TOKEN = (os.getenv("AI_INTERNAL_TOKEN", "") or os.getenv("SQL_OPT_INTERNAL_TOKEN", "")).strip()

app = FastAPI(title="SQL Optimizer Agent", version="1.0.0")

# 不再开放 CORS（原来 allow_origins=["*"] 且全服务无鉴权）：页面通过平台 /api/sql-agent 代理访问。


class InternalAuthMiddleware(BaseHTTPMiddleware):
    """只接受平台 Node 代理转发的请求（校验内部令牌）；未配置令牌时只允许本机非浏览器请求。"""

    async def dispatch(self, request: Request, call_next):
        if request.url.path in ("/api/health",):
            return await call_next(request)
        if INTERNAL_TOKEN:
            if not hmac.compare_digest(request.headers.get("X-DIOps-Internal-Token", ""), INTERNAL_TOKEN):
                return JSONResponse(status_code=401, content={"ok": False, "error": "未授权：请通过平台访问 SQL 优化服务"})
        else:
            host = request.client.host if request.client else ""
            from_browser = bool(request.headers.get("origin") or request.headers.get("sec-fetch-site"))
            if host not in ("127.0.0.1", "::1", "localhost") or from_browser:
                return JSONResponse(status_code=403, content={"ok": False, "error": "禁止直连 SQL 优化服务，请通过平台访问"})
        return await call_next(request)


app.add_middleware(InternalAuthMiddleware)
if not INTERNAL_TOKEN:
    log.warning("未配置 AI_INTERNAL_TOKEN：SQL 优化服务只接受本机非浏览器请求")


# ── 会话：按用户隔离、有上限（原来全局 dict 无限增长、任何人拿到 session_id 就能读写别人的对话） ──
MAX_SESSIONS = int(os.getenv("SQL_OPT_MAX_SESSIONS", "500"))
MAX_TURNS = int(os.getenv("SQL_OPT_MAX_TURNS", "20"))          # 每个会话保留的最近对话轮数
SESSION_TTL = int(os.getenv("SQL_OPT_SESSION_TTL_SEC", "7200"))
sessions: "OrderedDict[str, dict]" = OrderedDict()


def _user_of(request: Request) -> str:
    return (request.headers.get("X-DIOps-User") or "anonymous").strip() or "anonymous"


def _session_history(request: Request, session_id: str | None, create: bool = True) -> tuple[str, list]:
    """返回 (session_id, 历史消息列表，不含 system)。键 = 用户 + session_id。"""
    now = time.time()
    for k in [k for k, v in sessions.items() if now - v["at"] > SESSION_TTL]:
        sessions.pop(k, None)
    sid = session_id or str(uuid.uuid4())
    key = f"{_user_of(request)}|{sid}"
    ent = sessions.get(key)
    if ent is None:
        if not create:
            return sid, []
        ent = {"at": now, "history": []}
        sessions[key] = ent
        while len(sessions) > MAX_SESSIONS:
            sessions.popitem(last=False)
    ent["at"] = now
    sessions.move_to_end(key)
    return sid, ent["history"]


def _append(history: list, role: str, content: str) -> None:
    history.append({"role": role, "content": content})
    del history[: max(0, len(history) - MAX_TURNS * 2)]


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
    return await asyncio.to_thread(test_db_connection, data)


# ── API: 获取表结构 ───────────────────────────────────────
@app.post("/api/schema")
async def get_schema(request: Request):
    data = await request.json()
    from db_service import get_table_schema
    return await asyncio.to_thread(get_table_schema, data["config"], data["sql"])


# ── API: 执行 EXPLAIN ─────────────────────────────────────
@app.post("/api/explain")
async def explain_sql(request: Request):
    data = await request.json()
    from db_service import run_explain
    return await asyncio.to_thread(run_explain, data["config"], data["sql"])


# ── API: 预检（语法/方言/语句类型，不连库不调模型） ─────────
@app.post("/api/precheck")
async def precheck_sql(request: Request):
    data = await request.json()
    from sql_precheck import precheck
    db_type = (data.get("config") or {}).get("type") or data.get("dbType") or "Oracle"
    return {"code": 200, "data": precheck(data.get("sql") or "", db_type)}


# ── API: 开始优化（SSE 流式） ─────────────────────────────
@app.post("/api/optimize")
async def optimize_sql(request: Request):
    data = await request.json()
    db_config = data.get("config", {})
    sql = (data.get("sql") or "").strip()
    if not sql:
        return StreamingResponse(
            iter([f"data: {json.dumps({'error': 'sql 参数不能为空'})}\n\n"]),
            media_type="text/event-stream",
        )
    user_question = data.get("question", "请优化这条 SQL，给出详细建议")
    llm_config = data.get("llm_config")
    # mode: rule=只用规则；ai=规则+大模型（模型不可用则报错）；auto(默认)=模型可用用 ai，否则自动退回 rule
    mode = str(data.get("mode") or "auto").lower()
    if mode not in ("rule", "ai", "auto"):
        mode = "auto"

    from db_service import get_table_schema, run_explain
    from llm_service import stream_chat
    from prompt_builder import build_optimize_prompt, SYSTEM_PROMPT
    from sql_opt_retriever import retrieve_sql_opt_context
    from sql_rule_client import analyze_sql as rule_analyze_sql
    from explain_analyzer import analyze_explain

    db_type = db_config.get("type", "Oracle")

    # 0) 预检：先判断这条语句按所选数据库类型是否正确；有阻断错误则不再往下（不调模型、不浪费一次优化）
    from sql_precheck import precheck as _precheck
    pre = _precheck(sql, db_type)
    if not pre["ok"] and not data.get("skipPrecheck"):
        err_payload = {"error": "SQL 预检未通过：" + "；".join(pre["errors"]), "precheck": pre, "done": True}
        return StreamingResponse(iter([f"data: {json.dumps(err_payload, ensure_ascii=False)}\n\n"]), media_type="text/event-stream")
    sql = pre["sql"] or sql  # 多语句时只取第 1 条

    # 自动拉取 Schema 和执行计划（同步驱动调用放到线程池，原来直接在 async 函数里调用会阻塞整个事件循环）
    schema_info = await asyncio.to_thread(get_table_schema, db_config, sql) if db_config.get("host") else {"schema": ""}
    explain_info = await asyncio.to_thread(run_explain, db_config, sql) if db_config.get("host") else {"result": ""}

    # 规则引擎分析
    from rule_report import run_rules, build_markdown, probe_llm
    rule_result = await asyncio.to_thread(
        run_rules, sql, db_type,
        schema=schema_info.get("schema", ""),
        explain=explain_info.get("result", ""),
        authorization=request.headers.get("authorization"),
        instance_id=data.get("instanceId"),
    )

    # 决定是否使用大模型
    llm_state = None
    if mode == "rule":
        use_llm = False
    else:
        llm_state = await probe_llm(llm_config)
        use_llm = bool(llm_state.get("ok"))
        if not use_llm and mode == "ai":
            err_payload = {"error": f"大模型不可用：{llm_state.get('error', '未知原因')}（可将模式改为“规则优化”）", "precheck": pre, "rule_engine": rule_result, "done": True}
            return StreamingResponse(iter([f"data: {json.dumps(err_payload, ensure_ascii=False)}\n\n"]), media_type="text/event-stream")
    effective_mode = "ai" if use_llm else "rule"

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
    if rule_result.get("rewrittenSql"):
        rule_text += "\n\n规则引擎的等价改写（已通过语法校验；请在此基础上继续优化，不要推翻规则结论）：\n" + rule_result["rewrittenSql"]

    if not use_llm:
        report_md = build_markdown(sql, db_type, rule_result, pre, explain_info.get("result", ""))
        fallback_note = ("（大模型不可用，已自动使用规则优化）\n\n" if mode == "auto" else "")

        async def rule_stream():
            full = fallback_note + report_md
            step = 400
            for i in range(0, len(full), step):
                yield f"data: {json.dumps({'text': full[i:i + step]}, ensure_ascii=False)}\n\n"
            payload = {"done": True, "mode": "rule", "precheck": pre, "rule_engine": rule_result}
            if explain_analysis.get("operations"):
                payload["explain_analysis"] = explain_analysis
            if rule_result.get("rewrittenSql"):
                payload["rule_rewritten_sql"] = rule_result["rewrittenSql"]
            if llm_state and not llm_state.get("ok"):
                payload["llm_error"] = llm_state.get("error")
            opt_id = await _save_opt_record(
                sql, rule_result.get("rewrittenSql") or "", db_config, rule_result,
                explain_info, explain_analysis, None, request.headers.get("authorization"),
                opt_mode="rule", precheck=pre, instance_id=data.get("instanceId"),
            )
            if opt_id:
                payload["opt_id"] = opt_id
            yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

        return StreamingResponse(rule_stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    prompt = build_optimize_prompt(
        sql=sql,
        schema=schema_info.get("schema", ""),
        explain=explain_info.get("result", ""),
        db_type=db_type,
        user_question=user_question,
        rag_context=rag_context if rag_context else None,
        rule_context=rule_text or None,
    )

    # 初始化或复用会话（system 消息每次请求单独拼，不写进共享历史）
    session_id, history = _session_history(request, data.get("session_id"))
    _append(history, "user", prompt)
    messages = [{"role": "system", "content": SYSTEM_PROMPT}] + list(history)
    auth_header = request.headers.get("authorization")

    async def event_stream():
        full_reply = ""
        try:
            async for chunk in stream_chat(messages, llm_config=llm_config):
                full_reply += chunk
                yield f"data: {json.dumps({'text': chunk, 'session_id': session_id})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        finally:
            payload = {"done": True, "session_id": session_id, "mode": "ai", "precheck": pre}
            if rule_result.get("rules"):
                payload["rule_engine"] = rule_result
            if explain_analysis.get("operations"):
                payload["explain_analysis"] = explain_analysis
            if full_reply:
                _append(history, "assistant", full_reply)
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
                explain_info, explain_analysis, llm_config, auth_header,
                opt_mode="ai", precheck=pre, instance_id=data.get("instanceId"),
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
    authorization: str | None = None,
    opt_mode: str | None = None,
    precheck: dict | None = None,
    instance_id: int | None = None,
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
        "optMode": opt_mode,
        "precheck": precheck,
        "instanceId": instance_id,
    }
    # 不把数据库口令带进保存记录
    payload["dbType"] = (db_config or {}).get("type", "")
    try:
        async with _httpx.AsyncClient(timeout=10.0) as client:
            # 带上当前用户的令牌（平台 /api/sql-opt 需要登录；原来不带，保存恒失败）
            headers = {"Authorization": authorization} if authorization else {}
            resp = await client.post(f"{node_base}/api/sql-opt/save", json=payload, headers=headers)
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
    from sql_rule_client import analyze_sql as rule_analyze_sql

    db_config = data.get("config") or {}
    db_type = db_config.get("type", "Oracle")
    llm_config = data.get("llm_config")

    use_opt = should_use_sql_optimizer_system(message)
    sys_content = SYSTEM_PROMPT if use_opt else SYSTEM_PROMPT_CHAT_GENERAL

    # 对 SQL 语句运行规则引擎
    chat_rule_result = None
    if use_opt and is_likely_sql_statement(message):
        try:
            chat_rule_result = await asyncio.to_thread(rule_analyze_sql, message.strip(), db_type,
                                                       authorization=request.headers.get("authorization"))
        except Exception:
            chat_rule_result = None

    # system 消息按本次请求选择，不再覆写共享会话的第一条（原来并发请求会互相覆盖）
    session_id, history = _session_history(request, session_id)

    user_content = message
    if use_opt and is_likely_sql_statement(message):
        user_content = (
            message.strip()
            + "\n\n【约束】请严格基于上述 SQL 字面；**禁止**声称原 SQL 为 `FROM DUAL`；**禁止**将 `SELECT *` 默认改为 `SELECT 1`；引用原句须与用户输入一致。"
        )

    _append(history, "user", user_content)
    messages = [{"role": "system", "content": sys_content}] + list(history)

    async def event_stream():
        full_reply = ""
        try:
            async for chunk in stream_chat(messages, llm_config=llm_config):
                full_reply += chunk
                yield f"data: {json.dumps({'text': chunk, 'session_id': session_id})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        finally:
            payload = {"done": True, "session_id": session_id}
            if chat_rule_result and chat_rule_result.get("rules"):
                payload["rule_engine"] = chat_rule_result
            if full_reply:
                _append(history, "assistant", full_reply)
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
async def clear_session(session_id: str, request: Request):
    sessions.pop(f"{_user_of(request)}|{session_id}", None)
    return {"ok": True}


# ── API: 获取 Ollama 可用模型 ─────────────────────────────
@app.get("/api/models")
async def get_models(provider: str = None, base_url: str = None):
    from llm_service import list_models
    llm_config = {"provider": provider, "base_url": base_url} if base_url else None
    return await list_models(provider=provider, llm_config=llm_config)


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
    uvicorn.run(
        app,
        host=os.getenv("SQL_OPT_HOST", "127.0.0.1"),  # 只经 Node /api/sql-agent 代理访问（带登录与授权校验）
        port=int(os.getenv("SQL_OPT_PORT", "8000")),
        reload=False,
    )
