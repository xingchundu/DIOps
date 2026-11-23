"""
LLM 服务层 - 支持 Ollama + OpenAI 兼容 API
"""
import os
import hashlib
import re
from typing import Optional, List, Dict, Tuple

import httpx

OLLAMA_BASE = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
DEFAULT_MODEL = os.getenv("LLM_MODEL", "deepseek-r1:1.5b")
LLM_TIMEOUT = int(os.getenv("LLM_TIMEOUT", "120"))
# 向量模型必须显式配置（如 nomic-embed-text / bge-m3）。原来回退到生成模型 deepseek-r1，
# Ollama 的 /api/embeddings 对生成模型要么报错要么返回无意义向量 → 默认部署下知识库入库/检索全链路不可用
EMBED_MODEL = os.getenv("EMBED_MODEL", "").strip()
if not EMBED_MODEL:
    import logging as _logging
    _logging.getLogger("ai-ops").warning("未配置 EMBED_MODEL：知识库将降级为关键词检索（语义检索需设置如 EMBED_MODEL=nomic-embed-text）")

OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "http://localhost:11434/v1")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")

# 仅显式开启时才允许 hash 伪向量（默认禁止静默降级）
ALLOW_HASH_EMBEDDING = os.getenv("ALLOW_HASH_EMBEDDING", "").lower() in ("1", "true", "yes")
_THINKING_BLOCK = re.compile(r"<think>.*?</think>", re.DOTALL)


class LLMError(RuntimeError):
    """LLM 生成失败"""


class EmbeddingError(RuntimeError):
    """Embedding 向量化失败"""


def _get_provider_config(provider: Optional[str] = None, llm_config: Optional[Dict] = None) -> Tuple[str, str, str]:
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


def get_model_name(llm_config: Optional[Dict] = None) -> str:
    cfg = llm_config or {}
    return cfg.get("model") or DEFAULT_MODEL


def is_llm_error_text(text: str) -> bool:
    return bool(text and str(text).strip().startswith("[LLM ERROR:"))


async def generate(
    prompt: str,
    system: str = "",
    max_tokens: int = 1024,
    llm_config: Optional[Dict] = None,
) -> str:
    """调用 LLM 生成文本；失败时抛出 LLMError，不返回伪成功文本。"""
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    provider, base_url, api_key = _get_provider_config(llm_config=llm_config)
    model = get_model_name(llm_config)

    try:
        if provider == "openai":
            content = await _generate_openai(base_url, api_key, messages, model, max_tokens)
        else:
            content = await _generate_ollama(base_url, messages, model, max_tokens)
    except Exception as e:
        raise LLMError(str(e)) from e

    if not content or not str(content).strip():
        raise LLMError("LLM 返回空内容")
    return content


async def _generate_ollama(
    base_url: str, messages: List[Dict], model: str, max_tokens: int,
) -> str:
    async with httpx.AsyncClient(timeout=LLM_TIMEOUT) as client:
        resp = await client.post(
            f"{base_url}/api/chat",
            json={
                "model": model,
                "messages": messages,
                "stream": False,
                "options": {"num_predict": max_tokens, "temperature": 0.2},
            },
        )
        resp.raise_for_status()
        data = resp.json()
        content = data.get("message", {}).get("content", "")
        content = _THINKING_BLOCK.sub("", content).strip()
        return content


async def _generate_openai(
    base_url: str, api_key: str, messages: List[Dict], model: str, max_tokens: int,
) -> str:
    base_url = base_url.rstrip("/")
    async with httpx.AsyncClient(timeout=LLM_TIMEOUT) as client:
        resp = await client.post(
            f"{base_url}/chat/completions",
            json={
                "model": model,
                "messages": messages,
                "stream": False,
                "max_tokens": max_tokens,
                "temperature": 0.2,
            },
            headers=_openai_headers(api_key),
        )
        resp.raise_for_status()
        data = resp.json()
        choices = data.get("choices", [])
        if not choices:
            raise LLMError("OpenAI 兼容 API 未返回 choices")
        content = choices[0].get("message", {}).get("content", "")
        content = _THINKING_BLOCK.sub("", content).strip()
        return content


async def get_embedding(text: str, llm_config: Optional[Dict] = None) -> List[float]:
    """获取文本向量；默认失败即抛 EmbeddingError，不静默降级。"""
    provider, base_url, api_key = _get_provider_config(llm_config=llm_config)
    model = llm_config.get("embed_model") if llm_config else None
    model = model or EMBED_MODEL
    if not model and not ALLOW_HASH_EMBEDDING:
        raise EmbeddingError("未配置向量模型 EMBED_MODEL（例如 nomic-embed-text、bge-m3），知识库向量化不可用")

    errors: list[str] = []
    try:
        if provider == "openai":
            return await _embedding_openai(base_url, api_key, model, text)
        return await _embedding_ollama(base_url, model, text)
    except Exception as e:
        errors.append(str(e))

    if ALLOW_HASH_EMBEDDING:
        return _hash_embedding(text, dim=64)

    detail = errors[0] if errors else "unknown"
    raise EmbeddingError(
        f"Embedding 服务不可用: {detail}。"
        "请检查 Ollama/OpenAI Embedding 配置，或设置 ALLOW_HASH_EMBEDDING=1 启用降级（不推荐）。"
    )


async def _embedding_ollama(base_url: str, model: str, text: str) -> List[float]:
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{base_url}/api/embeddings",
            json={"model": model, "prompt": text[:2000]},
        )
        resp.raise_for_status()
        data = resp.json()
        emb = data.get("embedding")
        if not emb:
            raise EmbeddingError("Ollama embedding 响应无 embedding 字段")
        return emb


async def _embedding_openai(base_url: str, api_key: str, model: str, text: str) -> List[float]:
    base_url = base_url.rstrip("/")
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{base_url}/embeddings",
            json={"model": model, "input": text[:2000]},
            headers=_openai_headers(api_key),
        )
        resp.raise_for_status()
        data = resp.json()
        emb_list = data.get("data", [])
        if not emb_list or not emb_list[0].get("embedding"):
            raise EmbeddingError("OpenAI embedding 响应为空")
        return emb_list[0]["embedding"]


def _hash_embedding(text: str, dim: int = 64) -> List[float]:
    vec = [0.0] * dim
    text = text.lower()[:1000]
    for i in range(len(text) - 2):
        ngram = text[i : i + 3]
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
