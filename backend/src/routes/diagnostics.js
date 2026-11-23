/**
 * diagnostics.js  v1.0  —— 运行自检模块
 *
 * 目的：把「接口不存在 / 表空间暂无数据 / 巡检报告空壳」这类只能在部署现场复现的
 * 问题，变成页面上一次点击就能拿到结论的自检能力。
 *
 *   GET  /api/diagnostics/routes      当前 Node 进程实际加载的路由 + 关键端点契约检查
 *   GET  /api/diagnostics/reports     巡检报告目录体检（大小 / docx 魔数 / 同名覆盖）
 *   POST /api/diagnostics/target/:id  指定实例的表空间查询链路逐级自检（Oracle）
 *
 * 仅 ADMIN / DBA 可调用：诊断结果包含被管库字典信息与文件清单。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { authMiddleware, requireRole } = require('../middleware/auth');
const exporter = require('../services/monitorExporterCollect');
const { getInspectReportsRoot } = require('../services/inspectPythonDocxRunner');

const router = express.Router();
router.use(authMiddleware);
router.use(requireRole('ADMIN', 'DBA'));

const MIN_DOCX_BYTES = 8192;

/** 从 Express Router.stack 中提取本进程真实注册的路由（不是静态文档） */
function moduleRoutes(mod) {
  const out = [];
  for (const layer of (mod && mod.stack) || []) {
    if (!layer.route) continue;
    const methods = Object.keys(layer.route.methods || {})
      .filter((m) => !m.startsWith('_') && layer.route.methods[m])
      .map((m) => m.toUpperCase());
    out.push({ methods, path: layer.route.path });
  }
  return out;
}

/**
 * 关键端点契约。
 * hasMethod 用「路由模块内的相对路径」判断，可以区分：
 *   - 源码已修复但运行的是旧 Node 进程（应重启）
 *   - 请求被 Java 网关拦成 404（应重建/重启 Java jar）
 */
const CONTRACTS = [
  { key: 'sql-review: PATCH /tickets/:id/assign', module: 'sqlReview', methods: ['PATCH'], route: '/tickets/:id/assign',
    hint: '截图2「接口不存在: PATCH .../assign」。若此处缺失说明 Node 跑的是旧代码，需重启 backend。' },
  { key: 'sql-review: POST /tickets/:id/assign', module: 'sqlReview', methods: ['POST'], route: '/tickets/:id/assign',
    hint: 'PATCH 被旧网关拦截时的前端回退通道，与 PATCH 必须同时存在。' },
  { key: 'sql-review: PUT /tickets/:id/assign', module: 'sqlReview', methods: ['PUT'], route: '/tickets/:id/assign',
    hint: '兼容 PUT 方式改派。' },
  { key: 'sql-review: POST /tickets/:id/review', module: 'sqlReview', methods: ['POST'], route: '/tickets/:id/review',
    hint: '审核「通过 / 拒绝 / 要求修改」依赖该接口。' },
  { key: 'monitor: GET /instances/:id/tablespaces', module: 'monitor', methods: ['GET'], route: '/instances/:id/tablespaces',
    hint: '截图1 表空间列表数据源，应使用 19c DBA_TABLESPACE_USAGE_METRICS 口径。' },
];

const MODULE_LOADERS = {
  sqlReview: () => require('./sqlReview'),
  monitor: () => require('./monitor'),
  diagnostics: () => router,
};

// ── GET /routes ───────────────────────────────────────────────────
router.get('/routes', (req, res) => {
  const modules = {};
  const loadErrors = {};
  for (const [name, load] of Object.entries(MODULE_LOADERS)) {
    try { modules[name] = moduleRoutes(load()); }
    catch (e) { loadErrors[name] = String(e.message || e); modules[name] = []; }
  }

  const checks = CONTRACTS.map((c) => {
    const found = (modules[c.module] || []).find((r) => r.path === c.route);
    const present = c.methods.filter((m) => found && found.methods.includes(m));
    const missing = c.methods.filter((m) => !present.includes(m));
    return {
      key: c.key,
      ok: missing.length === 0,
      present,
      missing,
      registeredAs: found ? `${found.methods.join('/')} ${found.path}` : null,
      hint: missing.length ? c.hint : null,
    };
  });

  res.json({
    code: 200,
    data: {
      node: {
        version: process.version,
        cwd: process.cwd(),
        uptimeSeconds: Math.round(process.uptime()),
        serverTime: new Date().toISOString(),
      },
      javaGatewayUrl: process.env.JAVA_SERVER_URL || 'http://127.0.0.1:3000',
      javaOwnedHint: '若 Java 网关返回 404/503，请确认 dbops-server 已用本次代码重新 mvn package 并重启，'
        + '且 legacy.enabled=true、context path 与 Nginx 反代一致。',
      modules,
      loadErrors,
      checks,
      allOk: checks.every((c) => c.ok) && Object.keys(loadErrors).length === 0,
    },
  });
});

// ── GET /reports ──────────────────────────────────────────────────
router.get('/reports', (_req, res) => {
  const root = getInspectReportsRoot();
  const data = { root, exists: false, total: 0, totalBytes: 0, items: [], suspects: [] };
  if (!fs.existsSync(root)) {
    return res.json({ code: 200, data });
  }
  data.exists = true;

  const names = fs.readdirSync(root).filter((n) => /\.(docx|xlsx)$/i.test(n));
  for (const name of names) {
    const fp = path.join(root, name);
    let st;
    try { st = fs.statSync(fp); } catch { continue; }
    if (!st.isFile()) continue;
    data.total += 1;
    data.totalBytes += st.size;
    data.items.push({ name, size: st.size, mtime: st.mtime.toISOString() });
  }
  data.items.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));

  // 可疑项：体积过小 / 不是 zip(docx,xlsx 都是 zip) / 同名前缀重复
  const byPrefix = new Map();
  for (const it of data.items) {
    let magic = '';
    try {
      const fd = fs.openSync(path.join(root, it.name), 'r');
      const buf = Buffer.alloc(4);
      fs.readSync(fd, buf, 0, 4, 0);
      fs.closeSync(fd);
      magic = buf.toString('latin1');
    } catch { /* ignore */ }
    if (it.size < MIN_DOCX_BYTES) data.suspects.push(`${it.name}: 体积异常 ${it.size} bytes（疑似空壳报告）`);
    if (magic !== 'PK\u0003\u0004') data.suspects.push(`${it.name}: 不是有效的 Office(zip) 文件`);
    const prefix = it.name.replace(/_\d+\.(docx|xlsx)$/i, '.$1');
    if (byPrefix.has(prefix)) byPrefix.set(prefix, byPrefix.get(prefix) + 1);
    else byPrefix.set(prefix, 1);
  }
  data.items = data.items.slice(0, 50);   // 只回传最近 50 个，避免响应过大
  data.suspects = data.suspects.slice(0, 50);
  res.json({ code: 200, data });
});

// ── POST /target/:id ──────────────────────────────────────────────
router.post('/target/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.json({ code: 400, msg: '实例 ID 非法' });
  }
  try {
    const result = await exporter.oracleTablespaceDiagnostics(id);
    res.json({ code: 200, data: result });
  } catch (e) {
    res.json({ code: 500, msg: String(e.message || e) });
  }
});

module.exports = router;
