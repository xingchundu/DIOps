require('dotenv').config();
const express = require('express');
require('./src/utils/asyncErrors'); // async 路由异常交给全局错误处理
const cors = require('cors');
const morgan = require('morgan');
const { initPool, applyPoolConfigFromSysConfig } = require('./src/config/db');
const { applySecurityMiddleware, buildAllowedOrigins } = require('./src/middleware/security');

const app = express();
const PORT = process.env.PORT || 3001;
const isProd = process.env.NODE_ENV === 'production';

if (process.env.TRUST_PROXY === '1' || String(process.env.TRUST_PROXY || '').toLowerCase() === 'true') {
  app.set('trust proxy', 1);
}

// 中间件（支持 HTTPS 访问；生产经 Nginx 反代时建议 TRUST_PROXY=1）
const corsOrigins = [...buildAllowedOrigins()];
applySecurityMiddleware(app, { allowedOrigins: new Set(corsOrigins) });
app.use(cors({
  origin: corsOrigins,
  credentials: true,
}));
app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => {
    if (buf && buf.length) req.rawBody = buf;
  },
}));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('[:method] :url :status :response-time ms'));

// 健康检查（仅存活探测，不暴露连接池等内部状态）
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// SQL 优化 Agent 代理（Python FastAPI 服务，需登录）
const { createProxyMiddleware, fixRequestBody } = require('http-proxy-middleware');
const { authMiddleware } = require('./src/middleware/auth');

// SQL 优化 — LLM 状态直连 Ollama（HTTPS 下不依赖 Python Agent 是否启动）；原先挂在鉴权之前，任何人可调用
app.use('/api/sql-agent/api', authMiddleware, require('./src/routes/sqlAgentLlm'));
const sqlAgentTarget = process.env.SQL_AGENT_URL || 'http://127.0.0.1:8000';
// [fix] http-proxy-middleware v3：express.json() 已读走请求体，需 fixRequestBody 重新写入，否则 POST 转发后 Agent 收到空体；
//       v3 不再识别 onProxyRes 旧写法，事件改用 on: {...}
app.use('/api/sql-agent', authMiddleware, createProxyMiddleware({
  target: sqlAgentTarget,
  changeOrigin: true,
  pathRewrite: { '^/api/sql-agent': '' },
  on: {
    proxyReq(proxyReq, req, res) {
      // 内部令牌与用户身份由平台设置（Python 服务据此拒绝绕过平台的直连请求），客户端自带的同名头一律去掉
      for (const h of ['x-diops-internal-token', 'x-diops-user']) proxyReq.removeHeader(h);
      const token = String(process.env.AI_INTERNAL_TOKEN || '').trim();
      if (token) proxyReq.setHeader('X-DIOps-Internal-Token', token);
      if (req.user) proxyReq.setHeader('X-DIOps-User', String(req.user.username || `u${req.user.userId}`));
      // Java 网关转发的 POST 常导致 req.readableLength≠0，fixRequestBody 被跳过、代理发出畸形 HTTP（Python 400 Invalid HTTP request）
      if (req.rawBody && req.rawBody.length) {
        proxyReq.setHeader('Content-Length', req.rawBody.length);
        proxyReq.removeHeader('Transfer-Encoding');
        proxyReq.write(req.rawBody);
      } else {
        fixRequestBody(proxyReq, req, res);
      }
    },
    proxyRes(proxyRes) {
      if ((proxyRes.headers['content-type'] || '').includes('text/event-stream')) {
        proxyRes.headers['cache-control'] = 'no-cache';
        proxyRes.headers['x-accel-buffering'] = 'no';
      }
    },
    error(err, req, res) {
      if (res.headersSent) return;
      const hint = `SQL 优化服务未就绪（${sqlAgentTarget}）。请执行 ./start-java.sh start 或 ./scripts/start-sql-optimizer.sh start，并确保 Python 3.9+ 与依赖已安装。`;
      res.status(502).json({ ok: false, message: hint, error: err.code || err.message });
    },
  },
}));

// 路由注册
// 认证、用户、权限、系统配置、CMDB、监控、告警、SQL 洞察（/api/sql-insight、/api/sql）由 Java dbops-server 提供，
// Node 中的重复实现已删除（Java 已实现全部 101 个同名接口）。部署架构固定为：浏览器 → Java:3000 → 其余接口转发 Node:3001。
// 若前端误直连 Node，这里转发给 Java 或返回 503 指引，而不是“接口不存在”。
app.use(require('./src/routes/javaGateway').JAVA_PREFIXES, require('./src/routes/javaGateway'));
app.use('/api/automation',  require('./src/routes/automation'));
app.use('/api/ai',          require('./src/routes/ai'));
app.use('/api/sql-opt',         require('./src/routes/sqlOptHistory'));
app.use('/api/kg',              require('./src/routes/kg'));
app.use('/api/sql-diag',        require('./src/routes/sqlDiag'));
app.use('/api/app-relation',    require('./src/routes/appRelation'));
app.use('/api/tags',            require('./src/routes/tagGroup'));
app.use('/api/sql-review',      require('./src/routes/sqlReview'));
// 运行自检：路由契约 / 巡检报告体检 / 指定实例表空间链路逐级诊断（ADMIN、DBA）
app.use('/api/diagnostics',     require('./src/routes/diagnostics'));
// /api/reports 已由 Java 运行报告（/api/monitor/report）替代
app.use('/api/custom-metrics',  require('./src/routes/customMetrics'));
app.use('/api/workbench',       require('./src/routes/sqlWorkbench'));
app.use('/api/service-catalog', require('./src/routes/serviceCatalog'));
app.use('/api/deploy',        require('./src/routes/deploy'));

// 兜底404
app.use((req, res) => res.status(404).json({ code: 404, msg: `接口不存在: ${req.method} ${req.path}` }));

// 全局错误处理
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    code: 500,
    msg: isProd ? '服务器内部错误' : (err.message || '服务器内部错误'),
  });
});

// 未处理的 Promise 拒绝 / 异常：记录日志，不让进程因单个请求退出
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));
process.on('uncaughtException', err => console.error('[uncaughtException]', err));

// 启动
async function start() {
  try {
    await initPool();
    const sysConfig = require('./src/services/systemConfig');
    await sysConfig.loadAll();
    await applyPoolConfigFromSysConfig();

    // 只监听本机：所有请求必须经过 Java 网关（:3000，含登录与授权校验），直接访问 3001 会绕过授权
    const HOST = process.env.BIND_HOST || '127.0.0.1';
    // 监控采集、告警评估、SQL 采集都由 Java 调度器负责，Node 不再运行任何采集定时任务
    // dxc 2026-11-12 平台运维闭环 Node 作业
    try {
      require('./src/platform/bootstrap').startPlatformJobs();
    } catch (platErr) {
      console.warn('[platform] bootstrap skipped:', platErr.message);
    }

    const server = app.listen(PORT, HOST, () => {
      // ASCII-only banner: avoids mojibake on Windows cmd/PowerShell (GBK vs UTF-8).
      console.log('\n========================================');
      console.log(' DB Ops backend (Node) is running');
      console.log(` PORT: ${PORT}  (behind Java gateway, JAVA_SERVER_URL=${process.env.JAVA_SERVER_URL || 'http://127.0.0.1:3000'})`);
      console.log(` NODE_ENV: ${process.env.NODE_ENV}`);
      console.log(` Oracle: ${process.env.DB_HOST}/${process.env.DB_SID || process.env.DB_SERVICE_NAME || ''}`);
      console.log('========================================\n');
    });

    server.on('error', async (err) => {
      if (err.code === 'EADDRINUSE') {
        try {
          const resp = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2000) });
          if (resp.ok) {
            console.log(`[INFO] Backend already running on port ${PORT}, skip duplicate start.`);
            process.exit(0);
          }
        } catch { /* port used by another program */ }
        console.error(`[ERROR] Port ${PORT} is already in use. Stop the process first:`);
        console.error(`  netstat -ano | findstr :${PORT}`);
        console.error(`  taskkill /PID <pid> /F`);
        process.exit(1);
      }
      console.error('Startup failed:', err.message);
      process.exit(1);
    });
  } catch (err) {
    console.error('Startup failed:', err.message);
    process.exit(1);
  }
}

start();
