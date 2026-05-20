const router = require('express').Router();
const db = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');
const rbacService = require('../services/rbacService');

router.use(authMiddleware);
router.use(requireRole('ADMIN'));

/** GET /api/rbac/menus 全部菜单（分配权限用） */
router.get('/menus', async (req, res) => {
  try {
    const list = await rbacService.listMenus();
    res.json({ code: 200, data: list });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

/** GET /api/rbac/roles */
router.get('/roles', async (req, res) => {
  try {
    const ready = await rbacService.rbacTablesReady();
    if (!ready) {
      return res.json({
        code: 200,
        data: [
          { ROLE_ID: 1, ROLE_CODE: 'ADMIN', ROLE_NAME: '超级管理员', STATUS: 1, IS_SYSTEM: 1, SORT_ORDER: 1 },
          { ROLE_ID: 2, ROLE_CODE: 'DBA', ROLE_NAME: 'DBA', STATUS: 1, IS_SYSTEM: 1, SORT_ORDER: 2 },
          { ROLE_ID: 3, ROLE_CODE: 'OPS', ROLE_NAME: '运维工程师', STATUS: 1, IS_SYSTEM: 1, SORT_ORDER: 3 },
          { ROLE_ID: 4, ROLE_CODE: 'REVIEWER', ROLE_NAME: '审核员', STATUS: 1, IS_SYSTEM: 1, SORT_ORDER: 4 },
          { ROLE_ID: 5, ROLE_CODE: 'VIEWER', ROLE_NAME: '只读用户', STATUS: 1, IS_SYSTEM: 1, SORT_ORDER: 5 },
          { ROLE_ID: 6, ROLE_CODE: 'DEV', ROLE_NAME: '开发人员', STATUS: 1, IS_SYSTEM: 1, SORT_ORDER: 6 },
        ],
      });
    }
    const r = await db.execute(
      `SELECT ROLE_ID, ROLE_CODE, ROLE_NAME, STATUS, IS_SYSTEM, SORT_ORDER, CREATED_AT, UPDATED_AT
       FROM SYS_ROLE ORDER BY SORT_ORDER, ROLE_ID`
    );
    res.json({ code: 200, data: r.rows || [] });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

/** POST /api/rbac/roles */
router.post('/roles', async (req, res) => {
  const { roleCode, roleName, status = 1 } = req.body || {};
  const code = String(roleCode || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '');
  if (!code || code.length > 32) return res.json({ code: 400, msg: '角色代码无效（字母数字下划线，≤32）' });
  if (!roleName || String(roleName).trim().length === 0) return res.json({ code: 400, msg: '请填写角色名称' });
  try {
    const mx = await db.execute(`SELECT NVL(MAX(SORT_ORDER), 0) + 10 AS N FROM SYS_ROLE`);
    const sortOrder = mx.rows[0]?.N ?? mx.rows[0]?.n ?? 100;
    await db.execute(
      `INSERT INTO SYS_ROLE (ROLE_CODE, ROLE_NAME, STATUS, IS_SYSTEM, SORT_ORDER)
       VALUES (:1, :2, :3, 0, :4)`,
      [code, String(roleName).trim(), Number(status) === 0 ? 0 : 1, sortOrder]
    );
    res.json({ code: 200, msg: '角色已创建' });
  } catch (err) {
    if (String(err.message || '').includes('unique')) {
      return res.json({ code: 400, msg: '角色代码已存在' });
    }
    res.json({ code: 500, msg: err.message });
  }
});

/** PUT /api/rbac/roles/:roleId */
router.put('/roles/:roleId', async (req, res) => {
  const roleId = Number(req.params.roleId);
  if (!Number.isFinite(roleId)) return res.json({ code: 400, msg: '无效的角色 ID' });
  const { roleName, status } = req.body || {};
  try {
    const ex = await db.execute(`SELECT ROLE_ID, IS_SYSTEM, ROLE_CODE FROM SYS_ROLE WHERE ROLE_ID = :1`, [roleId]);
    if (!ex.rows.length) return res.json({ code: 404, msg: '角色不存在' });
    const row = ex.rows[0];
    if (Number(row.IS_SYSTEM) === 1 && roleName != null) {
      return res.json({ code: 400, msg: '内置角色不可改名' });
    }
    if (roleName != null && String(roleName).trim().length) {
      await db.execute(`UPDATE SYS_ROLE SET ROLE_NAME = :1, UPDATED_AT = SYSTIMESTAMP WHERE ROLE_ID = :2`, [
        String(roleName).trim(),
        roleId,
      ]);
    }
    if (status !== undefined) {
      const st = Number(status) === 0 ? 0 : 1;
      if (st === 0 && row.ROLE_CODE === 'ADMIN') {
        return res.json({ code: 400, msg: '不能禁用超级管理员角色' });
      }
      await db.execute(`UPDATE SYS_ROLE SET STATUS = :1, UPDATED_AT = SYSTIMESTAMP WHERE ROLE_ID = :2`, [st, roleId]);
    }
    res.json({ code: 200, msg: '已更新' });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

/** DELETE /api/rbac/roles/:roleId */
router.delete('/roles/:roleId', async (req, res) => {
  const roleId = Number(req.params.roleId);
  if (!Number.isFinite(roleId)) return res.json({ code: 400, msg: '无效的角色 ID' });
  try {
    const ex = await db.execute(`SELECT ROLE_ID, IS_SYSTEM, ROLE_CODE FROM SYS_ROLE WHERE ROLE_ID = :1`, [roleId]);
    if (!ex.rows.length) return res.json({ code: 404, msg: '角色不存在' });
    const row = ex.rows[0];
    if (Number(row.IS_SYSTEM) === 1) return res.json({ code: 400, msg: '不能删除内置角色' });
    const cnt = await db.execute(`SELECT COUNT(*) AS C FROM SYS_USER WHERE ROLE = :1`, [row.ROLE_CODE]);
    const n = cnt.rows[0]?.C ?? cnt.rows[0]?.c ?? 0;
    if (Number(n) > 0) return res.json({ code: 400, msg: '仍有用户使用该角色，无法删除' });
    await db.execute(`DELETE FROM SYS_ROLE WHERE ROLE_ID = :1`, [roleId]);
    res.json({ code: 200, msg: '已删除' });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

/** GET /api/rbac/roles/:roleId/menus */
router.get('/roles/:roleId/menus', async (req, res) => {
  const roleId = Number(req.params.roleId);
  if (!Number.isFinite(roleId)) return res.json({ code: 400, msg: '无效的角色 ID' });
  try {
    const ready = await rbacService.rbacTablesReady();
    if (!ready) return res.json({ code: 200, data: { menuIds: [] } });
    const ex = await db.execute(`SELECT ROLE_ID FROM SYS_ROLE WHERE ROLE_ID = :1`, [roleId]);
    if (!ex.rows.length) return res.json({ code: 404, msg: '角色不存在' });
    const r = await db.execute(
      `SELECT m.MENU_ID FROM SYS_MENU m
       INNER JOIN SYS_ROLE_MENU rm ON m.MENU_ID = rm.MENU_ID
       WHERE rm.ROLE_ID = :1
       ORDER BY m.SORT_ORDER, m.MENU_ID`,
      [roleId]
    );
    const menuIds = (r.rows || []).map((row) => row.MENU_ID);
    res.json({ code: 200, data: { menuIds } });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

/** PUT /api/rbac/roles/:roleId/menus  body: { menuIds: number[] } */
router.put('/roles/:roleId/menus', async (req, res) => {
  const roleId = Number(req.params.roleId);
  if (!Number.isFinite(roleId)) return res.json({ code: 400, msg: '无效的角色 ID' });
  const menuIds = Array.isArray(req.body?.menuIds) ? req.body.menuIds.map((x) => Number(x)).filter((x) => Number.isFinite(x)) : [];
  try {
    const ex = await db.execute(`SELECT ROLE_ID, ROLE_CODE FROM SYS_ROLE WHERE ROLE_ID = :1`, [roleId]);
    if (!ex.rows.length) return res.json({ code: 404, msg: '角色不存在' });
    const roleCode = ex.rows[0].ROLE_CODE;
    if (roleCode === 'ADMIN') {
      return res.json({ code: 400, msg: '超级管理员固定拥有全部菜单，无需分配' });
    }
    await db.execute(`DELETE FROM SYS_ROLE_MENU WHERE ROLE_ID = :1`, [roleId]);
    for (const mid of menuIds) {
      await db.execute(`INSERT INTO SYS_ROLE_MENU (ROLE_ID, MENU_ID) VALUES (:1, :2)`, [roleId, mid]);
    }
    res.json({ code: 200, msg: '权限已保存' });
  } catch (err) {
    res.json({ code: 500, msg: err.message });
  }
});

module.exports = router;
