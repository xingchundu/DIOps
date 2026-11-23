/**
 * 监控中心：从 CMDB 取实例并按类型建立被管库连接（类 Exporter 数据源）
 */
const oracledb = require('oracledb');

let targetThickInited = false;

/** 被管库若 <12.1，node-oracledb Thin 会 NJS-118；有 Instant Client 时自动切 Thick（仅影响本进程被管连接） */
function initThickForTargetIfNeeded() {
  if (targetThickInited) return true;
  const libDir = String(process.env.ORACLE_CLIENT_LIB_DIR || process.env.ORACLE_HOME || '').trim();
  if (!libDir) return false;
  try {
    oracledb.initOracleClient({ libDir });
    targetThickInited = true;
    return true;
  } catch (e) {
    if (/already been initialized/i.test(String(e.message))) {
      targetThickInited = true;
      return true;
    }
    throw e;
  }
}
const mysql = require('mysql2/promise');
const { Client } = require('pg');
const dmdb = require('dmdb');
const sql = require('mssql');
const db = require('../config/db');

/** 解密被管库密码（AES-GCM 新格式 / Base64 旧格式，见 utils/secrets.js） */
function decodeDbPassword(enc) {
  return require('./secrets').decrypt(enc);
}

async function fetchCmdbInstance(instanceId) {
  const r = await db.execute(
    `SELECT INSTANCE_ID, INSTANCE_NAME, HOST_IP, PORT, SID, SERVICE_NAME, DB_USER, DB_PASSWORD, DB_TYPE
     FROM CMDB_INSTANCE WHERE INSTANCE_ID=:1`,
    [instanceId]
  );
  if (!r.rows.length) {
    const e = new Error('实例不存在');
    e.code = 'NOT_FOUND';
    throw e;
  }
  return r.rows[0];
}

async function connectOracle(inst) {
  const t = String(inst.DB_TYPE || '').toUpperCase();
  if (t !== 'ORACLE') throw new Error('非 ORACLE 实例');
  const pwd = decodeDbPassword(inst.DB_PASSWORD);
  const cs = inst.SERVICE_NAME
    ? `${inst.HOST_IP}:${inst.PORT}/${inst.SERVICE_NAME}`
    : `${inst.HOST_IP}:${inst.PORT}/${inst.SID}`;
  const opts = {
    user: inst.DB_USER,
    password: pwd,
    connectString: cs,
    connectTimeout: 20,
  };
  try {
    return await oracledb.getConnection(opts);
  } catch (e) {
    const msg = String(e.message || e);
    if (/NJS-118|NJS-125|not supported by node-oracledb in Thin/i.test(msg)) {
      if (initThickForTargetIfNeeded()) {
        return oracledb.getConnection(opts);
      }
      const err = new Error(
        '被管 Oracle 版本较低，Node Thin 模式不支持（NJS-118）。'
        + ' 平台库可继续 Thin；连被管库请在 config/backend.env 配置 ORACLE_CLIENT_LIB_DIR（Instant Client 路径）'
        + ' 并设置 NODE_ORACLEDB_DRIVER_MODE=thick 后重启。或升级被管库至 12.1+。'
      );
      err.code = 'NJS-118';
      throw err;
    }
    throw e;
  }
}

async function connectMysql(inst) {
  const t = String(inst.DB_TYPE || '').toUpperCase();
  if (t !== 'MYSQL' && t !== 'GOLDENDB') throw new Error('非 MYSQL/GOLDENDB 实例');
  const dbName = inst.SERVICE_NAME || inst.SID || undefined;
  return mysql.createConnection({
    host: inst.HOST_IP,
    port: Number(inst.PORT) || 3306,
    user: inst.DB_USER,
    password: decodeDbPassword(inst.DB_PASSWORD),
    database: dbName || undefined,
    connectTimeout: 20000,
  });
}

async function connectDameng(inst) {
  if (String(inst.DB_TYPE || '').toUpperCase() !== 'DAMENG') throw new Error('非 DAMENG 实例');
  const pwd = decodeDbPassword(inst.DB_PASSWORD);
  const user = encodeURIComponent(String(inst.DB_USER || ''));
  const pass = encodeURIComponent(pwd);
  const host = String(inst.HOST_IP || '').trim();
  const port = Number(inst.PORT) || 5236;
  const connectString = `dm://${user}:${pass}@${host}:${port}`;
  return dmdb.getConnection(connectString);
}

function isPgFamily(t) {
  const u = String(t || '').toUpperCase();
  return u === 'POSTGRESQL' || u === 'PANWEI';
}

async function connectPostgres(inst) {
  if (!isPgFamily(inst.DB_TYPE)) throw new Error('非 POSTGRESQL/PANWEI 实例');
  const database = inst.SERVICE_NAME || inst.SID || 'postgres';
  const client = new Client({
    host: inst.HOST_IP,
    port: Number(inst.PORT) || 5432,
    user: inst.DB_USER,
    password: decodeDbPassword(inst.DB_PASSWORD),
    database,
    connectionTimeoutMillis: 20000,
  });
  await client.connect();
  return client;
}

function isSqlServer(t) {
  const u = String(t || '').toUpperCase();
  return u === 'SQLSERVER' || u === 'MSSQL';
}

async function connectSqlServer(inst) {
  if (!isSqlServer(inst.DB_TYPE)) throw new Error('非 SQLSERVER 实例');
  const database = inst.SERVICE_NAME || inst.SID || 'master';
  const pool = new sql.ConnectionPool({
    server: String(inst.HOST_IP || '').trim(),
    port: Number(inst.PORT) || 1433,
    user: inst.DB_USER,
    password: decodeDbPassword(inst.DB_PASSWORD),
    database,
    options: {
      encrypt: process.env.MSSQL_ENCRYPT === 'true',
      trustServerCertificate: process.env.MSSQL_TRUST_CERT !== 'false',
    },
    pool: {
      max: 2,
      min: 0,
      idleTimeoutMillis: 10000,
    },
    connectionTimeout: 20000,
    requestTimeout: 30000,
  });
  await pool.connect();
  return pool;
}

function normalizeDbType(inst) {
  const t = String(inst.DB_TYPE || '').toUpperCase();
  if (t === 'MSSQL') return 'SQLSERVER';
  return t;
}

module.exports = {
  decodeDbPassword,
  fetchCmdbInstance,
  connectOracle,
  connectMysql,
  connectPostgres,
  connectDameng,
  connectSqlServer,
  normalizeDbType,
  isPgFamily,
  isSqlServer,
};
