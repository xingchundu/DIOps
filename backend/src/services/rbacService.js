const db = require('../config/db');

/** 与前端侧栏一致；无表时的 ADMIN 兜底 */
const FALLBACK_MENUS_ALL = [
  '/dashboard',
  '/monitor',
  '/monitor/collect-scheduler',
  '/alerts',
  '/cmdb',
  '/automation',
  '/sql',
  '/reports',
  '/ai',
  '/settings/profile',
  '/settings/users',
  '/settings/roles',
];

async function tableExists(tableName) {
  try {
    const r = await db.execute(`SELECT 1 AS X FROM USER_TABLES WHERE TABLE_NAME = UPPER(:1)`, [tableName]);
    return !!(r.rows && r.rows.length);
  } catch {
    return false;
  }
}

let rbacReadyCache = null;
async function rbacTablesReady() {
  if (rbacReadyCache !== null) return rbacReadyCache;
  rbacReadyCache =
    (await tableExists('SYS_ROLE')) &&
    (await tableExists('SYS_MENU')) &&
    (await tableExists('SYS_ROLE_MENU'));
  return rbacReadyCache;
}

/**
 * 某角色可访问的前端路由 path 列表（与 SYS_MENU.MENU_PATH 一致）
 */
async function getMenuPathsForRole(roleCode) {
  const ready = await rbacTablesReady();
  if (!ready) {
    if (roleCode === 'ADMIN') return [...FALLBACK_MENUS_ALL];
    return ['/dashboard', '/settings/profile'];
  }
  if (roleCode === 'ADMIN') {
    const r = await db.execute(`SELECT MENU_PATH FROM SYS_MENU ORDER BY SORT_ORDER, MENU_ID`);
    return (r.rows || []).map((row) => row.MENU_PATH);
  }
  const r = await db.execute(
    `SELECT m.MENU_PATH
     FROM SYS_MENU m
     INNER JOIN SYS_ROLE_MENU rm ON m.MENU_ID = rm.MENU_ID
     INNER JOIN SYS_ROLE ro ON ro.ROLE_ID = rm.ROLE_ID
     WHERE ro.ROLE_CODE = :1 AND ro.STATUS = 1
     ORDER BY m.SORT_ORDER, m.MENU_ID`,
    [roleCode]
  );
  const paths = (r.rows || []).map((row) => row.MENU_PATH);
  if (!paths.length) return ['/dashboard', '/settings/profile'];
  return paths;
}

async function listMenus() {
  const ready = await rbacTablesReady();
  if (!ready) {
    return FALLBACK_MENUS_ALL.map((p, i) => ({
      MENU_ID: i + 1,
      MENU_PATH: p,
      MENU_NAME: p,
      SORT_ORDER: (i + 1) * 10,
    }));
  }
  const r = await db.execute(`SELECT MENU_ID, MENU_PATH, MENU_NAME, SORT_ORDER FROM SYS_MENU ORDER BY SORT_ORDER, MENU_ID`);
  return r.rows || [];
}

module.exports = {
  getMenuPathsForRole,
  listMenus,
  rbacTablesReady,
  FALLBACK_MENUS_ALL,
};
