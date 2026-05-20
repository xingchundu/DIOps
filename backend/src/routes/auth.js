const router = require('express').Router();
const bcrypt = require('bcryptjs');
const oracledb = require('oracledb');
const db = require('../config/db');
const { generateToken, authMiddleware } = require('../middleware/auth');
const { getClientIp } = require('../utils/clientIp');
const rbacService = require('../services/rbacService');

async function passwordHashToString(raw) {
  if (raw == null || raw === '') return '';
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (typeof raw === 'string') return raw;
  if (typeof raw.getData === 'function') {
    try {
      const d = await raw.getData();
      return d != null ? String(d) : '';
    } catch {
      return String(raw);
    }
  }
  return String(raw);
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.json({ code: 400, msg: '用户名和密码不能为空' });
  }
  try {
    const result = await db.execute(
      `SELECT USER_ID, USERNAME, PASSWORD_HASH, REAL_NAME, EMAIL, PHONE, ROLE, STATUS, TENANT_ID, LAST_LOGIN
       FROM SYS_USER WHERE USERNAME = :1`,
      [username],
      {
        fetchInfo: { PASSWORD_HASH: { type: oracledb.STRING } },
      }
    );
    if (!result.rows.length) {
      return res.json({ code: 401, msg: '用户名或密码错误' });
    }
    const user = result.rows[0];
    if (Number(user.STATUS) !== 1) {
      return res.json({ code: 403, msg: '账号已被禁用，请联系管理员' });
    }
    const hashStr = await passwordHashToString(user.PASSWORD_HASH);
    if (!hashStr) {
      return res.json({ code: 401, msg: '用户名或密码错误' });
    }
    const match = await bcrypt.compare(password, hashStr);
    if (!match) {
      await db.execute(
        `INSERT INTO SYS_AUDIT_LOG (USER_ID, USERNAME, ACTION, IP_ADDR, STATUS, DETAIL) VALUES (:1,:2,:3,:4,:5,:6)`,
        [null, username, 'LOGIN_FAIL', getClientIp(req), 'FAIL', `密码错误`]
      );
      return res.json({ code: 401, msg: '用户名或密码错误' });
    }
    // 更新最后登录时间
    await db.execute(`UPDATE SYS_USER SET LAST_LOGIN = SYSTIMESTAMP WHERE USER_ID = :1`, [user.USER_ID]);
    // 审计
    await db.execute(
      `INSERT INTO SYS_AUDIT_LOG (USER_ID, USERNAME, ACTION, IP_ADDR, STATUS) VALUES (:1,:2,:3,:4,:5)`,
      [user.USER_ID, username, 'LOGIN', getClientIp(req), 'SUCCESS']
    );
    const menus = await rbacService.getMenuPathsForRole(user.ROLE);
    const token = generateToken({ ...user, menus });
    return res.json({
      code: 200,
      msg: '登录成功',
      data: {
        token,
        user: {
          userId: user.USER_ID,
          username: user.USERNAME,
          realName: user.REAL_NAME,
          email: user.EMAIL,
          phone: user.PHONE,
          role: user.ROLE,
          lastLogin: user.LAST_LOGIN,
          tenantId: user.TENANT_ID,
          menus,
        },
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.json({ code: 500, msg: '服务器内部错误' });
  }
});

// POST /api/auth/logout
router.post('/logout', authMiddleware, async (req, res) => {
  await db.execute(
    `INSERT INTO SYS_AUDIT_LOG (USER_ID, USERNAME, ACTION, IP_ADDR, STATUS) VALUES (:1,:2,:3,:4,:5)`,
    [req.user.userId, req.user.username, 'LOGOUT', getClientIp(req), 'SUCCESS']
  ).catch(() => {});
  res.json({ code: 200, msg: '已退出登录' });
});

// GET /api/auth/profile
router.get('/profile', authMiddleware, async (req, res) => {
  try {
    const result = await db.execute(
      `SELECT USER_ID, USERNAME, REAL_NAME, EMAIL, PHONE, ROLE, STATUS, LAST_LOGIN, CREATED_AT, TENANT_ID
       FROM SYS_USER WHERE USER_ID = :1`,
      [req.user.userId]
    );
    if (!result.rows.length) return res.json({ code: 404, msg: '用户不存在' });
    const u = result.rows[0];
    const menus = await rbacService.getMenuPathsForRole(u.ROLE);
    res.json({
      code: 200,
      data: {
        userId: u.USER_ID,
        username: u.USERNAME,
        realName: u.REAL_NAME,
        email: u.EMAIL,
        phone: u.PHONE,
        role: u.ROLE,
        status: u.STATUS,
        lastLogin: u.LAST_LOGIN,
        createdAt: u.CREATED_AT,
        tenantId: u.TENANT_ID,
        menus,
      },
    });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

// PUT /api/auth/profile
router.put('/profile', authMiddleware, async (req, res) => {
  const { realName, email, phone } = req.body;
  try {
    await db.execute(
      `UPDATE SYS_USER SET REAL_NAME=:1, EMAIL=:2, PHONE=:3, UPDATED_AT=SYSTIMESTAMP WHERE USER_ID=:4`,
      [realName, email, phone, req.user.userId]
    );
    res.json({ code: 200, msg: '个人信息更新成功' });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

// POST /api/auth/change-password
router.post('/change-password', authMiddleware, async (req, res) => {
  const { oldPassword, newPassword, confirmPassword } = req.body;
  if (!oldPassword || !newPassword || !confirmPassword) {
    return res.json({ code: 400, msg: '请填写完整密码信息' });
  }
  if (newPassword !== confirmPassword) {
    return res.json({ code: 400, msg: '两次新密码输入不一致' });
  }
  if (newPassword.length < 8) {
    return res.json({ code: 400, msg: '新密码长度不能少于8位' });
  }
  // 密码强度：至少包含大小写字母+数字
  const strongPwd = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
  if (!strongPwd.test(newPassword)) {
    return res.json({ code: 400, msg: '新密码需包含大小写字母和数字（至少8位）' });
  }
  try {
    const result = await db.execute(
      `SELECT PASSWORD_HASH FROM SYS_USER WHERE USER_ID = :1`, [req.user.userId]
    );
    if (!result.rows.length) return res.json({ code: 404, msg: '用户不存在' });
    const match = await bcrypt.compare(oldPassword, result.rows[0].PASSWORD_HASH);
    if (!match) return res.json({ code: 400, msg: '原密码错误' });
    const hash = await bcrypt.hash(newPassword, 10);
    await db.execute(
      `UPDATE SYS_USER SET PASSWORD_HASH=:1, PWD_CHANGED=SYSTIMESTAMP, UPDATED_AT=SYSTIMESTAMP WHERE USER_ID=:2`,
      [hash, req.user.userId]
    );
    await db.execute(
      `INSERT INTO SYS_AUDIT_LOG (USER_ID,USERNAME,ACTION,IP_ADDR,STATUS) VALUES(:1,:2,:3,:4,:5)`,
      [req.user.userId, req.user.username, 'CHANGE_PASSWORD', getClientIp(req), 'SUCCESS']
    );
    res.json({ code: 200, msg: '密码修改成功，请重新登录' });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

// POST /api/auth/reset-password (admin only)
router.post('/reset-password', authMiddleware, async (req, res) => {
  if (req.user.role !== 'ADMIN') return res.json({ code: 403, msg: '权限不足' });
  const { userId, newPassword } = req.body;
  if (!userId || !newPassword) return res.json({ code: 400, msg: '参数缺失' });
  try {
    const hash = await bcrypt.hash(newPassword, 10);
    await db.execute(
      `UPDATE SYS_USER SET PASSWORD_HASH=:1, PWD_CHANGED=SYSTIMESTAMP, UPDATED_AT=SYSTIMESTAMP WHERE USER_ID=:2`,
      [hash, userId]
    );
    res.json({ code: 200, msg: '密码重置成功' });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

module.exports = router;
