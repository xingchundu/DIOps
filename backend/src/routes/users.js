const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

// GET /api/users
router.get('/', async (req, res) => {
  if (!['ADMIN'].includes(req.user.role)) return res.json({code:403,msg:'权限不足'});
  const { keyword, role, status, page=1, size=20 } = req.query;
  try {
    let where = ['1=1'];
    let binds = [];
    let bi = 1;
    if (keyword) {
      where.push(`(u.USERNAME LIKE :${bi} OR u.REAL_NAME LIKE :${bi + 1})`);
      binds.push(`%${keyword}%`, `%${keyword}%`);
      bi += 2;
    }
    if (role) {
      where.push(`u.ROLE=:${bi}`);
      binds.push(role);
      bi++;
    }
    if (status !== undefined && status !== '') {
      where.push(`u.STATUS=:${bi}`);
      binds.push(Number(status));
      bi++;
    }
    const sql = `SELECT u.USER_ID,u.USERNAME,u.REAL_NAME,u.EMAIL,u.PHONE,u.ROLE,u.STATUS,u.LAST_LOGIN,u.CREATED_AT,
       NVL(r.ROLE_NAME, u.ROLE) AS ROLE_NAME
       FROM SYS_USER u
       LEFT JOIN SYS_ROLE r ON r.ROLE_CODE = u.ROLE
       WHERE ${where.join(' AND ')}
       ORDER BY u.USER_ID`;
    try {
      const data = await db.queryPage(sql, binds, page, size);
      return res.json({ code: 200, data });
    } catch (e) {
      if (!String(e.message || '').includes('00942')) throw e;
      const sqlFallback = `SELECT USER_ID,USERNAME,REAL_NAME,EMAIL,PHONE,ROLE,STATUS,LAST_LOGIN,CREATED_AT,ROLE AS ROLE_NAME
       FROM SYS_USER WHERE ${where.join(' AND ').replace(/u\./g, '')}
       ORDER BY USER_ID`;
      const data = await db.queryPage(sqlFallback, binds, page, size);
      res.json({ code: 200, data });
    }
  } catch(err){ res.json({code:500,msg:err.message}); }
});

// POST /api/users
router.post('/', async (req, res) => {
  if (!['ADMIN'].includes(req.user.role)) return res.json({code:403,msg:'权限不足'});
  const { username, password, realName, email, phone, role } = req.body;
  if (!username || !password) return res.json({code:400,msg:'用户名和密码不能为空'});
  try {
    const exist = await db.execute(`SELECT USER_ID FROM SYS_USER WHERE USERNAME=:1`,[username]);
    if (exist.rows.length) return res.json({code:400,msg:'用户名已存在'});
    const hash = await bcrypt.hash(password, 10);
    await db.execute(
      `INSERT INTO SYS_USER(USERNAME,PASSWORD_HASH,REAL_NAME,EMAIL,PHONE,ROLE,STATUS,TENANT_ID)
       VALUES(:1,:2,:3,:4,:5,:6,1,:7)`,
      [username,hash,realName,email,phone,role||'VIEWER',req.user.tenantId]
    );
    await db.execute(
      `INSERT INTO SYS_AUDIT_LOG(USER_ID,USERNAME,ACTION,"RESOURCE",STATUS) VALUES(:1,:2,:3,:4,:5)`,
      [req.user.userId,req.user.username,'CREATE_USER',username,'SUCCESS']
    );
    res.json({ code:200, msg:'用户创建成功' });
  } catch(err){ res.json({code:500,msg:err.message}); }
});

// PUT /api/users/:id
router.put('/:id', async (req, res) => {
  if (!['ADMIN'].includes(req.user.role)) return res.json({code:403,msg:'权限不足'});
  const { realName, email, phone, role, status } = req.body;
  try {
    await db.execute(
      `UPDATE SYS_USER SET REAL_NAME=:1,EMAIL=:2,PHONE=:3,ROLE=:4,STATUS=:5,UPDATED_AT=SYSTIMESTAMP WHERE USER_ID=:6`,
      [realName,email,phone,role,status,req.params.id]
    );
    res.json({ code:200, msg:'更新成功' });
  } catch(err){ res.json({code:500,msg:err.message}); }
});

// POST /api/users/:id/disable
router.post('/:id/disable', async (req, res) => {
  if (!['ADMIN'].includes(req.user.role)) return res.json({code:403,msg:'权限不足'});
  if (Number(req.params.id) === req.user.userId) return res.json({code:400,msg:'不能禁用自身账号'});
  try {
    await db.execute(`UPDATE SYS_USER SET STATUS=0,UPDATED_AT=SYSTIMESTAMP WHERE USER_ID=:1`,[req.params.id]);
    res.json({ code:200, msg:'账号已禁用' });
  } catch(err){ res.json({code:500,msg:err.message}); }
});

// POST /api/users/:id/enable
router.post('/:id/enable', async (req, res) => {
  if (!['ADMIN'].includes(req.user.role)) return res.json({code:403,msg:'权限不足'});
  try {
    await db.execute(`UPDATE SYS_USER SET STATUS=1,UPDATED_AT=SYSTIMESTAMP WHERE USER_ID=:1`,[req.params.id]);
    res.json({ code:200, msg:'账号已启用' });
  } catch(err){ res.json({code:500,msg:err.message}); }
});

// GET /api/users/audit  审计日志
router.get('/audit', async (req, res) => {
  if (!['ADMIN'].includes(req.user.role)) return res.json({code:403,msg:'权限不足'});
  const { userId, action, page=1, size=20 } = req.query;
  try {
    let where=['1=1']; let binds=[]; let bi=1;
    if (userId) { where.push(`USER_ID=:${bi}`);  binds.push(Number(userId)); bi++; }
    if (action) { where.push(`ACTION=:${bi}`);   binds.push(action); bi++; }
    const sql = `SELECT * FROM SYS_AUDIT_LOG WHERE ${where.join(' AND ')} ORDER BY CREATED_AT DESC`;
    const data = await db.queryPage(sql, binds, page, size);
    res.json({ code:200, data });
  } catch(err){ res.json({code:500,msg:err.message}); }
});

module.exports = router;
