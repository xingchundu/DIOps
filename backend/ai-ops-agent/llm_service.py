"""
LLM 服务层 - 支持 Ollama + OpenAI 兼容 API
支持：普通生成、嵌入向量（fallback 到字符 N-gram 哈希）
"""
import os
import json
import hashlib
import re
import httpx
from typing import Optional, List, Dict, Tuple

OLLAMA_BASE = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
DEFAULT_MODEL = os.getenv("LLM_MODEL", "deepseek-r1:1.5b")
LLM_TIMEOUT = int(os.getenv("LLM_TIMEOUT", "120"))

# OpenAI 兼容配置
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "http://localhost:11434/v1")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")


def _get_provider_config(provider: Optional[str] = None, llm_config: Optional[Dict] = None) -> Tuple[str, str, str]:
    """返回 (provider, base_url, api_key)。"""
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
    """返回当前配置的模型名，供 rag_service / rca_service 使用。"""
    cfg = llm_config or {}
    return cfg.get("model") or DEFAULT_MODEL


async def generate(
    prompt: str,
    system: str = "",
    max_tokens: int = 1024,
    llm_config: Optional[Dict] = None,
) -> str:
    """调用 LLM 生成文本，自动识别 Ollama / OpenAI 兼容 API。"""
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    provider, base_url, api_key = _get_provider_config(llm_config=llm_config)
    model = get_model_name(llm_config)

    try:
        if provider == "openai":
            return await _generate_openai(base_url, api_key, messages, model, max_tokens)
        else:
            return await _generate_ollama(base_url, messages, model, max_tokens)
    except Exception as e:
        return f"[LLM ERROR: {e}]"


async def _generate_ollama(
    base_url: str, messages: List[Dict], model: str, max_tokens: int,
) -> str:
    """Ollama /api/chat 非流式调用。"""
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
        content = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()
        return content


async def _generate_openai(
    base_url: str, api_key: str, messages: List[Dict], model: str, max_tokens: int,
) -> str:
    """OpenAI 兼容 /v1/chat/completions 非流式调用。"""
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
            return ""
        content = choices[0].get("message", {}).get("content", "")
        content = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()
        return content


async def get_embedding(text: str, llm_config: Optional[Dict] = None) -> List[float]:
    """
    获取文本向量。
    优先调用 Ollama /api/embeddings 或 OpenAI /v1/embeddings；
    若不支持则 fallback 到轻量伪向量（字符 N-gram 哈希）。
    """
    provider, base_url, api_key = _get_provider_config(llm_config=llm_config)
    model = get_model_name(llm_config)

    try:
        if provider == "openai":
            return await _embedding_openai(base_url, api_key, model, text)
        else:
            return await _embedding_ollama(base_url, model, text)
    except Exception:
        pass
    return _hash_embedding(text, dim=64)


async def _embedding_ollama(base_url: str, model: str, text: str) -> List[float]:
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{base_url}/api/embeddings",
            json={"model": model, "prompt": text[:2000]},
        )
        if resp.status_code == 200:
            data = resp.json()
            if "embedding" in data:
                return data["embedding"]
    raise RuntimeError("Ollama embedding failed")


async def _embedding_openai(base_url: str, api_key: str, model: str, text: str) -> List[float]:
    base_url = base_url.rstrip("/")
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{base_url}/embeddings",
            json={"model": model, "input": text[:2000]},
            headers=_openai_headers(api_key),
        )
        if resp.status_code == 200:
            data = resp.json()
            emb_list = data.get("data", [])
            if emb_list:
                return emb_list[0].get("embedding", [])
    raise RuntimeError("OpenAI embedding failed")


def _hash_embedding(text: str, dim: int = 64) -> List[float]:
    """基于字符N-gram哈希的轻量伪向量，保证相似文本余弦相似度较高"""
    vec = [0.0] * dim
    text = text.lower()[:1000]
    for i in range(len(text) - 2):
        ngram = text[i : i + 3]
        h = int(hashlib.md5(ngram.encode()).hexdigest(), 16) % dim
        vec[h] += 1.0
    norm = sum(v ** 2 for v in vec) ** 0.5 or 1.0
    return [v / norm for v in vec]


def cosine_similarity(a: List[float], b: List[float]) -> float:
    """余弦相似度"""
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
