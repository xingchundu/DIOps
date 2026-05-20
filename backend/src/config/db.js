// Thin mode: pure TCP to Oracle, no Oracle Instant Client on the app machine (Oracle DB 12.1+).
// Set NODE_ORACLEDB_DRIVER_MODE=thick only if you intentionally use Instant Client.
if (!process.env.NODE_ORACLEDB_DRIVER_MODE) {
  process.env.NODE_ORACLEDB_DRIVER_MODE = 'thin';
}

const oracledb = require('oracledb');
require('dotenv').config();

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
oracledb.autoCommit = true;

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

const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectString: buildConnectString(),
  poolMin: 2,
  poolMax: 20,
  poolIncrement: 1,
  poolTimeout: 60,
  queueTimeout: 10000,
};

async function initPool() {
  try {
    pool = await oracledb.createPool(dbConfig);
    console.log(`[DB] Oracle pool OK (${process.env.NODE_ORACLEDB_DRIVER_MODE || 'thin'}) -> ${dbConfig.connectString}`);
    return pool;
  } catch (err) {
    console.error('[DB] 连接池初始化失败:', err.message);
    throw err;
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
async function queryPage(sql, binds = [], page = 1, size = 20) {
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

module.exports = { initPool, getConnection, execute, executeMany, queryPage, getPoolStats };
