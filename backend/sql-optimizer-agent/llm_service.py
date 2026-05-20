"""
LLM 服务层 - 支持 Ollama + OpenAI 兼容 API
默认模型: deepseek-r1:1.5b (Ollama)
支持：流式调用、模型列表、嵌入向量
"""

import hashlib
import os
import httpx
import json
from typing import AsyncGenerator, List, Dict

OLLAMA_BASE = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
DEFAULT_MODEL = os.getenv("LLM_MODEL", "deepseek-r1:1.5b")
EMBED_MODEL = os.getenv("OLLAMA_EMBED_MODEL", DEFAULT_MODEL)

# OpenAI 兼容配置
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "http://localhost:11434/v1")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")


def _get_provider_config(provider: str | None, llm_config: dict | None = None) -> tuple[str, str, str]:
    """返回 (provider, base_url, api_key)，前端配置优先于环境变量。"""
    cfg = llm_config or {}
    p = cfg.get("provider") or provider or os.getenv("LLM_PROVIDER", "ollama")
    if p == "openai":
        base = cfg.get("base_url") or OPENAI_BASE_URL
        key = cfg.get("api_key") or OPENAI_API_KEY
    else:
        base = OLLAMA_BASE
        key = ""
    return p, base, key


def _openai_headers(api_key: str) -> dict:
    h = {"Content-Type": "application/json"}
    if api_key:
        h["Authorization"] = f"Bearer {api_key}"
    return h


# ── 流式聊天 ──────────────────────────────────────────────

async def stream_chat(
    messages: List[Dict],
    model: str = DEFAULT_MODEL,
    temperature: float = 0.2,
    num_predict: int = 4096,
    llm_config: dict | None = None,
) -> AsyncGenerator[str, None]:
    """
    流式调用 LLM，自动识别 Ollama / OpenAI 兼容 API。
    llm_config: {"provider": "ollama"|"openai", "base_url": "...", "api_key": "..."}
    """
    provider, base_url, api_key = _get_provider_config(None, llm_config)

    if provider == "openai":
        async for chunk in _stream_openai(base_url, api_key, messages, model, temperature, num_predict):
            yield chunk
    else:
        async for chunk in _stream_ollama(base_url, messages, model, temperature, num_predict):
            yield chunk


async def _stream_ollama(
    base_url: str, messages: List[Dict], model: str,
    temperature: float, num_predict: int,
) -> AsyncGenerator[str, None]:
    """Ollama /api/chat 流式调用。"""
    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
        "options": {
            "temperature": temperature,
            "num_predict": num_predict,
            "top_p": 0.9,
        },
    }
    async with httpx.AsyncClient(timeout=180.0) as client:
        async with client.stream(
            "POST", f"{base_url}/api/chat",
            json=payload, headers={"Content-Type": "application/json"},
        ) as resp:
            if resp.status_code != 200:
                error_body = await resp.aread()
                raise RuntimeError(f"Ollama 返回错误 {resp.status_code}: {error_body.decode()[:200]}")
            async for line in resp.aiter_lines():
                line = line.strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                    content = data.get("message", {}).get("content", "")
                    if content:
                        yield content
                    if data.get("done"):
                        return
                except json.JSONDecodeError:
                    continue


async def _stream_openai(
    base_url: str, api_key: str, messages: List[Dict], model: str,
    temperature: float, max_tokens: int,
) -> AsyncGenerator[str, None]:
    """OpenAI 兼容 /v1/chat/completions SSE 流式调用。"""
    base_url = base_url.rstrip("/")
    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "top_p": 0.9,
    }
    async with httpx.AsyncClient(timeout=180.0) as client:
        async with client.stream(
            "POST", f"{base_url}/chat/completions",
            json=payload, headers=_openai_headers(api_key),
        ) as resp:
            if resp.status_code != 200:
                error_body = await resp.aread()
                raise RuntimeError(f"OpenAI API 返回错误 {resp.status_code}: {error_body.decode()[:200]}")
            async for line in resp.aiter_lines():
                line = line.strip()
                if not line:
                    continue
                if line.startswith("data: "):
                    data_str = line[6:]
                    if data_str == "[DONE]":
                        return
                    try:
                        data = json.loads(data_str)
                        choices = data.get("choices", [])
                        if not choices:
                            continue
                        delta = choices[0].get("delta", {})
                        content = delta.get("content", "")
                        if content:
                            yield content
                    except json.JSONDecodeError:
                        continue


# ── 模型列表 ──────────────────────────────────────────────

async def list_models(provider: str | None = None, llm_config: dict | None = None) -> Dict:
    """获取可用模型列表，支持 Ollama 和 OpenAI 兼容 API。"""
    p, base_url, api_key = _get_provider_config(provider, llm_config)
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            if p == "openai":
                base_url = base_url.rstrip("/")
                resp = await client.get(f"{base_url}/models", headers=_openai_headers(api_key))
                if resp.status_code == 200:
                    data = resp.json()
                    models = list(dict.fromkeys(m["id"] for m in data.get("data", [])))
                    return {"ok": True, "models": models, "provider": "openai"}
                return {"ok": False, "models": [], "error": f"HTTP {resp.status_code}", "provider": "openai"}
            else:
                resp = await client.get(f"{base_url}/api/tags")
                if resp.status_code == 200:
                    data = resp.json()
                    models = [m["name"] for m in data.get("models", [])]
                    return {"ok": True, "models": models, "provider": "ollama"}
                return {"ok": False, "models": [], "error": f"HTTP {resp.status_code}", "provider": "ollama"}
    except Exception as e:
        return {"ok": False, "models": [DEFAULT_MODEL], "error": str(e), "provider": p}


async def list_ollama_models() -> Dict:
    """兼容旧接口。"""
    return await list_models(provider="ollama")


# ── LLM 连接测试 ──────────────────────────────────────────

async def test_llm_connection(llm_config: dict | None = None) -> Dict:
    """测试 LLM 连接是否可用。"""
    p, base_url, api_key = _get_provider_config(None, llm_config)
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            if p == "openai":
                base_url = base_url.rstrip("/")
                resp = await client.get(f"{base_url}/models", headers=_openai_headers(api_key))
                if resp.status_code == 200:
                    data = resp.json()
                    count = len(data.get("data", []))
                    return {"ok": True, "provider": "openai", "base_url": base_url, "model_count": count}
                return {"ok": False, "provider": "openai", "error": f"HTTP {resp.status_code}"}
            else:
                resp = await client.get(f"{base_url}/api/tags")
                if resp.status_code == 200:
                    data = resp.json()
                    count = len(data.get("models", []))
                    return {"ok": True, "provider": "ollama", "base_url": base_url, "model_count": count}
                return {"ok": False, "provider": "ollama", "error": f"HTTP {resp.status_code}"}
    except Exception as e:
        return {"ok": False, "provider": p, "error": str(e)}


# ── 嵌入向量 ──────────────────────────────────────────────

async def get_embedding(text: str) -> List[float]:
    """
    调用嵌入模型；失败则使用轻量哈希向量。
    优先使用 Ollama（嵌入通常在本地），OpenAI 兼容 API 也可用。
    """
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{OLLAMA_BASE}/api/embeddings",
                json={"model": EMBED_MODEL, "prompt": (text or "")[:8000]},
            )
            if resp.status_code == 200:
                data = resp.json()
                if "embedding" in data:
                    return data["embedding"]
    except Exception:
        pass
    return _hash_embedding((text or "")[:2000], dim=64)


def _hash_embedding(text: str, dim: int = 64) -> List[float]:
    vec = [0.0] * dim
    t = text.lower()[:1000]
    for i in range(len(t) - 2):
        ngram = t[i : i + 3]
        h = int(hashlib.md5(ngram.encode()).hexdigest(), 16) % dim
        vec[h] += 1.0
    norm = sum(v ** 2 for v in vec) ** 0.5 or 1.0
    return [v / norm for v in vec]


def cosine_similarity(a: List[float], b: List[float]) -> float:
    if len(a) != len(b):
        size = max(len(a), len(b))
        a = a + [0.0] * (size - len(a))
        b = b + [0.0] * (size - len(b))
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x ** 2 for x in a) ** 0.5
    nb = sum(x ** 2 for x in b) ** 0.5
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)
