/**
 * Node → Java 兜底转发：认证/用户/权限/系统配置/CMDB/监控/告警/SQL 洞察 只在 Java dbops-server 中实现。
 *
 * 三种情况：
 *  1. 正常（start-java：Java:3000 → Node:3001）：这些请求由 Java 直接处理，不会到这里。
 *  2. 前端直连 Node（只跑了 start-all / Node 在 3000）且另有 Java 在 JAVA_SERVER_URL：原样转发过去。
 *  3. Java 没启动、地址指向 Node 自己、或 Java 是旧版本（不认识这些路径又把请求转回 Node）：
 *     返回 503 + 具体处理办法。用 X-DIOps-Via 头识别回环，避免 Node↔Java 无限转发。
 */
const express = require('express');
const { createProxyMiddleware, fixRequestBody } = require('http-proxy-middleware');

const router = express.Router();
const SELF_PORT = String(process.env.PORT || 3001);
const JAVA_URL = String(process.env.JAVA_SERVER_URL || `http://127.0.0.1:${process.env.JAVA_SERVER_PORT || 3000}`).replace(/\/+$/, '');

function pointsToSelf(url) {
  try {
    const u = new URL(url);
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return ['127.0.0.1', 'localhost', '0.0.0.0', '::1', '[::1]'].includes(u.hostname) && port === SELF_PORT;
  } catch {
    return true;
  }
}

const HOWTO = '该接口由 Java 服务 dbops-server 提供。请用 start-all / start-java 启动（Java 监听 3000，Node 监听 3001），'
  + '代码更新后脚本会自动重新构建（需要 JDK 17+、Maven 3.8+）；新环境请完整执行 sql/init.sql（已含 SQL 洞察表结构）。';

/** 与 Java AuthFilter.OWNED_PREFIXES 保持一致 */
const JAVA_PREFIXES = ['/api/auth', '/api/users', '/api/rbac', '/api/system-config', '/api/cmdb', '/api/monitor', '/api/alerts',
  '/api/sql-insight', '/api/sql', '/api/license',
  // dxc 2026-11-12 平台运维闭环
  '/api/platform'];

function unavailable(res, reason) {
  res.status(503).json({ code: 503, msg: `${reason}。${HOWTO}`, data: { javaServerUrl: JAVA_URL } });
}

const proxy = createProxyMiddleware({
  target: JAVA_URL,
  changeOrigin: true,
  proxyTimeout: 120000,
  headers: { 'X-DIOps-Via': 'node' },
  on: {
    proxyReq: fixRequestBody,
    error(err, req, res) {
      if (res.headersSent) return;
      unavailable(res, `Java 服务不可达（${JAVA_URL}：${err.code || err.message}）`);
    },
  },
});

router.use((req, res, next) => {
  if (req.headers['x-diops-via'] === 'node') {
    return unavailable(res, '当前运行的 Java 服务版本过旧，不包含该接口（请求被转回了 Node），请重新构建并重启 dbops-server');
  }
  if (pointsToSelf(JAVA_URL)) {
    return unavailable(res, `当前只启动了 Node（端口 ${SELF_PORT}），没有 Java 服务`);
  }
  // Express 挂载会去掉前缀，转发时补回原始路径
  req.url = req.originalUrl;
  return proxy(req, res, next);
});

module.exports = router;
module.exports.JAVA_PREFIXES = JAVA_PREFIXES;
