/**
 * 监控中心：从 CMDB 取实例并按类型建立被管库连接（类 Exporter 数据源）
 */
const oracledb = require('oracledb');
const mysql = require('mysql2/promise');
const { Client } = require('pg');
const dmdb = require('dmdb');
const db = require('../config/db');

function decodeDbPassword(enc) {
  if (enc == null || enc === '') return '';
  return Buffer.from(String(enc).replace(/^ENCRYPTED:/i, ''), 'base64').toString('utf8');
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
  return oracledb.getConnection({
    user: inst.DB_USER,
    password: pwd,
    connectString: cs,
  });
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

async function connectPostgres(inst) {
  if (String(inst.DB_TYPE || '').toUpperCase() !== 'POSTGRESQL') throw new Error('非 POSTGRESQL 实例');
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

function normalizeDbType(inst) {
  return String(inst.DB_TYPE || '').toUpperCase();
}

module.exports = {
  decodeDbPassword,
  fetchCmdbInstance,
  connectOracle,
  connectMysql,
  connectPostgres,
  connectDameng,
  normalizeDbType,
};
