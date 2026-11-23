/**
 * SQL 优化 Agent — LLM 连通性（直连 Ollama/OpenAI 兼容 API，不依赖 Python Agent 进程）
 * 供 /api/sql-agent/api/models 与 /api/sql-agent/api/llm/test 使用
 */
const router = require('express').Router();

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'http://127.0.0.1:11434/v1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const DEFAULT_MODEL = process.env.LLM_MODEL || 'deepseek-r1:1.5b';

/** 禁止服务端 fetch 的 host（云元数据等），即使误写入环境变量也拦截 */
const BLOCKED_FETCH_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.goog',
]);

function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/$/, '');
}

function getAllowedOpenAiBases() {
  const allowed = new Set();
  const add = (raw) => {
    const n = normalizeBaseUrl(raw);
    if (n) allowed.add(n);
  };
  add(OPENAI_BASE_URL);
  for (const part of String(process.env.LLM_OPENAI_BASE_URL_ALLOWLIST || '').split(',')) {
    add(part);
  }
  return allowed;
}

/** 校验 base URL 格式，并确保不在 SSRF 黑名单 host 上 */
function assertSafeBaseUrl(base) {
  let parsed;
  try {
    parsed = new URL(base.endsWith('/') ? base : `${base}/`);
  } catch {
    throw new Error('LLM API 地址格式无效');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('LLM API 地址仅支持 http/https');
  }
  if (parsed.username || parsed.password) {
    throw new Error('LLM API 地址不能包含用户名或密码');
  }
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_FETCH_HOSTS.has(host)) {
    throw new Error('LLM API 地址不允许访问该主机');
  }
  return normalizeBaseUrl(`${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '')}`);
}

function resolveOpenAiBase(clientBase) {
  const allowed = getAllowedOpenAiBases();
  const requested = normalizeBaseUrl(clientBase || OPENAI_BASE_URL);
  if (!allowed.has(requested)) {
    throw new Error('LLM API 地址未授权，仅可使用服务端配置的地址');
  }
  return assertSafeBaseUrl(requested);
}

function resolveOllamaBase(clientBase) {
  const requested = normalizeBaseUrl(clientBase || OLLAMA_BASE);
  return assertSafeBaseUrl(requested);
}

function resolveProviderConfig(provider, body = {}) {
  const p = body.provider || provider || process.env.LLM_PROVIDER || 'ollama';
  if (p === 'openai') {
    const base = resolveOpenAiBase(body.base_url);
    const key = body.api_key || OPENAI_API_KEY;
    return { provider: 'openai', base, key };
  }
  return { provider: 'ollama', base: resolveOllamaBase(body.base_url), key: '' };
}

function openaiHeaders(apiKey) {
  const h = { 'Content-Type': 'application/json' };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

async function fetchJson(url, options = {}, timeoutMs = 10000) {
  const resp = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { ok: resp.ok, status: resp.status, data, text };
}

// GET /api/sql-agent/api/models
router.get('/models', async (req, res) => {
  let provider;
  let base;
  let key;
  try {
    ({ provider, base, key } = resolveProviderConfig(req.query.provider, req.query));
  } catch (e) {
    return res.json({ ok: false, models: [], error: e.message, provider: req.query.provider || 'ollama' });
  }
  try {
    if (provider === 'openai') {
      const r = await fetchJson(`${base}/models`, { headers: openaiHeaders(key) });
      if (r.ok && r.data) {
        const models = [...new Set((r.data.data || []).map((m) => m.id))];
        return res.json({ ok: true, models, provider: 'openai' });
      }
      return res.json({ ok: false, models: [], error: `HTTP ${r.status}`, provider: 'openai' });
    }
    const r = await fetchJson(`${base}/api/tags`);
    if (r.ok && r.data) {
      const models = (r.data.models || []).map((m) => m.name);
      return res.json({ ok: true, models, provider: 'ollama' });
    }
    return res.json({ ok: false, models: [], error: `HTTP ${r.status}`, provider: 'ollama' });
  } catch (e) {
    return res.json({ ok: false, models: [DEFAULT_MODEL], error: e.message, provider });
  }
});

// POST /api/sql-agent/api/llm/test
router.post('/llm/test', async (req, res) => {
  let provider;
  let base;
  let key;
  try {
    ({ provider, base, key } = resolveProviderConfig(null, req.body || {}));
  } catch (e) {
    return res.json({ ok: false, provider: req.body?.provider || 'ollama', error: e.message });
  }
  try {
    if (provider === 'openai') {
      const r = await fetchJson(`${base}/models`, { headers: openaiHeaders(key) }, 15000);
      if (r.ok && r.data) {
        const count = (r.data.data || []).length;
        return res.json({ ok: true, provider: 'openai', base_url: base, model_count: count });
      }
      return res.json({ ok: false, provider: 'openai', error: `HTTP ${r.status}` });
    }
    const r = await fetchJson(`${base}/api/tags`, {}, 15000);
    if (r.ok && r.data) {
      const count = (r.data.models || []).length;
      return res.json({ ok: true, provider: 'ollama', base_url: base, model_count: count });
    }
    return res.json({ ok: false, provider: 'ollama', error: `HTTP ${r.status}` });
  } catch (e) {
    return res.json({ ok: false, provider, error: e.message });
  }
});

module.exports = router;
