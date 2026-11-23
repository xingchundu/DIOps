/**
 * 直连被管 Oracle 实例（与 monitor 路由逻辑一致，供 automation 等模块复用）。
 */
const oracledb = require('oracledb');
const db = require('../config/db');

/** 解密被管库密码（AES-GCM 新格式 / Base64 旧格式，见 utils/secrets.js） */
function decodeDbPassword(enc) {
  return require('./secrets').decrypt(enc);
}

async function getTargetOracleConnection(instanceId) {
  const r = await db.execute(
    `SELECT HOST_IP,PORT,SID,SERVICE_NAME,DB_USER,DB_PASSWORD,DB_TYPE FROM CMDB_INSTANCE WHERE INSTANCE_ID=:1`,
    [instanceId]
  );
  if (!r.rows.length) throw new Error('实例不存在');
  const inst = r.rows[0];
  if (inst.DB_TYPE !== 'ORACLE') throw new Error('仅支持 ORACLE 实例');
  const pwd = decodeDbPassword(inst.DB_PASSWORD);
  const cs = inst.SERVICE_NAME
    ? `${inst.HOST_IP}:${inst.PORT}/${inst.SERVICE_NAME}`
    : `${inst.HOST_IP}:${inst.PORT}/${inst.SID}`;
  const conn = await oracledb.getConnection({ user: inst.DB_USER, password: pwd, connectString: cs });
  return { conn, inst };
}

module.exports = { getTargetOracleConnection };
