// Thin mode: pure TCP to Oracle, no Oracle Instant Client on the app machine (Oracle DB 12.1+).
// Set NODE_ORACLEDB_DRIVER_MODE=thick only if you intentionally use Instant Client.
if (!process.env.NODE_ORACLEDB_DRIVER_MODE) {
  process.env.NODE_ORACLEDB_DRIVER_MODE = 'thin';
}

const oracledb = require('oracledb');
require('dotenv').config();

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
oracledb.autoCommit = true;
oracledb.fetchAsString = [oracledb.CLOB];

let pool;

function buildConnectString() {
  if (process.env.DB_CONNECT_STRING && String(process.env.DB_CONNECT_STRING).trim()) {
    return String(process.env.DB_CONNECT_STRING).trim();
  }
  const host = process.env.DB_HOST;
  const port = process.env.DB_PORT || '1521';
  const svc = process.env.DB_SERVICE_NAME && String(process.env.DB_SERVICE_NAME).trim();
  const sid = process.env.DB_SID && String(process.env.DB_SID).trim();
  if (svc) return `${host}:${port}/${svc}`;
  if (sid) return `${host}:${port}/${sid}`;
  throw new Error('DB_CONNECT_STRING or (DB_HOST and DB_SERVICE_NAME/DB_SID) must be set');
}

const DEFAULT_POOL = {
  poolMin: 2,
  poolMax: 20,
  poolIncrement: 1,
  poolTimeout: 60,
  queueTimeout: 10000,
};

const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectString: buildConnectString(),
  ...DEFAULT_POOL,
};

function clampPoolConfig({ poolMin, poolMax, poolTimeout }) {
  const max = Math.max(2, Math.min(100, Number(poolMax) || DEFAULT_POOL.poolMax));
  const min = Math.max(1, Math.min(50, Number(poolMin) || DEFAULT_POOL.poolMin));
  const timeout = Math.max(10, Math.min(600, Number(poolTimeout) || DEFAULT_POOL.poolTimeout));
  return {
    poolMin: Math.min(min, max),
    poolMax: max,
    poolTimeout: timeout,
  };
}

async function createPoolInstance() {
  pool = await oracledb.createPool(dbConfig);
  console.log(
    `[DB] Oracle pool OK (${process.env.NODE_ORACLEDB_DRIVER_MODE || 'thin'}) `
    + `min=${dbConfig.poolMin} max=${dbConfig.poolMax} timeout=${dbConfig.poolTimeout}s -> ${dbConfig.connectString}`
  );
  return pool;
}

async function initPool() {
  try {
    return await createPoolInstance();
  } catch (err) {
    console.error('[DB] 连接池初始化失败:', err.message);
    throw err;
  }
}

async function applyPoolConfigFromSysConfig() {
  try {
    const sysConfig = require('../services/systemConfig');
    const poolMin = await sysConfig.getNumber('db.pool.min', DEFAULT_POOL.poolMin);
    const poolMax = await sysConfig.getNumber('db.pool.max', DEFAULT_POOL.poolMax);
    const poolTimeout = await sysConfig.getNumber('db.pool.timeout_sec', DEFAULT_POOL.poolTimeout);
    const next = clampPoolConfig({ poolMin, poolMax, poolTimeout });

    if (
      pool
      && pool.poolMin === next.poolMin
      && pool.poolMax === next.poolMax
      && pool.poolTimeout === next.poolTimeout
    ) {
      return pool;
    }

    if (pool) {
      await pool.close(0);
      pool = null;
    }

    Object.assign(dbConfig, next);
    return await createPoolInstance();
  } catch (err) {
    console.warn('[DB] 读取 db.pool.* 配置失败，继续使用默认连接池参数:', err.message);
    if (!pool) return initPool();
    return pool;
  }
}

async function getConnection() {
  if (!pool) await initPool();
  return pool.getConnection();
}

async function execute(sql, binds = [], options = {}) {
  let conn;
  try {
    conn = await getConnection();
    const result = await conn.execute(sql, binds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      ...options,
    });
    return result;
  } finally {
    if (conn) await conn.close();
  }
}

/**
 * 在一个事务内执行多条语句：fn(conn) 中用 conn.execute(sql, binds) 执行，全部成功才提交，任一失败回滚。
 * 全局 autoCommit=true 只适合单语句；“先删后插”“改状态 + 写记录”等多步操作必须用这里。
 */
async function withTransaction(fn) {
  let conn;
  try {
    conn = await getConnection();
    const tx = {
      execute: (sql, binds = [], options = {}) => conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT, ...options, autoCommit: false }),
      executeMany: (sql, binds = [], options = {}) => conn.executeMany(sql, binds, { ...options, autoCommit: false }),
    };
    const result = await fn(tx);
    await conn.commit();
    return result;
  } catch (e) {
    if (conn) {
      try { await conn.rollback(); } catch { /* ignore */ }
    }
    throw e;
  } finally {
    if (conn) await conn.close();
  }
}

async function executeMany(sql, binds = []) {
  let conn;
  try {
    conn = await getConnection();
    return await conn.executeMany(sql, binds);
  } finally {
    if (conn) await conn.close();
  }
}

// 带分页的查询
// [fix] page/size 来自 req.query 时是字符串：(page-1)*size 得到数字，但 offset + size 会变成字符串拼接
// （page=2,size=20 → "2020"，一次返回 2000 行），且原值直接拼进 SQL。这里统一转成受限整数。
function toPageInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

async function queryPage(sql, binds = [], page = 1, size = 20) {
  page = toPageInt(page, 1, 1, 1000000);
  size = toPageInt(size, 20, 1, 500);
  const offset = (page - 1) * size;
  const countSql = `SELECT COUNT(*) AS TOTAL FROM (${sql})`;
  const pageSql = `SELECT * FROM (SELECT t.*, ROWNUM RN FROM (${sql}) t WHERE ROWNUM <= ${offset + size}) WHERE RN > ${offset}`;

  const [countResult, dataResult] = await Promise.all([
    execute(countSql, binds),
    execute(pageSql, binds),
  ]);

  return {
    total: countResult.rows[0].TOTAL,
    page: Number(page),
    size: Number(size),
    list: dataResult.rows,
  };
}

// 获取连接池统计
async function getPoolStats() {
  if (!pool) return null;
  return {
    connectionsOpen: pool.connectionsOpen,
    connectionsInUse: pool.connectionsInUse,
    poolMin: pool.poolMin,
    poolMax: pool.poolMax,
  };
}

/** INSERT RETURNING 的 NUMBER 出参（位置绑定 outBinds[0][0] 或命名绑定 outBinds.rid） */
function pluckOutBind(result, name) {
  const ob = result?.outBinds;
  if (ob == null) return null;
  let raw = name != null ? ob[name] : undefined;
  if (raw == null && Array.isArray(ob) && ob.length) raw = ob[0];
  if (raw == null) {
    const k = Object.keys(ob).find((key) => ob[key] != null);
    if (k) raw = ob[k];
  }
  if (raw == null) return null;
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  initPool,
  applyPoolConfigFromSysConfig,
  getConnection,
  execute,
  executeMany,
  withTransaction,
  queryPage,
  toPageInt,
  getPoolStats,
  pluckOutBind,
};
