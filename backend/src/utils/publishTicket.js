/**
 * 发布工单公共逻辑：自动发布（automation.js）与 SQL 评审（sqlReview.js）共用。
 * 原“SQL 治理中心 → 推送发布”已并入 SQL 评审：评审通过的工单一键推送到自动发布流程。
 */
const db = require('../config/db');
const { buildPublishReviewResult } = require('./sqlAuditRecord');

function genTicketNo() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `PUB-${ymd}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
}

/**
 * 由审核记录生成发布工单（REVIEWING 状态，进入自动发布审批）。
 * 风险 HIGH / CRITICAL 不允许直接推送。
 * @returns {{ticketNo, fullScanDetected}}
 */
async function createPublishTicketFromAudit({ auditId, sqlText, instanceId, title, ticketType, userId }) {
  const ar = await db.execute(`SELECT AUDIT_ID, INSTANCE_ID, SQL_TEXT, RISK_LEVEL, AUDIT_RESULT FROM SQL_AUDIT_RECORD WHERE AUDIT_ID=:1`, [auditId],
    { fetchAsString: [require('oracledb').CLOB] });
  if (!ar.rows.length) {
    const e = new Error('审核记录不存在，请先执行自动审核');
    e.code = 404;
    throw e;
  }
  const record = ar.rows[0];
  if (!['LOW', 'MEDIUM'].includes(record.RISK_LEVEL)) {
    const e = new Error(`风险等级 ${record.RISK_LEVEL} 不允许直接推送发布，请先优化 SQL`);
    e.code = 400;
    throw e;
  }
  const reviewResult = buildPublishReviewResult(record.AUDIT_RESULT);
  let reviewJson;
  try { reviewJson = JSON.parse(reviewResult); } catch { reviewJson = {}; }
  const fullScan = !!reviewJson.fullScanDetected;
  const ticketNo = genTicketNo();
  const day = new Date().toISOString().split('T')[0];
  await db.execute(
    `INSERT INTO PUBLISH_TICKET
       (TICKET_NO,TITLE,TICKET_TYPE,INSTANCE_ID,SQL_CONTENT,RISK_LEVEL,REVIEW_RESULT,GOVERNANCE_AUDIT_ID,ENV,STATUS,SUBMITTED_BY)
     VALUES (:1,:2,:3,:4,:5,:6,:7,:8,'PROD','REVIEWING',:9)`,
    [ticketNo, title || (fullScan ? `[SQL评审·全表扫描] ${day}` : `[SQL评审推送] ${day}`), ticketType || 'SQL_PUBLISH',
      instanceId || record.INSTANCE_ID, sqlText || record.SQL_TEXT, record.RISK_LEVEL, reviewResult, record.AUDIT_ID, userId]
  );
  return { ticketNo, fullScanDetected: fullScan };
}

module.exports = { genTicketNo, createPublishTicketFromAudit };
