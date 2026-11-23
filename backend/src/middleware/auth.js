const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// [fix] 原来缺省回落到固定串 'dbops_secret'，任何人都能伪造 ADMIN token。
// 生产环境（NODE_ENV=production）未配置或仍为占位串时拒绝启动；开发环境仅告警。
const INSECURE_SECRETS = new Set(['', 'dbops_secret', 'dbops_platform_secret_2026', '请换成至少32位的随机字符串', '请换成足够长的随机串']);
const JWT_SECRET = (() => {
  const s = String(process.env.JWT_SECRET || '').trim();
  if (INSECURE_SECRETS.has(s) || s.length < 16) {
    // 不再回退到公开的默认密钥。start-all 会自动生成强密钥写入 backend/.env。
    if (process.env.NODE_ENV === 'production' || process.env.DBOPS_ALLOW_WEAK_SECRET !== 'true') {
      throw new Error('JWT_SECRET 未配置或过于简单（需 >=16 位随机串）。请使用 start-all 启动（会自动生成）或在 backend/.env 中配置');
    }
    console.warn('[auth] WARNING: JWT_SECRET 过弱，DBOPS_ALLOW_WEAK_SECRET=true，仅限本地开发');
    return s || require('crypto').randomBytes(32).toString('base64');
  }
  return s;
})();

/** 生产默认要求经 Java 网关；开发可设 DIOPS_REQUIRE_GATEWAY=false 或 DBOPS_ALLOW_DIRECT_NODE=1 */
function gatewayRequired() {
  if (process.env.DBOPS_ALLOW_DIRECT_NODE === '1') return false;
  const explicit = process.env.DIOPS_REQUIRE_GATEWAY;
  if (explicit !== undefined && String(explicit).trim() !== '') {
    return String(explicit).toLowerCase() === 'true';
  }
  return process.env.NODE_ENV === 'production';
}

function authMiddleware(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ code: 401, msg: '未授权，请先登录' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    // 经 Java 网关转发的请求：网关已检查“已退出 / 禁用 / 改密码后的旧 token”，并附上数据库中的最新角色（HMAC 签名）。
    // 签名有效时以网关角色为准，角色被降级后旧 token 里的角色不再生效。
    const gwRole = req.headers['x-diops-gateway-role'];
    const gwSig = req.headers['x-diops-gateway-sig'];
    if (gwRole && gwSig) {
      const expect = crypto.createHmac('sha256', JWT_SECRET).update(`gw|${token}|${gwRole}`, 'utf8').digest('base64url');
      const a = Buffer.from(String(gwSig));
      const b = Buffer.from(expect);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) req.user = { ...payload, role: String(gwRole) };
      else return res.status(401).json({ code: 401, msg: '网关签名无效' });
    } else if (gatewayRequired()) {
      return res.status(401).json({ code: 401, msg: '请通过平台入口访问' });
    }
    next();
  } catch (err) {
    return res.status(401).json({ code: 401, msg: 'Token已过期或无效，请重新登录' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ code: 403, msg: '权限不足' });
    }
    next();
  };
}

function generateToken(user) {
  const menus = Array.isArray(user.menus) ? user.menus : [];
  return jwt.sign(
    {
      userId: user.USER_ID,
      username: user.USERNAME,
      role: user.ROLE,
      tenantId: user.TENANT_ID,
      menus,
    },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES || '8h' }
  );
}

/** 后台任务签发短期系统令牌用（与登录令牌同一密钥） */
function signShortToken(payload, expiresIn = '2m') {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

module.exports = { authMiddleware, requireRole, generateToken, signShortToken, gatewayRequired };
