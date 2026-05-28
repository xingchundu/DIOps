require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { initPool } = require('./src/config/db');

const app = express();
const PORT = process.env.PORT || 3000;

if (process.env.TRUST_PROXY === '1' || String(process.env.TRUST_PROXY || '').toLowerCase() === 'true') {
  app.set('trust proxy', 1);
}

// 中间件
app.use(cors({
  origin: [process.env.FRONTEND_URL || 'http://localhost:5173', 'http://localhost:4173', 'http://localhost:80'],
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('[:method] :url :status :response-time ms'));

// 健康检查
app.get('/health', async (req, res) => {
  const { getPoolStats } = require('./src/config/db');
  res.json({ status: 'ok', time: new Date().toISOString(), pool: await getPoolStats() });
});

// SQL 优化 Agent 代理（Python FastAPI 服务）
const { createProxyMiddleware } = require('http-proxy-middleware');
const sqlAgentTarget = process.env.SQL_AGENT_URL || 'http://127.0.0.1:8000';
app.use('/api/sql-agent', createProxyMiddleware({
  target: sqlAgentTarget,
  changeOrigin: true,
  pathRewrite: { '^/api/sql-agent': '' },
  onProxyRes(proxyRes) {
    if ((proxyRes.headers['content-type'] || '').includes('text/event-stream')) {
      proxyRes.headers['cache-control'] = 'no-cache';
      proxyRes.headers['x-accel-buffering'] = 'no';
    }
  },
}));

// 路由注册
app.use('/api/auth',    require('./src/routes/auth'));
app.use('/api/monitor', require('./src/routes/monitor'));
app.use('/api/cmdb',    require('./src/routes/cmdb'));
app.use('/api/alerts',  require('./src/routes/alerts'));
app.use('/api/sql',     require('./src/routes/sql'));
app.use('/api/users',       require('./src/routes/users'));
app.use('/api/rbac',        require('./src/routes/rbac'));
app.use('/api/automation',  require('./src/routes/automation'));
app.use('/api/ai',          require('./src/routes/ai'));
app.use('/api/sql-opt',         require('./src/routes/sqlOptHistory'));
app.use('/api/app-relation',    require('./src/routes/appRelation'));
app.use('/api/tags',            require('./src/routes/tagGroup'));
app.use('/api/sql-review',      require('./src/routes/sqlReview'));
app.use('/api/reports',         require('./src/routes/reports'));
app.use('/api/custom-metrics',  require('./src/routes/customMetrics'));
app.use('/api/workbench',       require('./src/routes/sqlWorkbench'));
app.use('/api/service-catalog', require('./src/routes/serviceCatalog'));
app.use('/api/system-config', require('./src/routes/systemConfig'));

// 兜底404
app.use((req, res) => res.status(404).json({ code: 404, msg: `接口不存在: ${req.method} ${req.path}` }));

// 全局错误处理
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ code: 500, msg: err.message || '服务器内部错误' });
});

// 启动
async function start() {
  try {
    await initPool();
    app.listen(PORT, '0.0.0.0', () => {
      // ASCII-only banner: avoids mojibake on Windows cmd/PowerShell (GBK vs UTF-8).
      console.log('\n========================================');
      console.log(' DB Ops backend is running');
      console.log(` PORT: ${PORT}`);
      console.log(` NODE_ENV: ${process.env.NODE_ENV}`);
      console.log(` Oracle: ${process.env.DB_HOST}/${process.env.DB_SID || process.env.DB_SERVICE_NAME || ''}`);
      console.log('========================================\n');

      // 加载系统配置
      const sysConfig = require('./src/services/systemConfig');
      await sysConfig.loadAll();

      const configIntervalMs = await sysConfig.getNumber('monitor.collect.interval_ms', 90000);
      const rawMs = parseInt(process.env.MONITOR_COLLECT_INTERVAL_MS || String(configIntervalMs), 10);
      const intervalMs = Number.isFinite(rawMs) ? Math.max(60000, rawMs) : 90000;
      const firstDelay = await sysConfig.getNumber('monitor.collect.first_delay_ms', 8000);
      const { collectAllInstances } = require('./src/services/monitorCollectPersist');
      const tick = () => collectAllInstances().catch((e) => console.error('[monitor-scheduler]', e.message));
      setTimeout(tick, Math.max(1000, firstDelay));
      setInterval(tick, intervalMs);
      console.log(`[monitor-scheduler] interval ${intervalMs}ms, first delay ${firstDelay}ms\n`);
    });
  } catch (err) {
    console.error('Startup failed:', err.message);
    process.exit(1);
  }
}

start();
