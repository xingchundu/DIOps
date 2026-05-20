/**
 * 自动化运维统一执行摘要（AUTOMATION_EXEC_LOG）。
 */
const db = require('../config/db');

async function automationLog(req, category, refId, action, status, message) {
  try {
    await db.execute(
      `INSERT INTO AUTOMATION_EXEC_LOG (CATEGORY,REF_ID,ACTION,STATUS,MESSAGE,CREATED_BY)
       VALUES (:1,:2,:3,:4,:5,:6)`,
      [
        category,
        refId ?? null,
        action,
        status,
        message ? String(message).slice(0, 2000) : null,
        req.user?.userId ?? null,
      ]
    );
  } catch (e) {
    console.warn('[automation] AUTOMATION_EXEC_LOG insert skipped:', e.message);
  }
}

module.exports = { automationLog };
