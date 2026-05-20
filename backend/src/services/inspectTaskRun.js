/**
 * inspectTaskRun.js
 *
 * 巡检任务执行：
 *   1. 若任务配置了 INSPECT_SCRIPT 脚本，连接目标库执行 SQL，生成 JSON 分析报告（落库）
 *   2. 无论是否有脚本，始终调用 db_inspection_headless.py，
 *      使用 master inspection SQL 模板文件生成 5 份格式完整的 Word 报告（与 db_inspection.py 一致）
 *   3. Word 文件路径写入 INSPECT_REPORT.PAYLOAD，供下载路由读取
 *
 * 修改说明（v2.1）：
 *   - 脚本（INSPECT_SCRIPT）变为可选；无脚本时跳过 JSON 执行，仍生成 Word
 *   - Python Word 生成改为优先使用 templates/inspect/ 模板文件
 *   - 新增 DaMeng 连接支持
 */
'use strict';

const oracledb = require('oracledb');
const db       = require('../config/db');
const {
  fetchCmdbInstance,
  connectOracle,
  connectMysql,
  connectPostgres,
  normalizeDbType,
} = require('../utils/monitorTargetConn');
const { executeInspectScript } = require('./inspectScriptExecutor');
const { runCheckV8Inspection  } = require('./checkV8OracleInspect');
const { automationLog         } = require('./automationExecLog');
const { runDbInspectionPythonWord } = require('./inspectPythonDocxRunner');

const runningInspectTasks = new Set();

const INSPECT_REPORT_TYPES = ['HEALTH', 'RISK', 'PARAMETER', 'SPACE', 'HA'];

function inspectLog(verboseConsole, session, ...args) {
  const line = args
    .map((a) =>
      typeof a === 'string' ? a : JSON.stringify(a, (k, v) => (typeof v === 'bigint' ? String(v) : v))
    )
    .join(' ');
  const ts = new Date().toISOString();
  if (verboseConsole) console.log(`[inspect-task] ${ts} ${line}`);
  if (session?.logs) session.logs.push(`${ts} ${line}`);
}

function attachInspectSession(err, session) {
  if (!session || !err) return;
  if (err.inspectLogs     == null) err.inspectLogs     = session.logs;
  if (err.inspectSqlErrors == null) err.inspectSqlErrors = session.sqlErrors;
  if (err.inspectReportIds == null) err.inspectReportIds = session.reportIds;
}

function safeJson(str) {
  try { return typeof str === 'string' ? JSON.parse(str) : str; }
  catch { return []; }
}

async function fetchTopWaitsOracle(conn) {
  try {
    const r = await conn.execute(
      `SELECT * FROM (
         SELECT event, total_waits AS waits, ROUND(time_waited/100,2) AS time_sec
         FROM v$system_event WHERE NVL(wait_class,'x') != 'Idle'
         ORDER BY time_waited DESC
       ) WHERE ROWNUM <= 5`,
      [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return (r.rows || []).map((row) => ({
      event: row.EVENT, waits: row.WAITS, time_sec: row.TIME_SEC,
    }));
  } catch { return []; }
}

async function loadInspectScriptsByIds(ids) {
  if (!ids || !ids.length) return [];
  const nums = [...new Set(ids.map(Number).filter(Number.isFinite))];
  if (!nums.length) return [];
  const ph = nums.map((_, i) => `:${i + 1}`).join(',');
  const r = await db.execute(
    `SELECT SCRIPT_ID, SCRIPT_NAME, DB_TYPE, CATEGORY, SCRIPT_CONTENT, NVL(ENABLED,1) AS EN
     FROM INSPECT_SCRIPT WHERE SCRIPT_ID IN (${ph})`,
    nums,
    { fetchInfo: { SCRIPT_CONTENT: { type: oracledb.STRING, maxSize: 52 * 1024 * 1024 } } }
  );
  return (r.rows || []).filter((row) => Number(row.EN) !== 0);
}

function scoreFromInspect(oracleEnrichment, scriptErrors, scriptSections) {
  let score = 100;
  if (oracleEnrichment?.overallScore != null) score = Number(oracleEnrichment.overallScore);
  score -= (scriptErrors || []).length * 8;
  for (const s of (scriptSections || [])) {
    for (const tb of (s.tables || [])) {
      for (const row of (tb.rows || [])) {
        for (const v of Object.values(row)) {
          if (/ORA-\d{5}|CRITICAL|严重|紧急/.test(String(v || ''))) score -= 3;
        }
      }
    }
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  const status = score < 70 ? 'CRITICAL' : score < 85 ? 'WARNING' : 'NORMAL';
  return { score, status };
}

function mapOracleStatusForDb(s) {
  const u = String(s || '').toUpperCase();
  if (u === 'PASS') return 'NORMAL';
  if (u === 'WARN' || u === 'WARNING') return 'WARNING';
  if (u === 'FAIL' || u === 'CRITICAL') return 'CRITICAL';
  return 'NORMAL';
}

async function runWithConnection(
  dbType, conn, task, instRow, category,
  mergedSql, userId, oracleEnrichment, verboseLog, session
) {
  const hasScript = String(mergedSql || '').trim().length > 0;
  inspectLog(verboseLog, session,
    `执行脚本 START task=${task.TASK_ID} inst=${instRow.INSTANCE_NAME}(${instRow.INSTANCE_ID}) type=${category} db=${dbType} sqlChars=${mergedSql.length}`);

  const { sections, errors } = hasScript
    ? await executeInspectScript(dbType, conn, mergedSql)
    : { sections: [], errors: [] };

  inspectLog(verboseLog, session,
    `执行脚本 END task=${task.TASK_ID} inst=${instRow.INSTANCE_NAME} sections=${sections.length} sqlErrors=${errors.length}`);

  if (errors.length) {
    errors.forEach((err, i) => {
      const sqlPreview = (err.sql || '').replace(/\s+/g, ' ').slice(0, 200);
      inspectLog(verboseLog, session, `  SQL错误[${i+1}]: ${err.error || err}`);
      inspectLog(verboseLog, session, `    片段: ${sqlPreview}${(err.sql || '').length > 200 ? '…' : ''}`);
      if (session?.sqlErrors) {
        session.sqlErrors.push({
          instanceId:   instRow.INSTANCE_ID,
          instanceName: instRow.INSTANCE_NAME,
          category,
          error:      err.error || String(err),
          sqlPreview: (err.sql || '').slice(0, 800),
        });
      }
    });
  }

  const payloadObj = {
    engine:          'inspect-task-v2',
    dbType,
    reportType:      category,
    taskId:          task.TASK_ID,
    taskName:        task.TASK_NAME,
    instanceId:      instRow.INSTANCE_ID,
    instanceName:    instRow.INSTANCE_NAME,
    checkedAt:       new Date().toISOString(),
    checkedAtLocal:  new Date().toLocaleString('zh-CN', { hour12: false }),
    scriptSections:  sections,
    scriptErrors:    errors,
    oracleEnrichment: dbType === 'ORACLE' && hasScript ? oracleEnrichment : undefined,
    inspectorName:   userId != null ? `用户#${userId}` : 'AUTOMATION',
  };

  const enrichForScore = hasScript ? oracleEnrichment : null;
  const { score, status } = scoreFromInspect(enrichForScore, errors, sections);
  const oracleSt = enrichForScore ? mapOracleStatusForDb(oracleEnrichment.overallStatus) : status;
  let finalStatus = oracleSt;
  if (errors.length && oracleSt !== 'CRITICAL' && status === 'CRITICAL') finalStatus = 'CRITICAL';
  else if (errors.length && finalStatus === 'NORMAL') finalStatus = 'WARNING';

  payloadObj.overallScore  = score;
  payloadObj.overallStatus = finalStatus;
  payloadObj.summary = hasScript
    ? `${instRow.INSTANCE_NAME} ${category} 巡检完成；脚本语句错误 ${errors.length} 条，分段 ${sections.length}`
    : `${instRow.INSTANCE_NAME} ${category} Word巡检报告（db_inspection.py 生成）`;

  const ins = await db.execute(
    `INSERT INTO INSPECT_REPORT
       (TASK_ID,INSTANCE_ID,DB_TYPE,REPORT_TYPE,OVERALL_SCORE,OVERALL_STATUS,SUMMARY,PAYLOAD,CREATED_BY)
     VALUES (:taskId,:instanceId,:dbType,:reportType,:score,:finalStatus,:summaryText,:payload,:userId)
     RETURNING REPORT_ID INTO :rid`,
    {
      taskId:      task.TASK_ID,
      instanceId:  instRow.INSTANCE_ID,
      dbType,
      reportType:  category,
      score,
      finalStatus,
      summaryText: payloadObj.summary.slice(0, 3900),
      payload:     JSON.stringify(payloadObj),
      userId,
      rid: { type: oracledb.NUMBER, dir: oracledb.BIND_OUT },
    }
  );
  const reportId = ins?.outBinds?.rid?.[0];
  if (session?.reportIds && reportId != null) session.reportIds.push(Number(reportId));
  return reportId != null ? Number(reportId) : null;
}

async function attachInspectDocxToPayload(reportId, inspectDocxFile) {
  if (reportId == null || !inspectDocxFile) return;
  const r = await db.execute(
    `SELECT PAYLOAD FROM INSPECT_REPORT WHERE REPORT_ID=:1`, [reportId],
    { fetchInfo: { PAYLOAD: { type: oracledb.STRING, maxSize: 52 * 1024 * 1024 } } }
  );
  if (!r.rows.length) return;
  let payloadObj = {};
  try { payloadObj = JSON.parse(r.rows[0].PAYLOAD || '{}'); } catch { payloadObj = {}; }
  payloadObj.inspectDocxFile   = String(inspectDocxFile);
  payloadObj.inspectDocxEngine = 'db_inspection_py';
  await db.execute(
    `UPDATE INSPECT_REPORT SET PAYLOAD=:1 WHERE REPORT_ID=:2`,
    [JSON.stringify(payloadObj), reportId]
  );
}

/**
 * 执行巡检任务。
 *
 * 脚本（INSPECT_SCRIPT）现为可选：
 *   - 有脚本 → 执行 SQL JSON 报告 + Python Word 报告（5份）
 *   - 无脚本 → 仅生成 Python Word 报告（5份，使用模板 SQL 直连目标库）
 */
async function runInspectTaskById(req, taskId, options = {}) {
  const verboseLog = !!options.verboseLog;
  const session    = options.collectLogs ? { logs: [], sqlErrors: [], reportIds: [] } : null;

  if (runningInspectTasks.has(taskId)) {
    const busy = Object.assign(new Error('任务正在执行中，请稍后再试'), { code: 'BUSY' });
    attachInspectSession(busy, session);
    throw busy;
  }

  const tr = await db.execute(`SELECT * FROM INSPECT_TASK WHERE TASK_ID=:1`, [taskId]);
  if (!tr.rows.length) {
    const e = Object.assign(new Error('任务不存在'), { code: 'NOT_FOUND' });
    attachInspectSession(e, session);
    throw e;
  }

  const task        = tr.rows[0];
  const instanceIds = safeJson(task.INSTANCE_IDS) || [];
  const scriptIds   = safeJson(task.SCRIPT_IDS)   || [];

  if (!instanceIds.length) {
    const e = Object.assign(new Error('任务未配置目标实例'), { code: 'BAD_TASK' });
    attachInspectSession(e, session);
    throw e;
  }

  // 脚本可选：有则加载，无则跳过 SQL 执行，直接生成 Word
  const scripts = scriptIds.length ? await loadInspectScriptsByIds(scriptIds) : [];
  const hasScripts = scripts.length > 0;

  if (!hasScripts) {
    inspectLog(verboseLog, session,
      `任务 ${taskId} 未配置脚本，将直接使用 master inspection 模板生成 Word 报告`);
  }

  const byCat = new Map();
  for (const s of scripts) {
    const raw = String(s.CATEGORY || 'HEALTH').toUpperCase();
    const cat = INSPECT_REPORT_TYPES.includes(raw) ? raw : 'HEALTH';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(s);
  }

  inspectLog(verboseLog, session,
    `开始 taskId=${taskId} name=${task.TASK_NAME} instances=[${instanceIds.join(',')}] ` +
    `scriptIds=[${scriptIds.join(',')}] categories=[${[...byCat.keys()].join(',') || '—'}]`);

  // 合并 SQL（供旧有 headless 代码使用；模板文件优先级更高）
  const mergedFullSql = INSPECT_REPORT_TYPES.map((cat) => {
    const list = byCat.get(cat) || [];
    return list.map((x) => String(x.SCRIPT_CONTENT || '')).join('\n\n-- ---- script ----\n\n');
  }).join('\n\n');

  runningInspectTasks.add(taskId);
  try {
    await db.execute(
      `UPDATE INSPECT_TASK SET STATUS='RUNNING', LAST_RUN_AT=SYSTIMESTAMP WHERE TASK_ID=:1`,
      [taskId]
    );

    const uid = req.user?.userId ?? null;
    let reports = 0;

    try {
      for (const instId of instanceIds) {
        inspectLog(verboseLog, session, `实例 CONNECT id=${instId}`);
        const inst   = await fetchCmdbInstance(instId);
        const dbType = normalizeDbType(inst);
        inspectLog(verboseLog, session, `实例 OK name=${inst.INSTANCE_NAME} dbType=${dbType}`);

        let oracleConn = null;
        let mysqlConn  = null;
        let pgClient   = null;

        try {
          if (hasScripts) {
            // 只在有脚本时才需要直连目标库执行 SQL
            if (dbType === 'ORACLE') {
              oracleConn = await connectOracle(inst);
            } else if (dbType === 'MYSQL' || dbType === 'GOLDENDB') {
              mysqlConn = await connectMysql(inst);
            } else if (dbType === 'POSTGRESQL') {
              pgClient = await connectPostgres(inst);
            }
            inspectLog(verboseLog, session, `目标库连接已建立（脚本执行模式）`);
          } else {
            inspectLog(verboseLog, session,
              `无脚本，跳过直连 SQL 执行；将由 db_inspection.py 自行连接目标库`);
          }

          let oracleEnrichment = null;
          if (dbType === 'ORACLE' && oracleConn) {
            inspectLog(verboseLog, session, `Oracle 采集 enrichment（CheckV8 + 等待事件）…`);
            const base        = await runCheckV8Inspection(oracleConn);
            const wait_events = await fetchTopWaitsOracle(oracleConn);
            oracleEnrichment  = { ...base, wait_events };
            inspectLog(verboseLog, session,
              `Oracle enrichment 完成 score=${oracleEnrichment.overallScore} status=${oracleEnrichment.overallStatus} waits=${wait_events.length}`);
          }

          const conn = oracleConn || mysqlConn || pgClient;

          // ── 生成 JSON 分析报告（有脚本时执行）──────────────────
          const reportIdsByCat = {};
          for (const category of INSPECT_REPORT_TYPES) {
            const list = byCat.get(category) || [];

            if (hasScripts && list.length) {
              // 校验脚本 DB_TYPE 匹配
              for (const row of list) {
                const sdb = String(row.DB_TYPE || '').toUpperCase();
                if (sdb !== dbType) {
                  throw new Error(`脚本「${row.SCRIPT_NAME}」DB_TYPE=${row.DB_TYPE} 与实例 ${dbType} 不匹配`);
                }
              }
            }

            const mergedSql = list.length
              ? list.map((x) => String(x.SCRIPT_CONTENT || '')).join('\n\n-- ---- script ----\n\n')
              : '';

            // 有脚本时执行 SQL；无脚本时也创建占位报告行（供 Word 路径挂载）
            const rid = await runWithConnection(
              dbType, conn, task, inst, category,
              mergedSql, uid, oracleEnrichment, verboseLog, session
            );
            reportIdsByCat[category] = rid;
            reports++;
          }

          // ── 生成 5 份 Word 报告（始终执行）───────────────────
          if (process.env.INSPECT_PYTHON_WORD !== '0') {
            const inspectMoment = new Date();
            const inspectTimeStr = inspectMoment.toLocaleString('zh-CN', { hour12: false });
            const p2 = (n) => String(n).padStart(2, '0');
            const fileTimestamp = `${inspectMoment.getFullYear()}${p2(inspectMoment.getMonth()+1)}` +
              `${p2(inspectMoment.getDate())}_${p2(inspectMoment.getHours())}` +
              `${p2(inspectMoment.getMinutes())}${p2(inspectMoment.getSeconds())}`;

            inspectLog(verboseLog, session,
              `db_inspection Python Word 生成开始 inst=${inst.INSTANCE_ID} dbType=${dbType}`);

            const pyWord = runDbInspectionPythonWord({
              dbType,
              instRow:        inst,
              mergedSqlText:  mergedFullSql,  // 模板文件优先级更高，此为备用
              taskId,
              inspectTimeStr,
              fileTimestamp,
            });

            if (!pyWord.ok) {
              inspectLog(verboseLog, session,
                `db_inspection Python Word 未生成: ${pyWord.error}`);
            } else {
              inspectLog(verboseLog, session,
                `db_inspection Python Word OK paths=${JSON.stringify(pyWord.files || {})}`);
              // 将 Word 文件路径写入对应 INSPECT_REPORT 的 PAYLOAD
              for (const cat of INSPECT_REPORT_TYPES) {
                await attachInspectDocxToPayload(reportIdsByCat[cat], pyWord.files?.[cat]);
              }
            }
          }
        } finally {
          if (oracleConn) await oracleConn.close().catch(() => {});
          if (mysqlConn)  await mysqlConn.end().catch(() => {});
          if (pgClient)   await pgClient.end().catch(() => {});
          inspectLog(verboseLog, session, `实例连接已关闭 id=${instId}`);
        }
      }

      await db.execute(`UPDATE INSPECT_TASK SET STATUS='DONE' WHERE TASK_ID=:1`, [taskId]);
      await automationLog(req, 'INSPECT', Number(taskId), 'RUN_TASK', 'SUCCESS', `reports=${reports}`);
      inspectLog(verboseLog, session, `全部完成 taskId=${taskId} reports=${reports}`);

      return {
        reports,
        instances: instanceIds.length,
        logs:       session?.logs       ?? [],
        sqlErrors:  session?.sqlErrors  ?? [],
        reportIds:  session?.reportIds  ?? [],
      };
    } catch (e) {
      inspectLog(verboseLog, session, `失败 taskId=${taskId}: ${e.message || e}`);
      attachInspectSession(e, session);
      await db.execute(`UPDATE INSPECT_TASK SET STATUS='FAILED' WHERE TASK_ID=:1`, [taskId]).catch(() => {});
      await automationLog(req, 'INSPECT', Number(taskId), 'RUN_TASK', 'FAILED',
        (e.message || String(e)).slice(0, 450));
      throw e;
    }
  } finally {
    runningInspectTasks.delete(taskId);
  }
}

module.exports = { runInspectTaskById, loadInspectScriptsByIds };
