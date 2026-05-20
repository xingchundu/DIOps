/**
 * CheckV8 巡检执行与落库（供 automation 路由与定时批次复用）。
 */
const oracledb = require('oracledb');
const db = require('../config/db');
const { getTargetOracleConnection } = require('../utils/targetOracleConn');
const { runCheckV8Inspection } = require('./checkV8OracleInspect');
const { buildCheckV8DocxBuffer } = require('./checkV8WordReport');
const { automationLog } = require('./automationExecLog');

/** Oracle CLOB 列可能为 string 或 Lob，统一为字符串 */
async function readClobAsString(val) {
  if (val == null || val === '') return '';
  if (typeof val === 'string') return val;
  if (Buffer.isBuffer(val)) return val.toString('utf8');
  try {
    if (typeof val.getData === 'function') return String(await val.getData());
  } catch (_) { /* ignore */ }
  return String(val);
}

/** 写入 CheckV8 报告表（含可选 Word BLOB）+ INSPECT_RESULT 摘要行，单事务 */
async function persistCheckV8Report(req, opts) {
  const {
    instanceId = null,
    batchId = null,
    payload,
    targetLabel = null,
    rowNum = null,
    docxBuffer = null,
  } = opts;
  const summaryText = payload.issues && payload.issues.length
    ? payload.issues.slice(0, 8).join(' | ').slice(0, 3990)
    : `score=${payload.overallScore}`;
  const detail = `CheckV8 ${payload.overallScore}分 ${payload.overallStatus}: ${(payload.issues || []).slice(0, 2).join('; ')}`.slice(0, 1020);

  const conn = await db.getConnection();
  try {
    const ins = await conn.execute(
      `INSERT INTO INSPECT_CHECKV8_REPORT (INSTANCE_ID,BATCH_ID,ROW_NUM,TARGET_LABEL,OVERALL_SCORE,OVERALL_STATUS,SUMMARY,PAYLOAD,CREATED_BY)
       VALUES (:instanceId,:batchId,:rowNum,:tlabel,:os,:ost,:summary,:payload,:cby)
       RETURNING REPORT_ID INTO :rid`,
      {
        instanceId,
        batchId,
        rowNum,
        tlabel: targetLabel,
        os: payload.overallScore,
        ost: payload.overallStatus,
        summary: summaryText,
        payload: JSON.stringify(payload),
        cby: req.user?.userId ?? null,
        rid: { type: oracledb.NUMBER, dir: oracledb.BIND_OUT },
      },
      { autoCommit: false }
    );
    const reportId = ins.outBinds.rid[0];
    if (docxBuffer && Buffer.isBuffer(docxBuffer) && docxBuffer.length > 0) {
      await conn.execute(
        `UPDATE INSPECT_CHECKV8_REPORT SET DOCX_BLOB=:b WHERE REPORT_ID=:id`,
        { b: docxBuffer, id: reportId },
        { autoCommit: false }
      );
    }
    await conn.execute(
      `INSERT INTO INSPECT_RESULT (INSTANCE_ID,BATCH_ID,CHECK_ITEM,STATUS,SCORE,DETAIL)
       VALUES (:i,:b,'CHECKV8_ORACLE',:st,:sc,:d)`,
      { i: instanceId, b: batchId, st: payload.overallStatus, sc: payload.overallScore, d: detail },
      { autoCommit: false }
    );
    await conn.commit();
    return reportId;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    await conn.close();
  }
}

async function runCheckV8ForTarget(req, target, batchId, rowNum) {
  let conn;
  try {
    let label = target.remark || '';
    if (target.instanceId != null) {
      const cw = await getTargetOracleConnection(target.instanceId);
      conn = cw.conn;
      const nm = await db.execute(
        `SELECT INSTANCE_NAME FROM CMDB_INSTANCE WHERE INSTANCE_ID=:1`,
        [target.instanceId]
      );
      label = (nm.rows[0] && nm.rows[0].INSTANCE_NAME) || `实例${target.instanceId}`;
    } else {
      const cs = `${target.host}:${target.port}/${target.serviceOrSid}`;
      conn = await oracledb.getConnection({
        user: target.user,
        password: target.password,
        connectString: cs,
      });
      label = label || `${target.host}:${target.port}/${target.serviceOrSid}`;
    }
    const payload = await runCheckV8Inspection(conn);
    let docx;
    try {
      docx = await buildCheckV8DocxBuffer(payload, label);
    } catch (docErr) {
      console.warn('[automation] Word 报告生成失败，仍保存 JSON:', docErr.message);
      docx = null;
    }
    await persistCheckV8Report(req, {
      instanceId: target.instanceId ?? null,
      batchId,
      payload,
      targetLabel: String(label).slice(0, 256),
      rowNum,
      docxBuffer: docx,
    });
    await automationLog(req, 'INSPECT', target.instanceId ?? batchId ?? 0, 'CHECKV8', 'SUCCESS', `score=${payload.overallScore}`);
    return { ok: true, payload };
  } catch (e) {
    const msg = e.message || String(e);
    try {
      await db.execute(
        `INSERT INTO INSPECT_RESULT (INSTANCE_ID,BATCH_ID,CHECK_ITEM,STATUS,SCORE,DETAIL)
         VALUES (:1,:2,'CHECKV8_ORACLE','FAIL',0,:3)`,
        [target.instanceId ?? null, batchId, msg.slice(0, 1020)]
      );
    } catch (_) { /* ignore */ }
    await automationLog(req, 'INSPECT', target.instanceId ?? batchId ?? 0, 'CHECKV8', 'FAILED', msg.slice(0, 500));
    return { ok: false, error: msg };
  } finally {
    if (conn) {
      try { await conn.close(); } catch (_) { /* ignore */ }
    }
  }
}

async function runCheckV8ForInstance(req, instanceId, batchId = null) {
  return runCheckV8ForTarget(req, { instanceId }, batchId, null);
}

module.exports = {
  readClobAsString,
  persistCheckV8Report,
  runCheckV8ForTarget,
  runCheckV8ForInstance,
};
