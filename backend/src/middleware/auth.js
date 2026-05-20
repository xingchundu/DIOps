const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dbops_secret';

function authMiddleware(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ code: 401, msg: '未授权，请先登录' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
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

module.exports = { authMiddleware, requireRole, generateToken };
