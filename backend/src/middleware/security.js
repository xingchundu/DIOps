const os = require('os');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

function hostOrigins(host) {
  const origins = [];
  for (const scheme of ['https', 'http']) {
    origins.push(`${scheme}://${host}`);
    for (const port of [5173, 4173, 80, 443, 3000]) { // 3000：Java 网关（生产同源入口）
      origins.push(`${scheme}://${host}:${port}`);
    }
  }
  return origins;
}

function localHosts() {
  const hosts = ['localhost', '127.0.0.1'];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      const v4 = net.family === 'IPv4' || net.family === 4;
      if (v4 && net.address && !hosts.includes(net.address)) hosts.push(net.address);
    }
  }
  return hosts;
}

function buildAllowedOrigins(extraOrigins = []) {
  const origins = [];
  for (const host of localHosts()) origins.push(...hostOrigins(host));
  origins.push(...extraOrigins);
  for (const item of String(process.env.FRONTEND_URL || '').split(',')) {
    const value = item.trim();
    if (value) origins.unshift(value);
  }
  return new Set(origins.filter(Boolean));
}

function applySecurityMiddleware(app, { allowedOrigins } = {}) {
  const origins = allowedOrigins || buildAllowedOrigins();

  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }));

  const globalMax = parseInt(process.env.RATE_LIMIT_MAX || '1000', 10);
  app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number.isFinite(globalMax) ? Math.max(100, globalMax) : 1000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { code: 429, msg: '请求过于频繁，请稍后再试' },
  }));

  // 登录接口由 Java 实现，登录限流在 Java RateLimitFilter；这里原有的 /api/auth/login 限流从不会命中，已删除

  app.use((req, res, next) => {
    const method = req.method.toUpperCase();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return next();
    if (req.path === '/health') return next();

    const origin = req.headers.origin;
    if (origin) {
      if (!origins.has(origin)) {
        return res.status(403).json({ code: 403, msg: '请求来源不被允许' });
      }
      return next();
    }

    const referer = req.headers.referer;
    if (referer) {
      const ok = [...origins].some((o) => referer === o || referer.startsWith(`${o}/`));
      if (!ok) {
        return res.status(403).json({ code: 403, msg: '请求来源不被允许' });
      }
    }
    next();
  });
}

module.exports = { applySecurityMiddleware, buildAllowedOrigins };
