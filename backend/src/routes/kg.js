/**
 * /api/kg  AI 知识图谱
 * 注意：/api/kg 不在 Java 网关的 OWNED_PREFIXES 内，由 Node 处理。
 */
const router = require('express').Router();
const { authMiddleware } = require('../middleware/auth');
const kg = require('../services/kgService');

router.use(authMiddleware);
const wrap = (fn) => async (req, res) => {
  try { res.json({ code: 200, data: await fn(req) }); }
  catch (e) { res.json({ code: 500, msg: e.message }); }
};

router.get('/stats', wrap(() => kg.stats()));
router.get('/overview', wrap((req) => kg.overview(req.query.limit, req.query.type)));
router.get('/search', wrap((req) => kg.search({ q: req.query.q, type: req.query.type, limit: req.query.limit })));
router.get('/context', wrap(async (req) => ({ text: await kg.contextFor(req.query.q || '') })));
router.get('/node/:id', wrap(async (req) => {
  const node = await kg.getNode(req.params.id);
  if (!node) throw new Error('节点不存在');
  return { node, graph: await kg.neighborhood(req.params.id, req.query.depth || 1) };
}));
router.post('/note', wrap((req) => {
  const { title, content, relateTo } = req.body || {};
  if (!title) throw new Error('title 不能为空');
  return kg.addNote({ title, content: content || '', relateTo: Array.isArray(relateTo) ? relateTo : [], userId: req.user?.userId });
}));
router.delete('/node/:id', wrap(async (req) => ({ deleted: await kg.deleteNode(req.params.id) })));

// Python agent（RCA 等）写入入口：仅允许已登录/内部 token 的请求；类型白名单，防止任意写入
router.post('/ingest/rca', wrap((req) => kg.recordRca(req.body || {})));

module.exports = router;
