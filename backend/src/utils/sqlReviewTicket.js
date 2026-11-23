/**
 * 创建 SQL 评审工单（故障自愈 SLOW_QUERY 等后台来源用）。
 * 原来这些 SQL 写进“SQL 治理中心”的审核记录；治理中心已并入 SQL 评审，统一在评审工单里处理。
 * 同一 SQL 资产已有未结束的工单时不重复创建。
 */
const oracledb = require('oracledb');
const db = require('../config/db');
const { insertAuditRecord, auditHash } = require('./sqlAuditRecord');

const OPEN_STATUSES = ['PENDING', 'IN_REVIEW', 'CHANGES_REQUESTED'];

async function findOpenTicket(assetId) {
  if (assetId == null) return null;
  try {
    const r = await db.execute(
      `SELECT TICKET_ID FROM SQL_REVIEW_TICKET WHERE ASSET_ID=:1 AND STATUS IN ('PENDING','IN_REVIEW','CHANGES_REQUESTED') FETCH FIRST 1 ROWS ONLY`,
      [assetId]);
    return r.rows[0]?.TICKET_ID || null;
  } catch {
    return null;   // 未执行迁移（无 ASSET_ID 列）时不去重
  }
}

/**
 * @param audit Java 统一审核结果（可空）
 * @returns {{ticketId, created}}
 */
async function createReviewTicket({ title, sqlText, instanceId, source = 'SLOW_QUERY', priority = 'HIGH', userId, audit, note }) {
  const assetId = audit && audit.assetId != null ? Number(audit.assetId) : null;
  const existing = await findOpenTicket(assetId);
  if (existing) return { ticketId: existing, created: false };
  let auditId = null;
  if (audit) {
    auditId = await insertAuditRecord({ instanceId, sqlText, result: audit, source, userId }).catch(() => null);
  }
  const binds = {
    title: String(title || 'SQL 优化').slice(0, 250), sql: sqlText, hash: auditHash(sqlText, audit), inst: instanceId || null,
    src: source, pri: priority, uid: userId, aid: auditId, score: audit?.score ?? null, risk: audit?.risk || null,
    st: audit ? 'IN_REVIEW' : 'PENDING', asset: assetId, id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
  };
  let r;
  try {
    r = await db.execute(
      `INSERT INTO SQL_REVIEW_TICKET (TITLE, SQL_TEXT, SQL_HASH, INSTANCE_ID, ENVIRONMENT, SOURCE, PRIORITY, SUBMITTED_BY, AUDIT_ID, SCORE, RISK_LEVEL, STATUS, ASSET_ID)
       VALUES (:title, :sql, :hash, :inst, 'PROD', :src, :pri, :uid, :aid, :score, :risk, :st, :asset) RETURNING TICKET_ID INTO :id`, binds);
  } catch (e) {
    if (!/ORA-00904/.test(String(e.message))) throw e;
    delete binds.asset;
    r = await db.execute(
      `INSERT INTO SQL_REVIEW_TICKET (TITLE, SQL_TEXT, SQL_HASH, INSTANCE_ID, ENVIRONMENT, SOURCE, PRIORITY, SUBMITTED_BY, AUDIT_ID, SCORE, RISK_LEVEL, STATUS)
       VALUES (:title, :sql, :hash, :inst, 'PROD', :src, :pri, :uid, :aid, :score, :risk, :st) RETURNING TICKET_ID INTO :id`, binds);
  }
  const raw = r.outBinds?.id;
  const ticketId = Array.isArray(raw) ? raw[0] : raw;
  if (ticketId) {
    await db.execute(`INSERT INTO SQL_REVIEW_COMMENT (TICKET_ID, USER_ID, COMMENT_TEXT, COMMENT_TYPE) VALUES (:1, :2, :3, 'SYSTEM')`,
      [ticketId, userId, String(note || `工单创建，来源: ${source}`).slice(0, 1900)]).catch(() => {});
  }
  return { ticketId, created: true };
}

module.exports = { createReviewTicket, OPEN_STATUSES };
