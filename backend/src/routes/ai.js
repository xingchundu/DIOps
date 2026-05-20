/**
 * /api/ai/*  —— AI 智能分析模块路由
 * 代理转发到 Python AI Ops Agent（http://localhost:8001）
 * 同时直接操作 Oracle 查询部分轻量数据
 */
const router = require('express').Router();
const http = require('http');
const https = require('https');
const { authMiddleware } = require('../middleware/auth');

const AI_AGENT_BASE = process.env.AI_OPS_AGENT_URL || 'http://localhost:8001';

router.use(authMiddleware);

/** 与 POST /ai/chat 一致：供 ChatOps 会话列表/历史代理 X-DIOps-User（username 缺失时用 u{userId}） */
function diopsChatUser(req) {
  const u = req.user;
  if (!u) return 'system';
  if (u.username != null && String(u.username).trim() !== '') return String(u.username).trim();
  if (u.userId != null) return `u${u.userId}`;
  return 'system';
}

// ─── 内部代理工具 ───────────────────────────────────────────────

/**
 * 将请求代理到 Python AI 服务，支持 GET/POST/DELETE
 */
async function proxyToAI(req, res, method, path, body, extraHeaders = {}) {
  const url = new URL(path, AI_AGENT_BASE);

  // 追加查询参数
  if (method === 'GET' && req.query) {
    Object.entries(req.query).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  const lib = url.protocol === 'https:' ? https : http;
  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    timeout: 180000,
  };

  const bodyStr = body ? JSON.stringify(body) : null;
  if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);

  return new Promise((resolve) => {
    const proxyReq = lib.request(options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', (chunk) => (data += chunk));
      proxyRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          res.json(parsed);
        } catch {
          res.status(502).json({ code: 502, msg: '解析AI服务响应失败', raw: data.slice(0, 200) });
        }
        resolve();
      });
    });

    proxyReq.on('error', (err) => {
      console.error('[ai-proxy] error:', err.message);
      res.status(503).json({ code: 503, msg: `AI服务不可达: ${err.message}` });
      resolve();
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      res.status(504).json({ code: 504, msg: 'AI服务超时（LLM推理时间较长，请稍后重试）' });
      resolve();
    });

    if (bodyStr) proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

// ─── RCA 根因分析 ────────────────────────────────────────────────

/**
 * POST /api/ai/rca
 * body: { alert_id, instance_id, alert_content }
 */
router.post('/rca', async (req, res) => {
  const { alert_id, instance_id, alert_content } = req.body;
  if (!instance_id || !alert_content) {
    return res.json({ code: 400, msg: '缺少必要参数 instance_id / alert_content' });
  }
  await proxyToAI(req, res, 'POST', '/ai/rca', {
    alert_id: alert_id || 0,
    instance_id: Number(instance_id),
    alert_content,
    created_by: req.user.username,
  });
});

/** GET /api/ai/rca/list?instance_id=&limit= */
router.get('/rca/list', (req, res) => proxyToAI(req, res, 'GET', '/ai/rca/list'));

/** GET /api/ai/rca/:id */
router.get('/rca/:id', (req, res) => proxyToAI(req, res, 'GET', `/ai/rca/${req.params.id}`));

// ─── 异常检测 ────────────────────────────────────────────────────

/**
 * POST /api/ai/anomaly/detect
 * body: { instance_id, lookback_minutes }
 */
router.post('/anomaly/detect', async (req, res) => {
  const { instance_id, lookback_minutes = 60 } = req.body;
  if (!instance_id) return res.json({ code: 400, msg: '缺少 instance_id' });
  await proxyToAI(req, res, 'POST', '/ai/anomaly/detect', {
    instance_id: Number(instance_id),
    lookback_minutes: Number(lookback_minutes),
  });
});

/** GET /api/ai/anomaly?instance_id=&limit= */
router.get('/anomaly', (req, res) => proxyToAI(req, res, 'GET', '/ai/anomaly'));

// ─── 告警聚类降噪 ─────────────────────────────────────────────────

/**
 * POST /api/ai/cluster
 * body: { similarity_threshold }
 */
router.post('/cluster', async (req, res) => {
  await proxyToAI(req, res, 'POST', '/ai/cluster', {
    similarity_threshold: req.body.similarity_threshold || 0.75,
  });
});

/** GET /api/ai/cluster?status=ACTIVE&limit= */
router.get('/cluster', (req, res) => proxyToAI(req, res, 'GET', '/ai/cluster'));

// ─── ChatOps 问答 ─────────────────────────────────────────────────

/**
 * POST /api/ai/chat
 * body: { question, session_id?, instance_id? }
 */
router.post('/chat', async (req, res) => {
  const { question, session_id, instance_id } = req.body;
  if (!question) return res.json({ code: 400, msg: '缺少问题内容 question' });
  const uname = diopsChatUser(req);
  await proxyToAI(
    req,
    res,
    'POST',
    '/ai/chat',
    {
      question,
      session_id: session_id || null,
      instance_id: instance_id ? Number(instance_id) : null,
      created_by: uname,
    },
    { 'X-DIOps-User': uname }
  );
});

/** GET /api/ai/chat/sessions 须在 :session_id 之前，避免 sessions 被当成 id */
router.get('/chat/sessions', (req, res) =>
  proxyToAI(req, res, 'GET', '/ai/chat/sessions', undefined, {
    'X-DIOps-User': diopsChatUser(req),
  })
);

/** GET /api/ai/chat/:session_id */
router.get('/chat/:session_id', (req, res) =>
  proxyToAI(req, res, 'GET', `/ai/chat/${req.params.session_id}`, undefined, {
    'X-DIOps-User': diopsChatUser(req),
  })
);

// ─── 知识库管理 ──────────────────────────────────────────────────

/** GET /api/ai/knowledge?doc_type= */
router.get('/knowledge', (req, res) => proxyToAI(req, res, 'GET', '/ai/knowledge'));

/** GET /api/ai/knowledge/search?q=&top_k= */
router.get('/knowledge/search', (req, res) =>
  proxyToAI(req, res, 'GET', '/ai/knowledge/search')
);

/**
 * POST /api/ai/knowledge
 * body: { title, content, doc_type, tags, source }
 */
router.post('/knowledge', async (req, res) => {
  const { title, content, doc_type, tags, source } = req.body;
  if (!title || !content) return res.json({ code: 400, msg: '缺少 title 或 content' });
  await proxyToAI(req, res, 'POST', '/ai/knowledge', {
    title,
    content,
    doc_type: doc_type || 'EXPERIENCE',
    tags: tags || '',
    source: source || '',
    created_by: req.user.username,
  });
});

/** DELETE /api/ai/knowledge/:id */
router.delete('/knowledge/:id', (req, res) =>
  proxyToAI(req, res, 'DELETE', `/ai/knowledge/${req.params.id}`)
);

/** POST /api/ai/knowledge/:id/reindex */
router.post('/knowledge/:id/reindex', (req, res) =>
  proxyToAI(req, res, 'POST', `/ai/knowledge/${req.params.id}/reindex`)
);

// ─── 文件上传知识库（Multipart，需要特殊处理）─────────────────────

router.post('/knowledge/upload', async (req, res) => {
  // 直接流式转发 multipart 到 Python 服务
  const url = new URL('/ai/knowledge/upload', AI_AGENT_BASE);
  const lib = url.protocol === 'https:' ? https : http;

  // 追加查询参数
  const docType = req.query.doc_type || 'MANUAL';
  const tags = req.query.tags || '';
  const createdBy = req.user.username;
  url.searchParams.set('doc_type', docType);
  url.searchParams.set('tags', tags);
  url.searchParams.set('created_by', createdBy);

  const options = {
    hostname: url.hostname,
    port: url.port || 80,
    path: url.pathname + url.search,
    method: 'POST',
    headers: req.headers,
    timeout: 60000,
  };
  delete options.headers['host'];

  const proxyReq = lib.request(options, (proxyRes) => {
    let data = '';
    proxyRes.on('data', (chunk) => (data += chunk));
    proxyRes.on('end', () => {
      try { res.json(JSON.parse(data)); } catch { res.status(502).json({ code: 502, msg: '代理响应解析失败' }); }
    });
  });
  proxyReq.on('error', (err) => res.status(503).json({ code: 503, msg: err.message }));
  req.pipe(proxyReq);
});

// ─── AI 服务状态检查 ──────────────────────────────────────────────

/** GET /api/ai/health */
router.get('/health', async (req, res) => {
  await proxyToAI(req, res, 'GET', '/health');
});

module.exports = router;
