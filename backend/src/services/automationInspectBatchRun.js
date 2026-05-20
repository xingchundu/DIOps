/**
 * 自动化巡检批次执行（手动 API 与定时调度共用）。
 */
const db = require('../config/db');
const { validateTarget } = require('./inspectExcelService');
const { readClobAsString, runCheckV8ForTarget } = require('./automationCheckV8Runner');
const { automationLog } = require('./automationExecLog');

const runningBatchIds = new Set();

/**
 * @param {*} req Express req（可为调度器合成的假 req）
 * @param {number} bid BATCH_ID
 * @returns {Promise<{ batchId:number, results: Array, skipped?: string }>}
 */
async function runInspectBatchById(req, bid) {
  if (runningBatchIds.has(bid)) {
    return {
      batchId: bid,
      results: [],
      skipped: `批次 ${bid} 正在执行中，跳过本次触发`,
    };
  }
  runningBatchIds.add(bid);
  try {
    const b = await db.execute(
      `SELECT INSTANCE_IDS, EXCEL_TARGETS, NVL(SOURCE_TYPE,'MANUAL') AS SOURCE_TYPE
       FROM AUTOMATION_INSPECT_BATCH WHERE BATCH_ID=:1`,
      [bid]
    );
    if (!b.rows.length) {
      const e = new Error('批次不存在');
      e.code = 'NOT_FOUND';
      throw e;
    }
    const row = b.rows[0];

    await db.execute(
      `UPDATE AUTOMATION_INSPECT_BATCH SET STATUS='RUNNING', LAST_RUN_AT=SYSTIMESTAMP WHERE BATCH_ID=:1`,
      [bid]
    );

    try {
      let targets = [];
      const excelRaw = await readClobAsString(row.EXCEL_TARGETS);
      if (excelRaw != null && String(excelRaw).trim()) {
        try {
          targets = JSON.parse(excelRaw);
        } catch {
          await db.execute(
            `UPDATE AUTOMATION_INSPECT_BATCH SET STATUS='FAILED', LAST_RUN_AT=SYSTIMESTAMP WHERE BATCH_ID=:1`,
            [bid]
          );
          const err = new Error('批次 Excel 配置解析失败');
          err.code = 'PARSE_ERROR';
          throw err;
        }
      } else {
        const ids = String(row.INSTANCE_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
        const list = ids.length ? ids : ['1'];
        targets = list.map((id) => ({ instanceId: Number(id) }));
      }

      const results = [];
      for (let i = 0; i < targets.length; i++) {
        const raw = targets[i] || {};
        let t;
        try {
          t = validateTarget(raw, i + 1);
        } catch (ve) {
          results.push({ row: i + 1, ok: false, error: ve.message });
          continue;
        }
        if (t.instanceId != null) {
          const typ = await db.execute(
            `SELECT DB_TYPE, INSTANCE_NAME FROM CMDB_INSTANCE WHERE INSTANCE_ID=:1`,
            [t.instanceId]
          );
          if (!typ.rows.length) {
            results.push({ row: i + 1, instanceId: t.instanceId, ok: false, error: '实例不存在' });
            continue;
          }
          if (typ.rows[0].DB_TYPE !== 'ORACLE') {
            await db.execute(
              `INSERT INTO INSPECT_RESULT (INSTANCE_ID,BATCH_ID,CHECK_ITEM,STATUS,SCORE,DETAIL)
               VALUES (:1,:2,'AUTO_BATCH_SKIP','PASS',100,:3)`,
              [t.instanceId, bid, `非Oracle(${typ.rows[0].DB_TYPE})，跳过 CheckV8`.slice(0, 1020)]
            );
            results.push({ row: i + 1, instanceId: t.instanceId, skipped: true, reason: '非ORACLE' });
            continue;
          }
        }
        const r = await runCheckV8ForTarget(req, t, bid, i + 1);
        results.push({
          row: i + 1,
          instanceId: t.instanceId ?? null,
          ok: r.ok,
          score: r.payload?.overallScore,
          status: r.payload?.overallStatus,
          error: r.error,
        });
      }
      await db.execute(
        `UPDATE AUTOMATION_INSPECT_BATCH SET STATUS='SUCCESS', LAST_RUN_AT=SYSTIMESTAMP WHERE BATCH_ID=:1`,
        [bid]
      );
      await automationLog(req, 'INSPECT', bid, 'BATCH_RUN_CHECKV8', 'SUCCESS', `n=${results.length}`);
      return { batchId: bid, results };
    } catch (e) {
      try {
        await db.execute(
          `UPDATE AUTOMATION_INSPECT_BATCH SET STATUS='FAILED', LAST_RUN_AT=SYSTIMESTAMP WHERE BATCH_ID=:1`,
          [bid]
        );
      } catch (_) { /* ignore */ }
      throw e;
    }
  } finally {
    runningBatchIds.delete(bid);
  }
}

module.exports = { runInspectBatchById, runningBatchIds };
